/**
 * dsh-tavily-pool — Tavily-backed `web_search` for DeepSeek Harness.
 *
 * This file is the plugin entry the harness loads. It does three things and
 * delegates everything else:
 *
 * 1. registers the search provider, **first**, before anything else can fail
 *    (`PIN-5`, hard constraint 5);
 * 2. builds the host-facing collaborators (capability probe, state directory,
 *    key pool) inside a `try`/`catch`, so a failure past registration degrades
 *    to a half-working plugin rather than an outage;
 * 3. hands the provider a thunk that reads current state per search, so
 *    configuration changes take effect without re-registering anything.
 *
 * The all-important detail is `available()`. Because `cordis.patch.yml` pins
 * `searchProvider: tavily` statically, a provider reporting itself unavailable
 * would be a hard `WEB_PROVIDER_CONFIGURED_UNAVAILABLE` throw rather than a
 * fallback. Every real decision therefore lives inside `search()`.
 *
 * @module dsh-tavily-pool
 */

import z from '@deepseek-ai/schemastery';

import { KEYS_FILE_NAME, SEARCH_TIMEOUT_MS, SETTINGS_NAMESPACE } from './lib/constants.js';
import { PoolStore } from './lib/pool.js';
import { TavilyError } from './lib/tavily.js';
import { probeCapabilities, describeMissingCapabilities } from './lib/dsh/capabilities.js';
import { resolveStateDir } from './lib/dsh/home-path.js';
import { registerSearchProvider } from './lib/dsh/register.js';
import { TavilySearchProvider } from './lib/dsh/search-provider.js';

/** Cordis plugin name, used by loader diagnostics. */
export const name = 'tavily-pool';

/**
 * The seam this plugin registers into.
 *
 * Declared as a dependency because the `web` row's configuration is part of the
 * profile patch: changing it rebuilds the service instance and clears the
 * provider registry, and only this declaration makes the harness re-run
 * `apply()` to repopulate it. Without it the provider vanishes silently.
 */
export const inject = ['web'];

/**
 * Composition config for this plugin's row.
 *
 * Empty because every user-facing setting lives in the `dsh-tavily-pool`
 * settings namespace, where changes take effect live and appear in the panel.
 * It is still declared, and still non-null: a row's `config` is validated
 * against this schema before `apply()` runs, so a malformed value (a string
 * where an object belongs) fails at load with the loader's own diagnostic
 * rather than being handed to `apply()` unexamined.
 */
export const Config = z.object({});

/**
 * Mutable runtime state shared with the settings and panel surfaces that later
 * issues add.
 *
 * @typedef {object} PluginState
 * @property {import('./lib/dsh/capabilities.js').CapabilityReport|undefined} capabilityReport
 * @property {PoolStore|undefined} pool
 * @property {Promise<void>|undefined} poolLoad
 * @property {Error|undefined} initError
 */

/**
 * Register the Tavily search provider with the host.
 *
 * @param ctx - plugin context.
 * @param _config - validated composition config; unused today.
 */
export function apply(ctx, _config) {
  /** @type {PluginState} */
  const state = { capabilityReport: undefined, pool: undefined, poolLoad: undefined, initError: undefined };

  // The first effectful statement, deliberately (hard constraint 5): the
  // profile patch pins searchProvider to this plugin, so a plugin that loads
  // without registering makes every search throw
  // WEB_PROVIDER_CONFIGURED_MISSING. Building the provider and the state holder
  // above cannot fail; everything that can fail is below.
  registerSearchProvider(ctx, new TavilySearchProvider((signal) => resolveSearchOptions(state, signal)));

  // Everything below is non-critical: if it throws, search still works with
  // whatever state exists, and the failure is recorded for the panel.
  //
  // The probe is deliberately outside this `try`: it cannot throw (it reads
  // through `ctx.get`, which returns `undefined` rather than raising), and
  // folding it in would let an unrelated initialization fault masquerade as a
  // capability finding. Only real initialization is guarded here.
  state.capabilityReport = probeCapabilities({ ctx });
  try {
    state.pool = new PoolStore({ dir: resolveStateDir(ctx), fileName: KEYS_FILE_NAME });
  } catch (error) {
    state.initError = error;
    report(ctx, 'warn', `dsh-tavily-pool: initialization failed, continuing with search registered: ${String(error)}`);
  }

  // Reported whenever anything is missing, not only when a required capability
  // is: an optional loss is exactly the kind of quiet degradation that is
  // otherwise discovered much later, from the symptom. Emitted after the pool
  // is built so one log line reports the whole state.
  report(ctx, 'warn', describeMissingCapabilities(state.capabilityReport));
}

/**
 * Log through the host's logger service, tolerating its absence.
 *
 * `ctx.logger` is an own property of every context (`LoggerService` is
 * constructed onto it), *not* a provided service — so the reflective
 * `ctx.get('logger')` returns `undefined` and would silently discard every
 * message. Reading the property is safe: the context proxy only raises for
 * names it cannot resolve at all, and this one is always present.
 *
 * A missing or hostile logger must never be the reason the plugin fails to
 * load, so the whole call stays inside a `try` that cannot propagate.
 *
 * @param ctx - plugin context.
 * @param level - logger method to call.
 * @param message - the message; an empty string is not logged.
 */
function report(ctx, level, message) {
  if (typeof message !== 'string' || message.length === 0) return;
  try {
    const logger = ctx.logger;
    const write = logger?.[level];
    if (typeof write === 'function') write.call(logger, message);
  } catch {
    // Logging is best-effort by definition; never let it break initialization.
  }
}

/**
 * Resolve everything one search needs, at the moment it runs.
 *
 * Two separate reasons this is per-call rather than captured at load: the key
 * pool changes as the user edits it, and a thunk is what lets the panel's edits
 * apply to the very next search without re-registering the provider.
 *
 * The pool load is memoized but retried after a rejection, so a transient
 * filesystem failure does not doom every later search for the process's life.
 *
 * @param state - plugin runtime state.
 * @param signal - caller cancellation.
 * @returns `{ apiKey, params, fetchImpl, timeoutMs }`.
 * @throws {TavilyError} when the plugin cannot search at all.
 */
async function resolveSearchOptions(state, signal) {
  if (signal?.aborted === true) {
    throw new TavilyError('Tavily search aborted by the caller', { code: 'TAVILY_ABORTED', retryable: false });
  }
  if (state.initError !== undefined) {
    throw new TavilyError(
      `dsh-tavily-pool failed to initialize and has no key pool: ${String(state.initError)}`,
      { code: 'TAVILY_NOT_INITIALIZED', retryable: false, cause: state.initError },
    );
  }
  if (state.pool === undefined) {
    throw new TavilyError('dsh-tavily-pool has no key pool; the plugin did not finish loading', {
      code: 'TAVILY_NOT_INITIALIZED',
      retryable: false,
    });
  }

  state.poolLoad ??= state.pool.load().catch((error) => {
    // Drop the failed promise so the next search retries the read.
    state.poolLoad = undefined;
    throw error;
  });
  await state.poolLoad;

  const apiKey = state.pool.firstUsableKey();
  if (apiKey === undefined) {
    throw new TavilyError(
      state.pool.loadError === undefined
        ? `no Tavily key is configured; add one in Settings → Plugins → ${SETTINGS_NAMESPACE}`
        : `the key pool could not be read (${state.pool.loadError.message}); fix or remove ${state.pool.filePath} `
          + `and add a key in Settings → Plugins → ${SETTINGS_NAMESPACE}`,
      { code: 'TAVILY_NO_USABLE_KEY', retryable: false },
    );
  }

  return {
    apiKey,
    // Search parameters are configured in a later issue; sending none leaves
    // Tavily's own defaults in place rather than inventing values here.
    params: {},
    fetchImpl: globalThis.fetch,
    timeoutMs: SEARCH_TIMEOUT_MS,
  };
}

/**
 * The plugin entry, exercised through a stand-in host.
 *
 * The two rules that decide whether the takeover works at all live here:
 * registration must happen before anything that can fail, and `available()`
 * must never return false.
 */

import assert from 'node:assert/strict';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { describe } from 'node:test';

import { apply, inject, name } from '../index.js';
import { KEYS_FILE_NAME, PROVIDER_ID, STATE_DIR_NAME } from '../lib/constants.js';
import { MissingHostCapabilityError } from '../lib/dsh/register.js';

/**
 * A stand-in host context good enough to load the plugin.
 *
 * It mimics the two things the real context does that the plugin depends on:
 * services are read through `get(name)` (the reflective read, which returns
 * `undefined` for an absent service), and `ctx.logger` is an **own property**
 * of the context rather than a provided service — the real host constructs a
 * `LoggerService` onto every context, so `ctx.get('logger')` is `undefined`
 * while `ctx.logger.warn` exists. Getting that wrong is how probe output ends
 * up silently discarded.
 *
 * `harnessHome` is what the host reports as the harness home; the plugin
 * appends its own state directory name to it, exactly as the real resolver
 * does, so a test can place a file where the plugin will actually look.
 *
 * @param options - host shape overrides.
 * @param options.harnessHome - harness home reported by `ctx.dshHomePath`.
 * @param options.omitRegistration - remove the seam's registration function.
 * @returns `{ ctx, registered, warnings, registerCalls }`.
 */
function fakeHost({ harnessHome, omitRegistration = false } = {}) {
  const registered = [];
  const warnings = [];
  let registerCalls = 0;

  const services = {
    web: {
      registerSearchProvider(provider) {
        registerCalls += 1;
        registered.push(provider);
        return () => undefined;
      },
      registerFetchProvider() {
        return () => undefined;
      },
    },
    settings: { register: () => ({ get: () => ({}), watch: () => () => {} }) },
    clientModules: {},
    connection: { fetch: { register: () => async () => {} } },
    dshHomePath: (...segments) => join(harnessHome ?? '/nonexistent-home/.dsh', ...segments),
  };
  if (omitRegistration) delete services.web.registerSearchProvider;

  const ctx = {
    get: (name) => services[name],
    services,
    // Own property, not a service — deliberately absent from `services`.
    logger: { warn: (message) => warnings.push(String(message)) },
  };

  return { ctx, registered, warnings, registerCalls: () => registerCalls };
}

/**
 * A temporary harness home plus a pool file the plugin will find.
 *
 * @param contents - the pool file's contents, when one should exist.
 * @returns the harness home path.
 */
async function temporaryHarnessHome(contents) {
  const home = await mkdtemp(join(tmpdir(), 'dsh-tavily-pool-entry-'));
  const stateDir = join(home, STATE_DIR_NAME);
  if (contents !== undefined) {
    await mkdir(stateDir, { recursive: true });
    await writeFile(join(stateDir, KEYS_FILE_NAME), contents, 'utf8');
  }
  return home;
}

describe('plugin shape', () => {
  test('declares the web dependency so a service rebuild re-registers it', () => {
    assert.deepEqual(inject, ['web']);
    assert.equal(name, 'tavily-pool');
  });
});

describe('PIN-5 / hard constraint 5: registration happens first', () => {
  test('the provider is registered under the id the profile patch pins', () => {
    const host = fakeHost();
    apply(host.ctx, {});

    assert.equal(host.registered.length, 1);
    assert.equal(host.registered[0].id, PROVIDER_ID);
    assert.equal(PROVIDER_ID, 'tavily');
  });

  test('a failure after registration still leaves the provider registered', () => {
    const host = fakeHost();
    // Break a later initialization step in a way the plugin cannot swallow:
    // the state directory cannot be resolved, so `apply()` takes its catch.
    host.ctx.services.dshHomePath = () => {
      throw new Error('simulated host failure');
    };
    delete process.env.DSH_HOME;
    const previousHome = process.env.HOME;
    process.env.HOME = '';

    try {
      apply(host.ctx, {});
    } finally {
      process.env.HOME = previousHome;
    }

    assert.equal(host.registered.length, 1, 'the provider must survive a broken initialization');
    assert.equal(host.registered[0].available(), true);
    assert.match(host.warnings.join('\n'), /initialization failed/u, 'and the failure must be reported');
  });

  test('a broken logger never becomes the reason search fails', () => {
    const host = fakeHost();
    // A logger whose methods throw must not propagate out of apply(): logging is
    // best-effort, and this runs after the provider is already registered.
    host.ctx.logger = {
      warn() {
        throw new Error('simulated logger failure');
      },
    };
    assert.doesNotThrow(() => {
      apply(host.ctx, {});
    });
    assert.equal(host.registered.length, 1);
  });

  test('a degraded host is reported at load time, naming what is missing', () => {
    const host = fakeHost();
    // Remove an optional capability: the probe must still succeed, and the
    // finding must reach the log rather than being silently swallowed.
    delete host.ctx.services.dshHomePath;
    apply(host.ctx, {});

    assert.equal(host.registered.length, 1, 'a degraded host must not stop registration');
    const reported = host.warnings.join('\n');
    assert.match(reported, /dshHomePath/u);
    assert.match(reported, /docs\/dsh-upgrade\.md/u);
  });
});

describe('COMPAT-2: a reshaped seam fails loudly at load time', () => {
  test('a missing registration function is named exactly', () => {
    const host = fakeHost({ omitRegistration: true });
    const error = (() => {
      try {
        apply(host.ctx, {});
        return undefined;
      } catch (thrown) {
        return thrown;
      }
    })();
    assert.ok(error instanceof MissingHostCapabilityError, 'the seam must fail with a named error, not a TypeError');
    assert.equal(error.path, 'ctx.web.registerSearchProvider');
    assert.match(error.message, /ctx\.web\.registerSearchProvider/u);
    assert.match(error.message, /docs\/dsh-upgrade\.md/u);
  });
});

describe('PIN-2 / hard constraint 1: available() is always true', () => {
  test('a provider with no keys still reports itself available', () => {
    const host = fakeHost({ harnessHome: '/nonexistent-home' });
    apply(host.ctx, {});
    assert.equal(host.registered[0].available(), true);
  });

  test('a provider whose pool file is damaged still reports itself available', async () => {
    const home = await temporaryHarnessHome('not json at all');
    const host = fakeHost({ harnessHome: home });
    apply(host.ctx, {});

    await host.registered[0].search({ query: 'anything' }).catch(() => undefined);
    assert.equal(
      host.registered[0].available(),
      true,
      'a pinned provider reporting unavailable is a hard throw, not a fallback',
    );
  });
});

describe('search failures are reported with an actionable code', () => {
  test('an empty pool tells the user where to add a key', async () => {
    const host = fakeHost({ harnessHome: await temporaryHarnessHome() });
    apply(host.ctx, {});

    const error = await host.registered[0].search({ query: 'q' }).catch((thrown) => thrown);
    assert.equal(error.code, 'TAVILY_NO_USABLE_KEY');
    assert.match(error.message, /no Tavily key is configured/u);
    assert.match(error.message, /dsh-tavily-pool/u);
  });

  test('a damaged pool file is reported by path, not as an empty pool', async () => {
    const host = fakeHost({ harnessHome: await temporaryHarnessHome('not json at all') });
    apply(host.ctx, {});

    const error = await host.registered[0].search({ query: 'q' }).catch((thrown) => thrown);
    assert.equal(error.code, 'TAVILY_NO_USABLE_KEY');
    assert.match(error.message, /could not be read/u);
    assert.match(error.message, /keys\.json/u);
  });
});

describe('the module is importable without loading a harness service', () => {
  test('apply() is a function and the row can carry an empty config', () => {
    assert.equal(typeof apply, 'function');
    assert.equal(apply.length >= 1, true);
  });
});

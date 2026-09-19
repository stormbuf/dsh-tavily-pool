/**
 * Capability-checked provider registration.
 *
 * Registration is the one step that must happen before anything else can fail
 * (`PIN-5`): if it runs first, every later initialization can be wrapped in a
 * `try`/`catch` and the plugin degrades to "half broken but search still works"
 * instead of taking search down with it.
 *
 * The check lives here rather than inside the provider so that a reshaped seam
 * fails loudly at load time, naming the exact member that is gone (`COMPAT-2`),
 * instead of surfacing as a confusing `TypeError` from a call site.
 *
 * @module dsh-tavily-pool/dsh/register
 */

import { readService } from './read-service.js';

/**
 * The host member this plugin contributes its search provider through.
 *
 * Named as a path so the diagnostic can quote it verbatim.
 */
export const SEARCH_REGISTRATION_PATH = 'ctx.web.registerSearchProvider';

/**
 * Thrown when a capability the plugin cannot work around is absent.
 *
 * Carries the missing path on the error object so a caller (or a future panel)
 * can act on it without parsing the message.
 */
export class MissingHostCapabilityError extends Error {
  /**
   * @param path - the missing member, as a dotted path.
   * @param remedy - where to look when re-adapting to a new host version.
   */
  constructor(path, remedy) {
    super(
      `dsh-tavily-pool: the host is missing ${path}, so this plugin cannot register its `
      + 'search provider. DeepSeek Harness is in preview and its plugin interfaces change '
      + `between releases; see docs/dsh-upgrade.md. Expected: ${remedy}`,
    );
    this.name = 'MissingHostCapabilityError';
    this.path = path;
    this.remedy = remedy;
  }
}

/**
 * Register the search provider, refusing with a specific error when the seam is
 * gone.
 *
 * MUST be the first statement of `apply()`: the profile patch pins
 * `searchProvider` to this plugin's id, so a plugin that loads without
 * registering leaves the host throwing `WEB_PROVIDER_CONFIGURED_MISSING` for
 * every search. Registering first makes that outcome require the seam itself to
 * be broken, which is the one case where nothing could have helped.
 *
 * @param ctx - plugin context.
 * @param provider - the search provider to register.
 * @returns the host's disposer for the registration.
 * @throws {MissingHostCapabilityError} when the seam is absent or reshaped.
 */
export function registerSearchProvider(ctx, provider) {
  const web = readService(ctx, 'web');
  const register = web?.registerSearchProvider;
  if (typeof register !== 'function') {
    throw new MissingHostCapabilityError(
      SEARCH_REGISTRATION_PATH,
      'ctx.web.registerSearchProvider(provider) in @deepseek-ai/dsh-web — the only supported '
      + 'way to contribute a search provider.',
    );
  }
  return register.call(web, provider);
}

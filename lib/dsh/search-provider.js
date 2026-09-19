/**
 * The one place that knows what the host's web seam looks like.
 *
 * `lib/tavily.js` speaks Tavily; the seam speaks `WebSearchRequest` /
 * `WebSearchResult`. This module is the translation between them, and the only
 * file in the search path that imports the host's error class, so failures
 * arrive as the `WebError` the harness expects while the core stays host-free
 * (`COMPAT-1`).
 *
 * @module dsh-tavily-pool/dsh/search-provider
 */

import { WebError } from '@deepseek-ai/dsh-web';

import { PROVIDER_ID } from '../constants.js';
import { searchTavily, TavilyError } from '../tavily.js';

/**
 * Re-throw a core failure as the host's `WebError`, preserving the machine
 * code, the upstream status, and the `request_id`.
 *
 * The code is what the harness routes on — `dsh-tools` reports `{ name, code }`
 * as structured metadata — so it must survive the crossing intact. Aborts are
 * deliberately *not* converted: a caller's cancellation is not a web failure,
 * and rewriting it would make a cancelled tool call look like a broken
 * provider.
 *
 * @param error - the thrown value.
 * @returns never; always throws.
 */
export function rethrowAsWebError(error) {
  if (error instanceof TavilyError) {
    // Cancellation keeps the seam's own spelling: the harness distinguishes a
    // cancelled tool call from a provider failure by this code, and rewriting
    // it would make an interrupt look like an outage.
    const code = error.code === 'TAVILY_ABORTED' ? 'WEB_ABORTED' : error.code;
    throw new WebError(error.message, code, error.cause === undefined ? undefined : { cause: error.cause });
  }
  throw error;
}

/**
 * The Tavily search provider.
 *
 * `available()` always returns `true`, which is a hard requirement rather than
 * an oversight: the profile patch pins `searchProvider: tavily`, and a pinned
 * provider that reports itself unavailable is a hard
 * `WEB_PROVIDER_CONFIGURED_UNAVAILABLE` throw, not a fallback. Every real
 * decision — the toggle, whether the pool has a usable key — therefore happens
 * inside `search()`.
 */
export class TavilySearchProvider {
  #resolveOptions;

  /**
   * @param resolveOptions - reads the current settings and key pool at the
   *   start of each search. A thunk rather than a value because settings change
   *   while the plugin stays registered, and re-registering the provider to
   *   carry a new value would surface to the user as a flickering provider.
   */
  constructor(resolveOptions) {
    this.#resolveOptions = resolveOptions;
    this.id = PROVIDER_ID;
  }

  /**
   * Cheap local usability check; the seam calls this without a network.
   *
   * @returns always `true`; see the class comment for why.
   */
  available() {
    return true;
  }

  /**
   * Run one search through Tavily.
   *
   * @param request - the seam's request.
   * @param signal - caller cancellation.
   * @returns the seam's normalized result.
   * @throws {WebError} on failure.
   */
  async search(request, signal) {
    try {
      const options = await this.#resolveOptions(signal);
      const { result } = await searchTavily({
        apiKey: options.apiKey,
        query: request.query,
        maxResults: request.maxResults,
        params: options.params,
        signal,
        fetchImpl: options.fetchImpl,
        timeoutMs: options.timeoutMs,
      });
      return result;
    } catch (error) {
      rethrowAsWebError(error);
    }
  }
}

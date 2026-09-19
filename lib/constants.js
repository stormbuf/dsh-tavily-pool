/**
 * Fixed vocabulary shared by every module: ids, endpoints, defaults.
 *
 * Host-free by construction (`COMPAT-1`): nothing here imports `@deepseek-ai/*`,
 * so the whole file is testable under `node:test`.
 *
 * Only values something actually reads live here. Constants for a capability
 * land with the code that uses them, so this file stays a list of facts about
 * the running plugin rather than a plan.
 *
 * @module dsh-tavily-pool/constants
 */

/**
 * Provider id this plugin registers under. The same string serves both the
 * search and the fetch registry, because the seam keeps them separate
 * (`registerSearchProvider` / `registerFetchProvider`) and the profile patch
 * pins both fields to it.
 */
export const PROVIDER_ID = 'tavily';

/** Tavily REST endpoint for search. */
export const TAVILY_SEARCH_URL = 'https://api.tavily.com/search';

/**
 * Directory name under the harness home holding this plugin's state.
 * Resolved through the host path helper — never hardcoded (`DOC-4`).
 */
export const STATE_DIR_NAME = 'dsh-tavily-pool';

/** Key-pool file name inside {@link STATE_DIR_NAME}. */
export const KEYS_FILE_NAME = 'keys.json';

/**
 * Settings namespace; must equal the client card's slot `key`. The two are
 * paired by string equality, and the namespace cannot be registered twice.
 */
export const SETTINGS_NAMESPACE = 'dsh-tavily-pool';

/**
 * Request timeout for `/search`, in milliseconds.
 *
 * The host gives a whole `web_search` call a 60s budget, and a later ticket
 * spends part of it on bounded waiting plus failover across keys. A
 * per-attempt timeout well under that budget is what keeps the total bounded.
 */
export const SEARCH_TIMEOUT_MS = 20_000;

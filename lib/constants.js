/**
 * Fixed vocabulary shared by every module: provider ids, endpoints, defaults.
 *
 * Host-free by construction (`COMPAT-1`): nothing here imports `@deepseek-ai/*`,
 * so the whole file is testable under `node:test`.
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

/** Tavily REST endpoint for search (`REST-1`). */
export const TAVILY_SEARCH_URL = 'https://api.tavily.com/search';

/**
 * Directory name under the harness home holding this plugin's state
 * (`POOL-1`). Resolved through the host path helper — never hardcoded
 * (`DOC-4`).
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
 * Settings namespace owned by the official DeepSeek search plugin. Read-only
 * for us: that plugin registers it, the namespace cannot be registered twice,
 * and it must stay enabled or the fallback target loses its endpoint and key.
 */
export const OFFICIAL_SEARCH_NAMESPACE = 'web-search-deepseek';

/** Environment variable naming the official search endpoint. */
export const OFFICIAL_SEARCH_BASE_URL_ENV = 'DEEPSEEK_SEARCH_BASE_URL';

/** Default API-key environment reference for the official search provider. */
export const OFFICIAL_SEARCH_API_KEY_ENV = 'DEEPSEEK_API_KEY';

/** Official search endpoint used when neither settings nor environment state one. */
export const OFFICIAL_SEARCH_DEFAULT_BASE_URL = 'https://api.deepseek.com/anthropic/v1';

/** `web_search` server-tool uses the official provider allows per request. */
export const OFFICIAL_SEARCH_DEFAULT_MAX_USES = 5;

/** Generated-token cap for the official provider's Messages request. */
export const OFFICIAL_SEARCH_DEFAULT_MAX_TOKENS = 4096;

/** Anthropic-compatible API version header the official provider sends. */
export const OFFICIAL_SEARCH_DEFAULT_API_VERSION = '2023-06-01';

/** Model name the official provider falls back to. */
export const OFFICIAL_SEARCH_DEFAULT_MODEL = 'deepseek-v4-flash';

/**
 * Request timeout for `/search`, in milliseconds.
 *
 * The host gives a whole `web_search` call a 60s budget, and a later ticket
 * spends part of it on bounded waiting plus failover across keys. A
 * per-attempt timeout well under that budget is what keeps the total bounded.
 */
export const SEARCH_TIMEOUT_MS = 20_000;

/** Tavily's `/search` bounds for `max_results`. */
export const MAX_RESULTS_MIN = 0;
export const MAX_RESULTS_MAX = 20;

/** HTTP status Tavily uses for a malformed request. */
export const HTTP_BAD_REQUEST = 400;

/** HTTP status Tavily uses for a bad or missing key. */
export const HTTP_UNAUTHORIZED = 401;

/** HTTP status Tavily uses for rate limiting. */
export const HTTP_TOO_MANY_REQUESTS = 429;

/**
 * HTTP status meaning "key or plan limit exceeded". Handled in a later ticket;
 * named here so the status table has one spelling.
 */
export const HTTP_KEY_OR_PLAN_LIMIT = 432;

/** HTTP status meaning "pay-as-you-go limit exceeded". */
export const HTTP_PAYGO_LIMIT = 433;

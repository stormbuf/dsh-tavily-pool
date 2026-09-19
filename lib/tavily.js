/**
 * Tavily REST client — the call kernel.
 *
 * Host-free (`COMPAT-1`): no `@deepseek-ai/*` import. `fetch` is an injected
 * dependency, so every path is exercisable under `node:test` with a stub.
 *
 * This module owns exactly three things: how a Tavily request is shaped, how a
 * Tavily response is interpreted, and what a Tavily failure means. It owns no
 * key selection, no scheduling, and no recovery policy.
 *
 * @module dsh-tavily-pool/tavily
 */

import { SEARCH_TIMEOUT_MS, TAVILY_SEARCH_URL } from './constants.js';

/**
 * One Tavily call failure, carrying the machine `code` the harness reports and
 * the upstream `status` it came from.
 *
 * Host-free on purpose. The `lib/dsh/` adapter re-throws these as the host's
 * `WebError` with the same `code`, so the harness reports structured metadata
 * while this module stays importable without a harness.
 *
 * It carries what was observed, not what should happen next: which statuses
 * mean "cool down", "quota exhausted", or "isolate this key" is failure
 * classification, and encoding any of it here would put the same knowledge in
 * two places.
 */
export class TavilyError extends Error {
  /**
   * @param message - human-readable failure, safe to show a model.
   * @param options - the observed facts.
   * @param options.code - stable machine code.
   * @param options.status - upstream HTTP status, when a response arrived.
   * @param options.cause - the underlying error, when there was one.
   */
  constructor(message, options = {}) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = 'TavilyError';
    this.code = options.code ?? 'TAVILY_ERROR';
    if (options.status !== undefined) this.status = options.status;
  }
}

/**
 * Whether a thrown value is an abort rather than a failure.
 *
 * @param error - the thrown value.
 * @returns true for an `Error` named `AbortError` or `TimeoutError`.
 */
export function isAbortError(error) {
  return error instanceof Error && (error.name === 'AbortError' || error.name === 'TimeoutError');
}

/** Tavily's error envelope is `{ detail: { error } }`; tolerate the variants. */
export function detailOf(parsed) {
  if (parsed === null || typeof parsed !== 'object') return undefined;
  const detail = parsed.detail;
  if (typeof detail === 'string') return detail;
  if (detail !== null && typeof detail === 'object' && typeof detail.error === 'string') return detail.error;
  return typeof parsed.error === 'string' ? parsed.error : undefined;
}

/**
 * Map a Tavily `/search` response onto the seam's `WebSearchResult` shape.
 *
 * Pure, so the mapping is testable without a network. `truncated` is always
 * `false`: the seam enforces `maxResults` itself and sets that flag when it
 * cuts the list, so a provider that also truncated would make the two
 * indistinguishable.
 *
 * @param parsed - decoded `/search` response.
 * @returns `{ content?, sources, truncated }`.
 */
export function mapSearchResponse(parsed) {
  const results = Array.isArray(parsed?.results) ? parsed.results : [];
  const sources = [];
  for (const item of results) {
    if (item === null || typeof item !== 'object') continue;
    if (typeof item.url !== 'string' || item.url.length === 0) continue;
    sources.push({
      url: item.url,
      ...typeof item.title === 'string' && item.title.length > 0 ? { title: item.title } : {},
      ...typeof item.content === 'string' && item.content.length > 0 ? { snippet: item.content } : {},
      ...typeof item.published_date === 'string' && item.published_date.length > 0
        ? { publishedAt: item.published_date }
        : {},
    });
  }
  const answer = typeof parsed?.answer === 'string' && parsed.answer.length > 0 ? parsed.answer : undefined;
  return {
    ...answer === undefined ? {} : { content: answer },
    sources,
    truncated: false,
  };
}

/**
 * Run one Tavily search (`REST-1`, `REST-2`, `REST-9`).
 *
 * `include_usage` is always sent: without it Tavily may omit `usage.credits`
 * entirely, and accounting would degrade to guessing.
 *
 * Cancellation and timeout are combined into one signal but stay
 * distinguishable in the thrown error, because they mean different things to
 * the caller: an aborted request must propagate as an abort, while a timeout is
 * a key-level failure worth another attempt.
 *
 * @param options - the search.
 * @param options.apiKey - key to authenticate with.
 * @param options.query - search query.
 * @param options.maxResults - provider-side result cap, when known.
 * @param options.params - search parameters; the settings schema validates
 *   them, so this function only forwards what it is given.
 * @param options.signal - caller cancellation.
 * @param options.fetchImpl - `fetch` implementation.
 * @param options.timeoutMs - per-attempt timeout.
 * @returns the seam's normalized search result.
 * @throws {TavilyError} on failure.
 */
export async function searchTavily({
  apiKey,
  query,
  maxResults,
  params = {},
  signal,
  fetchImpl,
  timeoutMs = SEARCH_TIMEOUT_MS,
}) {
  const timeout = AbortSignal.timeout(timeoutMs);
  const combined = signal === undefined ? timeout : AbortSignal.any([signal, timeout]);

  const body = {
    query,
    ...params.searchDepth === undefined ? {} : { search_depth: params.searchDepth },
    ...params.topic === undefined ? {} : { topic: params.topic },
    ...params.includeAnswer === undefined ? {} : { include_answer: params.includeAnswer },
    ...Number.isInteger(maxResults) ? { max_results: maxResults } : {},
    include_usage: true,
  };

  let response;
  try {
    response = await fetchImpl(TAVILY_SEARCH_URL, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${apiKey}`,
        accept: 'application/json',
        'content-type': 'application/json',
      },
      body: JSON.stringify(body),
      signal: combined,
    });
  } catch (error) {
    if (signal?.aborted === true) {
      throw new TavilyError('Tavily search aborted by the caller', {
        code: 'TAVILY_ABORTED',
        cause: error,
      });
    }
    if (isAbortError(error)) {
      throw new TavilyError(`Tavily search timed out after ${String(timeoutMs)}ms`, {
        code: 'TAVILY_TIMEOUT',
        cause: error,
      });
    }
    throw new TavilyError(`Tavily search request failed: ${String(error)}`, {
      code: 'TAVILY_NETWORK_ERROR',
      cause: error,
    });
  }

  const bodyText = await response.text();
  const parsed = parseJson(bodyText);

  if (!response.ok) {
    const detail = detailOf(parsed) ?? bodyText.slice(0, 300);
    throw new TavilyError(`Tavily returned HTTP ${String(response.status)}: ${detail}`, {
      code: `TAVILY_HTTP_${String(response.status)}`,
      status: response.status,
    });
  }
  if (parsed === undefined) {
    throw new TavilyError('Tavily returned a body that is not JSON', {
      code: 'TAVILY_UNPROCESSABLE_RESPONSE',
      status: response.status,
    });
  }

  return mapSearchResponse(parsed);
}

/** Decode a JSON body, returning `undefined` instead of throwing. */
function parseJson(text) {
  if (typeof text !== 'string' || text.length === 0) return undefined;
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

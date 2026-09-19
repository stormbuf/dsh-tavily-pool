/**
 * Tavily REST 客户端——调用内核。
 *
 * 与宿主零耦合（`COMPAT-1`）：不 import 任何 `@deepseek-ai/*`。`fetch` 是注入的
 * 依赖，因此每条路径都能在 `node:test` 下用桩件覆盖。
 *
 * 本模块只负责三件事：Tavily 请求怎么构造、Tavily 响应怎么解释、Tavily 失败
 * 意味着什么。它不负责密钥选择、不负责调度、不负责恢复策略。
 *
 * @module dsh-tavily-pool/tavily
 */

import { SEARCH_TIMEOUT_MS, TAVILY_SEARCH_URL } from './constants.js';

/**
 * 一次 Tavily 调用失败，携带 harness 上报的机器码 `code` 与来源 `status`。
 *
 * 刻意与宿主零耦合。`lib/dsh/` 适配层会用同一个 `code` 把它重新抛成宿主的
 * `WebError`，于是 harness 能上报结构化元数据，而本模块仍可脱离 harness 导入。
 *
 * 它携带的是**观测到的事实**，不是**接下来该怎么做**：哪些状态码意味着「冷却」、
 * 「额度耗尽」或「隔离该密钥」属于失败分类，任何一条写在这里都会让同一份知识
 * 出现两处。
 */
export class TavilyError extends Error {
  /**
   * @param message - 人类可读的失败说明，可安全展示给模型。
   * @param options - 观测到的事实。
   * @param options.code - 稳定的机器码。
   * @param options.status - 上游 HTTP 状态码，仅在有响应时给出。
   * @param options.detail - 上游错误文本，已从 `{detail:{error}}` 信封里取出。
   * @param options.retryAfter - 响应头 `Retry-After` 的原始值，仅 `429` 会带。
   * @param options.requestId - 上游的 `request_id`，排障时用它向 Tavily 支持追问。
   * @param options.cause - 底层错误，若有。
   */
  constructor(message, options = {}) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = 'TavilyError';
    this.code = options.code ?? 'TAVILY_ERROR';
    if (options.status !== undefined) this.status = options.status;
    // 上游文本与 `Retry-After` 原值都原样携带、不在这里解释：分类（哪些状态码意味着
    // 冷却、哪些措辞意味着永久失效）是 `lib/health.js` 的事，同一份知识只应存在一处。
    if (options.detail !== undefined) this.detail = options.detail;
    if (options.retryAfter !== undefined) this.retryAfter = options.retryAfter;
    if (options.requestId !== undefined) this.requestId = options.requestId;
  }
}

/**
 * 判断抛出值是否为「取消」而非「失败」。
 *
 * @param error - 抛出的值。
 * @returns 对名为 `AbortError` 或 `TimeoutError` 的 `Error` 返回 true。
 */
export function isAbortError(error) {
  return error instanceof Error && (error.name === 'AbortError' || error.name === 'TimeoutError');
}

/** Tavily 的错误信封是 `{ detail: { error } }`；这里兼容几种变体。 */
export function detailOf(parsed) {
  if (parsed === null || typeof parsed !== 'object') return undefined;
  const detail = parsed.detail;
  if (typeof detail === 'string') return detail;
  if (detail !== null && typeof detail === 'object' && typeof detail.error === 'string') return detail.error;
  return typeof parsed.error === 'string' ? parsed.error : undefined;
}

/**
 * 把 Tavily `/search` 响应映射为 seam 的 `WebSearchResult` 形状。
 *
 * 纯函数，因此无需网络即可测试该映射。`truncated` 恒为 `false`：`maxResults`
 * 由 seam 自己执行并在截断时置位，提供方若也截断，两者就无法区分了。
 *
 * @param parsed - 解码后的 `/search` 响应。
 * @returns `{ content?, sources, truncated }`。
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
 * 执行一次 Tavily 搜索（`REST-1`、`REST-2`、`REST-9`）。
 *
 * 固定发送 `include_usage`：不发的话 Tavily 可能完全省略 `usage.credits`，
 * 记账就只能靠猜。
 *
 * 取消与超时被合并进同一个 signal，但在抛出的错误里保持可区分，因为二者对调用方
 * 含义不同：被调用方取消的请求必须按取消向上传递，而超时属于密钥层面的失败，
 * 值得再试一次。
 *
 * @param options - 本次搜索。
 * @param options.apiKey - 用于认证的密钥。
 * @param options.query - 搜索词。
 * @param options.maxResults - 提供方侧的结果上限，已知时给出。
 * @param options.params - 搜索参数；由 settings schema 负责校验，本函数只转发收到的值。
 * @param options.signal - 调用方取消信号。
 * @param options.fetchImpl - `fetch` 实现。
 * @param options.timeoutMs - 单次尝试的超时。
 * @returns `{ result, credits, requestId }`：seam 归一化后的结果、上游回传的积分
 *   消耗（缺失时为 `undefined`）、上游的 `request_id`。
 * @throws {TavilyError} 失败时抛出。
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
  const requestId = typeof parsed?.request_id === 'string' ? parsed.request_id : undefined;

  if (!response.ok) {
    const detail = detailOf(parsed) ?? bodyText.slice(0, 300);
    throw new TavilyError(
      // `request_id` 是官方「排障时提供给支持」的那个标识，因此只要上游给了就带上
      // （`REST-10`）：错误路径是最需要它的地方，成功路径反而不需要。
      `Tavily returned HTTP ${String(response.status)}: ${detail}`
      + (requestId === undefined ? '' : ` (request_id: ${requestId})`),
      {
        code: `TAVILY_HTTP_${String(response.status)}`,
        status: response.status,
        detail,
        requestId,
        // 原样搬运，不在这里解析：冷却时长怎么算属于 `lib/health.js`。
        retryAfter: response.headers.get('retry-after') ?? undefined,
      },
    );
  }
  if (parsed === undefined) {
    throw new TavilyError('Tavily returned a body that is not JSON', {
      code: 'TAVILY_UNPROCESSABLE_RESPONSE',
      status: response.status,
    });
  }

  return {
    result: mapSearchResponse(parsed),
    // `include_usage: true` 就是为了这两项。`credits` 缺失时是 `undefined` 而不是
    // 0——「不知道消耗了多少」与「本次没消耗」必须区分得开（`REST-3`）。
    credits: typeof parsed.usage?.credits === 'number' && Number.isFinite(parsed.usage.credits)
      ? parsed.usage.credits
      : undefined,
    requestId,
  };
}

/** 解码 JSON 响应体，失败时返回 `undefined` 而不抛错。 */
function parseJson(text) {
  if (typeof text !== 'string' || text.length === 0) return undefined;
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

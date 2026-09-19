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

import {
  ADVANCED_EXTRACT_CREDITS_PER_FIVE,
  BASIC_EXTRACT_CREDITS_PER_FIVE,
  EXTRACT_FAILURE_STATUS,
  EXTRACT_URLS_PER_CREDIT_TIER,
  TAVILY_EXTRACT_URL,
  TAVILY_SEARCH_URL,
  TAVILY_TIMEOUT_MS,
} from './constants.js';

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
  timeoutMs = TAVILY_TIMEOUT_MS,
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

  const { parsed, bodyText, response } = await postJson({
    url: TAVILY_SEARCH_URL,
    apiKey,
    body,
    signal,
    fetchImpl,
    timeoutMs,
    // 文案里的动词随端点不同：同一条消息说「search」而实际打的是 `/extract`，排障时
    // 会把人送到错误的那张错误表上。
    what: 'search',
  });
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
    credits: creditsOf(parsed),
    requestId,
  };
}

/**
 * 把 `/extract` 响应映射成一次抓取的结果（`FETCH-2`、`FETCH-3`）。
 *
 * **HTTP 200 不等于抓取成功。** 官方原文（`extract.md`）：「HTTP 200 can have an empty
 * results array when all valid URLs fail during extraction」。因此 `results[]` 与
 * `failed_results[]` 必须一并读：前者给出内容，后者给出「为什么没抓到」——而后者才是
 * 用户唯一能据以改正的东西（域名拼错、站点拒绝抓取、需要 JS 渲染）。
 *
 * `statusCode` 用的是一条约定，**不是上游的状态码**——上游这次给的正是 200：
 *
 * - 抓到内容 → `200`；
 * - 没抓到 → `502`（`Bad Gateway`：上游可到达，但它没能取回被请求的那份资源）。
 *
 * 选 `502` 而不是抛错，是 `FETCH-3` 的直接要求，也与 seam 的既有语义一致：「A
 * successful network fetch of a non-2xx response **is a result, not an error**」。
 * 抛错会让模型只看到一句话，而这里能带回失败原因本身。
 *
 * @param parsed - 解码后的 `/extract` 响应。
 * @param options - 本次抽取的参数。
 * @param options.url - 请求的 URL，用于在全失败时指名是哪一个。
 * @returns `{ url, statusCode, body, truncated }`，形状与 seam 的 `WebFetchResult` 对齐。
 */
export function mapExtractResponse(parsed, { url }) {
  const succeeded = successfulExtractions(parsed);
  const failures = failedExtractions(parsed);
  const first = succeeded[0];

  if (first === undefined) {
    return {
      url,
      statusCode: EXTRACT_FAILURE_STATUS,
      body: { kind: 'text', content: describeExtractFailure(url, failures) },
      truncated: false,
    };
  }

  return {
    url,
    statusCode: 200,
    body: {
      kind: 'text',
      // 官方返回的 `raw_content` 已经是 markdown（或 `format: 'text'` 时的纯文本）。
      // **标成 `text` 而不是 `html` 是硬约束**：`dsh-tool-web` 只在 `kind === 'html'`
      // 时经 turndown 转换，标错的代价是把一份 markdown 当 HTML 再转一次，内容被
      // 结构性破坏。没有内容时给空串——`content` 在 seam 的类型里是必填的。
      content: typeof first.raw_content === 'string'
        ? first.raw_content
        : typeof first.content === 'string' ? first.content : '',
    },
    // `/extract` 没有分页，也没有 DSH 侧那样的条数上限，因此没有可截断之处。如实报
    // `false`，而不是拿「我没截断」去顶替「上游没给全」。
    truncated: false,
  };
}

/**
 * 按**成功 URL 数**算出这次 `/extract` 消耗的积分（`USAGE-6`）。
 *
 * 官方的计费口径是「每 5 个成功 URL 计 1 积分（`basic`）/ 2 积分（`advanced`）」，
 * 且「**失败的 URL 永不收费**」。因此单 URL 的一次抓取多数时候是 **0 积分**，而不是 1。
 *
 * **本地算，不读 `usage.credits`。** 原因不是不信任上游，而是两者回答的不是同一个问题：
 * `usage.credits` 是上游在**它自己**的累计口径下的取整结果（官方原文：「The value may be
 * 0 if the total successful URL extractions has not yet reached 5 calls」），而上游的
 * 累起点与我们无关。我们要的是「这一次抓取值多少积分」，它唯一能从事实算出来，就由这个
 * 函数算——`mapExtractResponse` 与测试读的是同一份实现，不存在第二份口径。
 *
 * 计费按**整次请求的取整**（`Math.ceil`）：官方没有说明余数是跨请求累积还是丢弃，
 * 而「恰好 5 个」这一档在两套解释下都得 1 积分，因此 Gherkin 里那条 5 → 1 的场景不
 * 依赖这个选择。取整向上意味着余数不会被漏记，代价是本地读数可能略高于官方账单。
 *
 * @param options - 本次抽取的结果。
 * @param options.successfulUrls - 成功抽取的 URL 数。
 * @param options.depth - 抽取深度：`basic` 或 `advanced`。
 * @returns 积分消耗；成功 URL 为 0 时返回 0（而不是 `undefined`——「没抓到」是一次
 *   确定的零，与搜索那边「上游没回传消耗」的未知不是一回事）。
 */
export function extractCredits({ successfulUrls, depth }) {
  const count = Number.isInteger(successfulUrls) && successfulUrls > 0 ? successfulUrls : 0;
  if (count === 0) return 0;
  const perFive = depth === 'advanced' ? ADVANCED_EXTRACT_CREDITS_PER_FIVE : BASIC_EXTRACT_CREDITS_PER_FIVE;
  return Math.ceil(count / EXTRACT_URLS_PER_CREDIT_TIER) * perFive;
}

/**
 * 执行一次 Tavily 网页抽取（`FETCH-1`、`FETCH-4`、`FETCH-5`）。
 *
 * **一次调用只发一个 URL。** seam 的 `WebFetchRequest` 只有 `url` 一个字段，
 * `dsh-tool-web` 也是每次调用各发一次请求，因此这里没有可合并的批量——而 `/extract`
 * 的 `urls` 上限是 20，为将来可能的合并留一个数组参数只会多出一份没人用的形状。
 *
 * `timeout` 是**秒**（官方参数表：`1.0`–`60.0` 的 float），而这里的 `timeoutMs` 是
 * 毫秒，两者刻意各按自己的单位：把内部单位换算成上游单位是这一层的事，调用方不该为了
 * 发一个请求去记「这个 API 用秒」。
 *
 * @param options - 本次抽取。
 * @param options.apiKey - 用于认证的密钥。
 * @param options.url - 要抽取的 URL。
 * @param options.depth - 抽取深度；由 settings schema 负责校验，本函数只转发收到的值。
 * @param options.format - 返回格式；同上。
 * @param options.signal - 调用方取消信号。
 * @param options.fetchImpl - `fetch` 实现。
 * @param options.timeoutMs - 单次尝试的超时。
 * @returns `{ result, credits, successfulUrls, failedUrls, requestId }`：seam 归一化后的
 *   结果、按成功 URL 数算出的积分、成功与失败的 URL、上游的 `request_id`。
 * @throws {TavilyError} 失败时抛出。
 */
export async function extractTavily({
  apiKey,
  url,
  depth,
  format,
  signal,
  fetchImpl,
  timeoutMs = TAVILY_TIMEOUT_MS,
}) {
  const body = {
    urls: [url],
    ...depth === undefined ? {} : { extract_depth: depth },
    ...format === undefined ? {} : { format },
    // 上游的 `timeout` 单位是秒且是 float，因此这里直接送毫秒折算出来的小数，
    // 不再各自取整两次。
    timeout: timeoutMs / 1000,
    // 与搜索同理：不发它上游可能省略 `usage.credits`。这里不拿它记账（见
    // `extractCredits`），但留着它让上游的响应形状与官方文档一致，排障时能对账。
    include_usage: true,
  };

  const { bodyText, parsed, response } = await postJson({
    url: TAVILY_EXTRACT_URL,
    apiKey,
    body,
    signal,
    fetchImpl,
    timeoutMs,
    what: 'extract',
  });
  const requestId = typeof parsed?.request_id === 'string' ? parsed.request_id : undefined;

  if (!response.ok) {
    // **逐 URL 的失败原因优先，而不是抬头的概括。** `/extract` 的 `400` 会把原因放在
    // `detail.failed_results` 里，而 `detailOf` 只看 `detail.error` 那一层——先取后者
    // 会得到一句「All URLs failed validation.」，把唯一可据以改正的线索（是哪个 URL、
    // 为什么）丢掉。`FETCH-5` 说的「这张错误表与 /search 不同」正是指这一处。
    const detail = describeFailedResults(parsed?.detail?.failed_results)
      ?? detailOf(parsed)
      ?? bodyText.slice(0, 300);
    throw new TavilyError(
      `Tavily returned HTTP ${String(response.status)}: ${detail}`
      + (requestId === undefined ? '' : ` (request_id: ${requestId})`),
      {
        code: `TAVILY_HTTP_${String(response.status)}`,
        status: response.status,
        detail,
        requestId,
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

  const successfulUrls = successfulExtractions(parsed).length;
  return {
    result: mapExtractResponse(parsed, { url }),
    credits: extractCredits({ successfulUrls, depth }),
    successfulUrls,
    failedUrls: failedExtractions(parsed).length,
    requestId,
  };
}

/**
 * 发一次 JSON `POST`，并把传输层的失败翻译成内核错误。
 *
 * 搜索与抓取共用：两者在**传输层**的语义完全相同（Bearer 认证、JSON 体、取消与超时
 * 的区分、`Retry-After` 的原样搬运），差别只在端点、请求体与响应解释——那三件事分别
 * 留在各自的函数里。合成一份的收益不是少写几行，而是「超时算不算失败」这类问题只有
 * 一个答案。
 *
 * @param options - 本次请求。
 * @param options.url - 端点。
 * @param options.apiKey - 用于认证的密钥。
 * @param options.body - 请求体。
 * @param options.signal - 调用方取消信号。
 * @param options.fetchImpl - `fetch` 实现。
 * @param options.timeoutMs - 单次尝试的超时。
 * @param options.what - 文案里的动词（`search` / `extract`）。
 * @returns `{ response, bodyText, parsed }`。
 * @throws {TavilyError} 无法完成请求时抛出。
 */
async function postJson({ url, apiKey, body, signal, fetchImpl, timeoutMs, what }) {
  const timeout = AbortSignal.timeout(timeoutMs);
  const combined = signal === undefined ? timeout : AbortSignal.any([signal, timeout]);

  let response;
  try {
    response = await fetchImpl(url, {
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
    // 取消与超时被合并进同一个 signal，但在这里必须分开：前者按取消向上传递（调用方
    // 已经不要这个结果了），后者是密钥层面的失败，值得换一把再试。
    if (signal?.aborted === true) {
      throw new TavilyError(`Tavily ${what} aborted by the caller`, {
        code: 'TAVILY_ABORTED',
        cause: error,
      });
    }
    if (isAbortError(error)) {
      throw new TavilyError(`Tavily ${what} timed out after ${String(timeoutMs)}ms`, {
        code: 'TAVILY_TIMEOUT',
        cause: error,
      });
    }
    throw new TavilyError(`Tavily ${what} request failed: ${String(error)}`, {
      code: 'TAVILY_NETWORK_ERROR',
      cause: error,
    });
  }

  const bodyText = await response.text();
  return { response, bodyText, parsed: parseJson(bodyText) };
}

/** 响应里的积分消耗；缺失时为 `undefined`（`REST-3`）。 */
function creditsOf(parsed) {
  const credits = parsed?.usage?.credits;
  return typeof credits === 'number' && Number.isFinite(credits) ? credits : undefined;
}

/** `/extract` 成功抽取的条目；形状不对的一律跳过。 */
function successfulExtractions(parsed) {
  const results = Array.isArray(parsed?.results) ? parsed.results : [];
  return results.filter((item) => item !== null && typeof item === 'object');
}

/** `/extract` 失败的条目，每项形如 `{ url, error }`。 */
function failedExtractions(parsed) {
  const failures = Array.isArray(parsed?.failed_results) ? parsed.failed_results : [];
  return failures.filter((item) => item !== null && typeof item === 'object');
}

/**
 * 把所有 URL 都失败这件事写成一段给模型看的话（`FETCH-3`）。
 *
 * 必须带上**失败原因**：`/extract` 的失败几乎从不来自网络，而是「这个域名取不到」
 * 或「这个页面需要 JS 渲染」，两类原因对应两种完全不同的下一步。只说一句「抓取失败」
 * 会让模型重试同一个 URL。
 *
 * **不重复 URL**：`failed_results[]` 的每一项自己就带着 `url`，而模型早已知道它请求的
 * 是哪个地址（那是它刚填的参数）。抬头再写一遍只会得到「抓取 https://x 失败：
 * https://x: ...」这样一句读起来像故障的话。
 *
 * @param url - 请求的 URL，仅在没有任何失败明细时用于指名。
 * @param failures - `failed_results[]`。
 * @returns 说明文本。
 */
function describeExtractFailure(url, failures) {
  const reasons = describeFailedResults(failures);
  if (reasons === undefined) {
    return `Tavily could not extract ${url} and reported no reason. The page may require JavaScript, `
      + 'or the site may block automated retrieval.';
  }
  return `Tavily could not extract this page: ${reasons}`;
}

/** 把 `failed_results[]` 压成一行 `url: error` 文本；没有可用条目时返回 `undefined`。 */
function describeFailedResults(failures) {
  if (!Array.isArray(failures)) return undefined;
  const parts = [];
  for (const item of failures) {
    if (item === null || typeof item !== 'object') continue;
    const error = firstNonEmptyText(item.error) ?? 'no reason given';
    parts.push(firstNonEmptyText(item.url) === undefined ? error : `${item.url}: ${error}`);
  }
  return parts.length === 0 ? undefined : parts.join('; ');
}

/** 取第一个非空字符串。 */
function firstNonEmptyText(...values) {
  for (const value of values) {
    if (typeof value === 'string' && value.length > 0) return value;
  }
  return undefined;
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

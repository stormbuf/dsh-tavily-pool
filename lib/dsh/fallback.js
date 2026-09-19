/**
 * 回落：把请求转交 DSH 官方提供方。
 *
 * `PIN-3` 要求开关关闭时转交官方提供方。ADR-0001 已定：本插件在 patch 层静态
 * pin，因此**不能**靠「把 pin 改回去」实现回落——那需要改写 profile 文件，插件无权
 * 也不该这么做。可走的路只有一条：自己构造一个官方提供方实例并直接用。
 *
 * 构造**搜索**回落目标需要三件事，全部是宿主知识，因此都在本文件里：
 *
 * 1. `DeepSeekSearchProvider` 类本身，自 `@deepseek-ai/dsh-web-search-deepseek` 公开导出；
 * 2. `resolveOptions(ctx, config)` 需要的凭据与环境平面；
 * 3. `web-search-deepseek` settings 命名空间里的用户配置（apiKey / baseURL / model）。
 *
 * **不得**重新 `installSection('web-search-deepseek')`：命名空间不可重复注册，而该
 * 命名空间由内置的 `web-search-deepseek` 包注册（硬约束 4）。因此这里只**读**
 * `ctx.settings.get(...)`，读不到就退回环境变量与官方默认值——与官方包自己的
 * `resolveOptions` 同一套优先级。
 *
 * **抓取**的回落目标（{@link officialFetchProvider}）简单得多：官方
 * `HttpFetchProvider` 不需要凭据、不需要 settings 命名空间，只需一组限值。它住在同一个
 * 文件里，因为「回落目标长什么样」是一个问题，不是一个文件一个答案。
 *
 * @module dsh-tavily-pool/dsh/fallback
 */

import { credentialRef, isCredentialRefName } from '@deepseek-ai/dsh-credentials';
import { launchEnvironmentOf } from '@deepseek-ai/dsh-launch-environment';
import { DeepSeekSearchProvider, WEB_SEARCH_DEEPSEEK_SETTINGS_NAMESPACE } from '@deepseek-ai/dsh-web-search-deepseek';
import { WebError } from '@deepseek-ai/dsh-web';
import { DEFAULT_USER_AGENT, HttpFetchProvider } from '@deepseek-ai/dsh-web-fetch-http';

import { readService } from './read-service.js';

/**
 * 官方包的默认值，逐项照抄 `@deepseek-ai/dsh-web-search-deepseek` 的
 * `resolveOptions`。
 *
 * 抄一份而不是引入该包内部的 `resolveOptions`（它没有导出），因此这里存在一处会
 * 随上游漂移的重复。代价可接受：官方改动这些值时，插件读到的用户配置与环境变量
 * 仍然生效，只有「用户什么都没配」那一档会与官方不一致；而这一档本来就会以
 * 凭据缺失的形式响亮失败。`docs/dsh-upgrade.md` 的重适配清单第 4 条盯的就是它。
 */
const DEFAULT_API_KEY_ENV = 'DEEPSEEK_API_KEY';
const DEFAULT_BASE_URL = 'https://api.deepseek.com/anthropic/v1';
const DEFAULT_MODEL = 'deepseek-v4-flash';
const DEFAULT_API_VERSION = '2023-06-01';
const DEFAULT_MAX_TOKENS = 4096;
const DEFAULT_MAX_USES = 5;

/** 官方包用来覆盖端点地址的环境变量；与 chat 的 `DEEPSEEK_BASE_URL` 刻意不同。 */
const SEARCH_BASE_URL_ENV = 'DEEPSEEK_SEARCH_BASE_URL';

/** 一次回落失败的机器码：官方凭据从未配置过。 */
export const FALLBACK_CREDENTIAL_MISSING = 'TAVILY_FALLBACK_CREDENTIAL_MISSING';

/** 一次回落失败的机器码：官方凭据配了，但不能用。 */
export const FALLBACK_CREDENTIAL_INVALID = 'TAVILY_FALLBACK_CREDENTIAL_INVALID';

/**
 * 回落到官方搜索提供方并执行一次搜索（`PIN-3`、`CFG-5`）。
 *
 * 凭据分两态，且这一点必须**在发出请求之前**判明，否则两种情形会合并成同一个失败：
 *
 * - **未配置**：没有任何地方提供过 key。用户要做的是去配一把（面板里的 Models 页、
 *   环境变量，或 `web-search-deepseek` 的 `apiKey`）。→ {@link FALLBACK_CREDENTIAL_MISSING}
 * - **已失效**：配了 key，但上游不接受它（`401` / `403`）。用户要做的是换一把，
 *   而不是再配一次。→ {@link FALLBACK_CREDENTIAL_INVALID}
 *
 * 两者的区别正是 `CFG-5` 要求面板区分的那个区别，而它只在**真的发生了**一次回落
 * 之后才能给出结论：`DeepSeekSearchProvider.available()` 只会说「有 key」，不会说
 * 「key 可用」。因此这里先解析凭据（缺失即未配置），再把搜索过程中的鉴权失败重新
 * 贴成「已失效」。
 *
 * @param options - 本次回落。
 * @param options.ctx - 插件 context，用于读 credentials / settings / 环境。
 * @param options.request - seam 的搜索请求。
 * @param options.signal - 调用方取消信号。
 * @param options.reason - **为什么离开 Tavily**，一句话，由调用方给出。它只被用来拼装
 *   文案，不参与任何判断——但它是这段文案里最要紧的一半：用户刚被从 Tavily 那条路踢
 *   出来，而他唯一会读到的东西就是这条错误。原因**只能有一个来源**（`index.js` 知道
 *   自己走的是哪条分支），因此这里绝不自己猜一个：先前写死成「开关关了」，于是密钥池
 *   损坏的用户被告知去翻一个本来就开着的开关。
 * @returns seam 归一化后的结果。
 * @throws {WebError} 回落目标不可用时抛出；`code` 见上文两个常量。
 */
export async function searchWithOfficialProvider({ ctx, request, signal, reason }) {
  const options = resolveOfficialOptions(ctx);
  const because = typeof reason === 'string' && reason.length > 0 ? reason : 'Tavily search is unavailable';

  // 先判凭据，再构造请求。`resolveApiKey` 是官方提供方自己会调用的那个函数，这里先
  // 调一次只为把「未配置」与「已失效」分开；已经拿到的值不往下传——官方提供方会自己
  // 再解析一次，而把 key 在两层之间搬运只会多出一份可能泄漏的副本。
  const apiKey = await options.resolveApiKey();
  if (apiKey === undefined || apiKey.length === 0) {
    throw new WebError(
      `web search fell back to the DeepSeek official provider (${because}), but `
      + `the official credential is not configured: no value for "${options.apiKeyEnv}". Store it through `
      + 'the credentials service (the web Models page writes it), export it in the launching environment, '
      + 'or set a literal "apiKey" in the web-search-deepseek config.',
      FALLBACK_CREDENTIAL_MISSING,
    );
  }

  const provider = new DeepSeekSearchProvider(() => options);
  try {
    return await provider.search(request, signal);
  } catch (error) {
    throw tagCredentialFailure(error, options.apiKeyEnv, because);
  }
}

/**
 * 描述回落目标的凭据状态，供面板显示（`CFG-5`）。
 *
 * `CFG-5` 要求面板区分「凭据未配置」与「凭据已失效」，而这两者只有一条路能分清：
 *
 * - **已失效**只能由一次**真实发生的**回落得到——`DeepSeekSearchProvider.available()`
 *   只会说「有 key」，不会说「key 还能用」。因此这里接收 `lastFailureCode`（上一次回落
 *   失败时贴的机器码），由它给出 `invalid` 这一档。
 * - **未配置**与**已配置**可以当场解析出来：走 {@link resolveOfficialOptions} 的
 *   `resolveApiKey`，与官方提供方读的是同一处凭据、同一套优先级。
 *
 * 上一次失败是 `invalid` 时**不被当场探测覆盖**：探测只能说「有值」，而「有值」并不
 * 反驳「上次被官方拒了」。反过来，上一次失败是 `missing` 时不做保留——用户配好之后
 * 探测立刻会说 `configured`，那正是他要看到的。
 *
 * 这是**异步**的（要经 credentials 服务解析），因此调用方每次读面板状态都得重新问一次：
 * 缓存会让用户在 Models 页配好凭据之后仍然看到旧结论。
 *
 * @param ctx - 插件 context。
 * @param options - 观察到的历史事实。
 * @param options.lastFailureCode - 上一次回落失败的机器码；未发生过时省略。
 * @returns `{ credential, credentialSource, apiKeyEnv }`，其中 `credential` 取
 *   `missing` / `invalid` / `configured` / `unknown`。
 */
export async function describeOfficialCredential(ctx, { lastFailureCode } = {}) {
  const options = resolveOfficialOptions(ctx);
  if (lastFailureCode === FALLBACK_CREDENTIAL_INVALID) {
    return { credential: 'invalid', credentialSource: 'last-failure', apiKeyEnv: options.apiKeyEnv };
  }
  try {
    const apiKey = await options.resolveApiKey();
    return {
      credential: typeof apiKey === 'string' && apiKey.length > 0 ? 'configured' : 'missing',
      credentialSource: 'probe',
      apiKeyEnv: options.apiKeyEnv,
    };
  } catch {
    // 凭据服务存在但解析过程本身失败了：既不能说是「没配」，也不能说是「配了」。
    return { credential: 'unknown', credentialSource: 'unavailable', apiKeyEnv: options.apiKeyEnv };
  }
}

/**
 * 官方抓取提供方的默认限值，逐项照抄 `@deepseek-ai/dsh-web-fetch-http` 的 `Config`。
 *
 * 只有 `userAgent` 取该包**公开导出的常量**（`DEFAULT_USER_AGENT`）；其余四项在包里只
 * 存在于 schema 的 `.default(...)` 里，没有导出。照抄因此不可避免，代价与搜索那边同一类：
 * 官方改动这些值时，关掉开关后的行为会**静默偏离**用户原本的 DSH 行为——正是 ticket `10`
 * 的回落契约点名要防的事。
 *
 * 这份重复由 `test/dsh-fetch-provider.test.js` 盯住：那个用例直接读官方包的 `Config`
 * schema 并逐字段比对本表。上游一改，它当场变红，而不是等到某个用户发现超时时间不对。
 */
const OFFICIAL_FETCH_LIMITS = Object.freeze({
  maxResponseBytes: 5_000_000,
  maxBodyChars: 100_000,
  timeoutMs: 30_000,
  maxRedirects: 5,
  userAgent: DEFAULT_USER_AGENT,
});

/**
 * 我们复现的官方抓取限值。
 *
 * 暴露出来是为了让「声称复现了哪些默认值」这件事可被断言，而不是只能读源码。
 *
 * @returns 限值的一份副本。
 */
export function officialFetchLimits() {
  return { ...OFFICIAL_FETCH_LIMITS };
}

/**
 * 回落目标：官方本地 HTTP 抓取器（`PIN-4`）。
 *
 * 与搜索回落不同，它**不需要凭据、也不需要 settings 命名空间**：官方抓取器是匿名的公网
 * 抓取器（`available()` 恒为 `true`，官方注释原文：「an anonymous public fetcher is
 * always usable」）。因此这里没有「凭据未配置」那一档，也没有对应的错误码。
 *
 * **第二个参数刻意省略**，让官方包自己填它的默认解析器（`publicHttpNetwork.resolve`）。
 * ticket `10` 原本写的是「`resolveAddresses` 取自已导出的 `publicHttpNetwork.resolve`」，
 * 那**不成立**：该对象只在源码里导出，包根 `lib/index.js` 的 export 列表是
 * `{ Config, DEFAULT_USER_AGENT, HttpFetchProvider, LOCAL_FETCH_PROVIDER_ID, apply, inject, name }`，
 * 没有它，而 `package.json` 的 exports 只映射 `./src/*` 与 `./package.json`，没有任何
 * 子路径能到达 `lib/index.js`。省略参数拿到的是**同一个函数**（构造签名的默认值就是它），
 * 因此行为一致，差别只是我们不去碰一个没有公开入口的名字——`COMPAT-6` 要求的正是这一点。
 *
 * @returns 官方抓取提供方实例。
 */
export function officialFetchProvider() {
  overriddenFetchProvider ??= new HttpFetchProvider({ ...OFFICIAL_FETCH_LIMITS });
  return overriddenFetchProvider;
}

/** {@link officialFetchProvider} 的实例；测试经 {@link setOfficialFetchProvider} 替换。 */
let overriddenFetchProvider;

/**
 * 替换回落目标（**仅供测试**）。
 *
 * 存在的理由是回落契约里最难测的那一条：「关掉开关后，抓取行为与本机原有官方实现逐字段
 * 一致」。要断言它，必须观察**真的被调用到的那个**提供方；在测试里另造一个官方实例只能
 * 证明「官方实例是官方实例」。因此留一个替换入口，让用例把回落目标换成记录调用的桩件，
 * 再对桩件收到的参数做断言，最后用 {@link officialFetchLimits} 与官方 schema 对账。
 *
 * @param provider - 新的回落目标；传 `undefined` 恢复为按官方默认值构造。
 * @returns 无。
 */
export function setOfficialFetchProvider(provider) {
  overriddenFetchProvider = provider;
}

/**
 * 解析官方搜索提供方这一次操作所需的全部选项。
 *
 * 优先级与官方包的 `resolveOptions` 一致：用户配置 → 环境变量 → 常量默认值。读取
 * 全部经 {@link readService}，因此任一服务缺席都只退到下一档，而不是抛错。
 *
 * @param ctx - 插件 context。
 * @returns 官方提供方要的选项对象。
 */
export function resolveOfficialOptions(ctx) {
  const config = readDeepSeekConfig(ctx);
  const apiKeyEnv = typeof config?.apiKeyEnv === 'string' && config.apiKeyEnv.length > 0
    ? config.apiKeyEnv
    : DEFAULT_API_KEY_ENV;
  const literalApiKey = typeof config?.apiKey === 'string' && config.apiKey.length > 0 ? config.apiKey : undefined;
  const environment = readEnvironment(ctx);

  return {
    ...literalApiKey === undefined ? {} : { apiKey: literalApiKey },
    apiKeyEnv,
    resolveApiKey: async () => {
      if (literalApiKey !== undefined) return literalApiKey;
      const credentials = readService(ctx, 'credentials');
      if (credentials !== undefined) {
        // 名字必须先过 credentials 的语法。用户完全可以把 `apiKeyEnv` 写成
        // `MY KEY` 之类的东西，而 `credentials.resolve` 收到一个不合语法的引用会
        // **抛** TypeError——那会把一次回落变成插件自身的崩溃。不合语法就说明
        // 「这个名字在 credentials 里查不到」，按未配置继续往下走。
        if (isCredentialRefName(apiKeyEnv)) {
          const resolved = await credentials.resolve(credentialRef(apiKeyEnv));
          if (resolved !== undefined) return resolved.value;
        }
      }
      const ambient = environment(apiKeyEnv);
      return ambient !== undefined && ambient.length > 0 ? ambient : undefined;
    },
    baseURL: firstNonEmpty(config?.baseURL, environment(SEARCH_BASE_URL_ENV), DEFAULT_BASE_URL),
    model: firstNonEmpty(config?.model, DEFAULT_MODEL),
    apiVersion: firstNonEmpty(config?.apiVersion, DEFAULT_API_VERSION),
    maxTokens: positiveIntegerOr(config?.maxTokens, DEFAULT_MAX_TOKENS),
    maxUses: positiveIntegerOr(config?.maxUses, DEFAULT_MAX_USES),
  };
}

/**
 * 把官方提供方的鉴权失败贴成「凭据已失效」（`CFG-5`）。
 *
 * 判据刻意窄：只有 HTTP `401` / `403` 才算凭据问题。其余失败（端点不通、超时、上游
 * 5xx）原样向上——它们说的是「这次请求没成功」，不是「这把 key 不能用了」，把它们
 * 算进凭据失效会让用户去换一把本来好好的 key。
 *
 * @param error - 官方提供方抛出的值。
 * @param apiKeyEnv - 该凭据在环境里的名字，用于文案。
 * @param because - 为什么离开 Tavily，与凭据缺失那条使用同一个来源。
 * @returns 可抛出的错误。
 */
function tagCredentialFailure(error, apiKeyEnv, because) {
  const status = error?.status ?? httpStatusOf(error?.message);
  if (status !== 401 && status !== 403) return error;
  return new WebError(
    `web search fell back to the DeepSeek official provider (${because}), and the official provider `
    + `rejected the configured credential ("${apiKeyEnv}") with HTTP ${String(status)}, so the fallback `
    + `target is configured but its credential is no longer valid: ${error.message}`,
    FALLBACK_CREDENTIAL_INVALID,
    { cause: error },
  );
}

/**
 * 从官方提供方的错误消息里取回 HTTP 状态码。
 *
 * 官方提供方把状态码拼进消息（``DeepSeek API error (HTTP 401): ...``）而**不**挂在
 * 错误对象上，因此读消息是唯一途径。只认它自己那一种格式，读不到就当没有状态码。
 *
 * @param message - 错误消息。
 * @returns 状态码，或 `undefined`。
 */
function httpStatusOf(message) {
  if (typeof message !== 'string') return undefined;
  const matched = /\(HTTP (\d{3})\)/u.exec(message);
  return matched === null ? undefined : Number(matched[1]);
}

/** 读 `web-search-deepseek` 命名空间；该命名空间由官方包注册，本插件只读不写。 */
function readDeepSeekConfig(ctx) {
  const settings = readService(ctx, 'settings');
  if (settings === undefined) return undefined;
  try {
    const get = settings.get;
    if (typeof get !== 'function') return undefined;
    // 未注册的命名空间在这里返回 `undefined` 而不是抛错（已对真实宿主验证），因此
    // 「官方包被停用」这一档自然落进调用方的默认值路径。留着 `try` 是为了别的原因：
    // settings 是一个自有实现可能变形的可选服务，而回落路径不该因为一个读配置的
    // 意外而整个失败。
    return get.call(settings, WEB_SEARCH_DEEPSEEK_SETTINGS_NAMESPACE);
  } catch {
    return undefined;
  }
}

/**
 * 取一个「按名字读环境变量」的函数。
 *
 * 直接用官方包的 `launchEnvironmentOf` 而不是自己读 `process.env`：宿主提供的快照把
 * 进程环境、项目 `.env` 与 harness home 的 `.env` 三层按信任顺序合并，而官方提供方读的
 * 正是它。自己再写一遍既会漏掉那两层，又会让「key 写在 `.env` 里」的用户被误报成
 * 「凭据未配置」。
 *
 * @param ctx - 插件 context。
 * @returns 名字到值的函数；任何一层都没有该名字时返回 `undefined`。
 */
function readEnvironment(ctx) {
  const environment = launchEnvironmentOf(ctx);
  return (name) => environment.get(name)?.value;
}

/** 取第一个非空字符串。 */
function firstNonEmpty(...candidates) {
  for (const candidate of candidates) {
    if (typeof candidate === 'string' && candidate.length > 0) return candidate;
  }
  return undefined;
}

/** 取第一个正整数。 */
function positiveIntegerOr(value, fallback) {
  return Number.isInteger(value) && value > 0 ? value : fallback;
}

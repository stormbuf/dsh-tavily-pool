/**
 * 本插件的设置形状，以及运行时怎么把它读出来。
 *
 * 与宿主零耦合（`COMPAT-1`）：schema 由调用方（`lib/dsh/settings.js`）交给宿主的
 * settings 服务，本模块只描述「有哪些设置、默认是什么」。校验交给宿主的 schema 库，
 * 因此这里的形状必须是纯声明。
 *
 * **只有真正被读取的设置才在这里。** 抓取接管那三项（`fetchEnabled` / `fetchDepth` /
 * `fetchFormat`）随 ticket `10` 一起落地——它们各自都有一个真实的消费方：开关决定抓取
 * 走 Tavily 还是官方抓取器，另两项直接进 `/extract` 的请求体。
 *
 * @module dsh-tavily-pool/settings
 */

import { EXTRACT_DEPTH_VALUES, EXTRACT_FORMAT_VALUES, SETTINGS_NAMESPACE } from './constants.js';

/**
 * 搜索接管开关的默认值。
 *
 * 默认开启，因为用户装了插件就是想用它；关闭时按 `PIN-3` 回落到官方提供方。
 */
export const SEARCH_ENABLED_DEFAULT = true;

/**
 * 抓取接管开关的默认值（`CFG-2`）。
 *
 * 与搜索开关**各自独立**，默认同样是开：两个开关谈的是两条不同的路径，共用一个值会
 * 让「我只想接管搜索」这件事无从表达。
 */
export const FETCH_ENABLED_DEFAULT = true;

/**
 * `searchDepth` 的合法取值（`CFG-4`）。
 *
 * 四档的差别是延迟与相关性，不是内容格式；计费上 `advanced` 是 2 积分、其余三档
 * 各 1 积分（官方 `search_depth` 描述）。
 */
export const SEARCH_DEPTH_VALUES = Object.freeze(['basic', 'advanced', 'fast', 'ultra-fast']);

/** `topic` 的合法取值（`CFG-4`）。 */
export const TOPIC_VALUES = Object.freeze(['general', 'news', 'finance']);

/**
 * 调度策略的合法取值（`SCHED-1`、`SCHED-7`）。
 *
 * `balance` 是 `SCHED-1` 的余额优先，`manual` 是 `SCHED-7` 的手动顺序。两者是**排序**上
 * 的两种选择，不影响硬排除：额度耗尽、冷却、永久失效在任何策略下都不会被选中。
 */
export const SCHEDULING_POLICY_VALUES = Object.freeze(['balance', 'manual']);

/** 调度策略的默认值：余额优先（`SCHED-1`）。 */
export const SCHEDULING_POLICY_DEFAULT = 'balance';

/**
 * `maxResults` 的合法区间（`CFG-4`）。
 *
 * **下界是 1，不是官方 OpenAPI 写的 0。** 官方 schema 声明 `minimum: 0`，但 2026-09-19
 * 用真实密钥实测：`max_results: 0` 被上游以 `HTTP 400 Invalid max results.` 拒绝
 * （1、2、5、20 均正常）。`400` 按 `REST-8` 不重试也不切换密钥，因此放行 0 等于放出
 * 一个**每次搜索都必然失败**的取值；面板能存下它，用户却只会看到一个来自上游的
 * 400。取 1 是唯一不会自我否定的下界。已就此更正 `spec` 的 `CFG-4` 与 ticket `07`。
 */
export const MAX_RESULTS_MIN = 1;

/** `maxResults` 的上界：官方 `max_results` 的 `maximum`。 */
export const MAX_RESULTS_MAX = 20;

/** 搜索参数的默认值；未配置时逐项退回这里，与 Tavily 自己的默认一致。 */
export const SEARCH_PARAM_DEFAULTS = Object.freeze({
  searchDepth: 'basic',
  maxResults: 10,
  topic: 'general',
  includeAnswer: false,
});

/**
 * 抓取参数的默认值（`10`）。
 *
 * 与 Tavily 自己的默认一致：`basic` 与 `markdown`（官方参数表把这两项都标为默认）。
 * `markdown` 而不是 `text`，因为官方明确说 `text` 会**增加延迟**。
 */
export const FETCH_PARAM_DEFAULTS = Object.freeze({
  fetchDepth: 'basic',
  fetchFormat: 'markdown',
});

/**
 * 本插件的设置形状。
 *
 * 每一项都带 `default`，因为宿主把「schema 默认值 → 组合 base → 用户层」依次解析后
 * 交回一个**完整**的对象；少了默认值，用户没碰过的项在解析结果里根本不存在，面板也
 * 就渲染不出一个可改的初值。
 *
 * @param schema - 宿主的 schema 构造器（`@deepseek-ai/schemastery`）。
 * @returns schema 对象。
 */
export function settingsSchema(schema) {
  return schema.object({
    searchEnabled: schema
      .boolean()
      .default(SEARCH_ENABLED_DEFAULT)
      .description('接管 web_search；关闭时转交 DSH 官方搜索提供方'),
    fetchEnabled: schema
      .boolean()
      .default(FETCH_ENABLED_DEFAULT)
      .description('接管 web_fetch；关闭时转交 DSH 内置的本地 HTTP 抓取器'),
    fetchDepth: schema
      .union([...EXTRACT_DEPTH_VALUES])
      .default(FETCH_PARAM_DEFAULTS.fetchDepth)
      .description('Tavily extract_depth：basic / advanced（每 5 个成功 URL 分别计 1 / 2 积分）'),
    fetchFormat: schema
      .union([...EXTRACT_FORMAT_VALUES])
      .default(FETCH_PARAM_DEFAULTS.fetchFormat)
      .description('Tavily format：markdown / text（text 会额外增加延迟）'),
    schedulingPolicy: schema
      .union([...SCHEDULING_POLICY_VALUES])
      .default(SCHEDULING_POLICY_DEFAULT)
      .description('调度策略：balance 按剩余余额降序，manual 按用户排定的顺序依次尝试'),
    searchDepth: schema
      .union([...SEARCH_DEPTH_VALUES])
      .default(SEARCH_PARAM_DEFAULTS.searchDepth)
      .description('Tavily search_depth：basic / advanced / fast / ultra-fast（advanced 计 2 积分）'),
    maxResults: schema
      .number()
      .min(MAX_RESULTS_MIN)
      .max(MAX_RESULTS_MAX)
      .step(1)
      .default(SEARCH_PARAM_DEFAULTS.maxResults)
      .description(`单次搜索最多取回的结果数（${String(MAX_RESULTS_MIN)}–${String(MAX_RESULTS_MAX)}）`),
    topic: schema
      .union([...TOPIC_VALUES])
      .default(SEARCH_PARAM_DEFAULTS.topic)
      .description('Tavily topic：general / news / finance'),
    includeAnswer: schema
      .boolean()
      .default(SEARCH_PARAM_DEFAULTS.includeAnswer)
      .description('请求 Tavily 生成一段答案，作为搜索结果的 content 返回'),
  });
}

/**
 * 从 settings 服务读出当前设置。
 *
 * 读取失败一律退到默认值：设置服务坏了不该让搜索也变得不可用，而「按默认值继续
 * 工作」正是 `PIN-5` 的半坏仍可用语义。返回的对象按模块里声明的默认值逐项补齐，
 * 因此调用方不必再判 `undefined`——一个缺失的字段与一个显式写成默认值的字段，对
 * 搜索而言是同一件事。
 *
 * **取值在读取时重新校验一次，而不是信任存下来的东西。** 宿主在写入时按 schema
 * 校验，但用户文档是一份可以直接编辑的文件（`settings.yaml` 及其同类），于是
 * `maxResults: 5.5` 或 `searchDepth: "deep"` 完全可能出现在解析结果里。这类值会
 * 被原样发给 Tavily 并换回一个 `400`——按 `REST-8`，那既不重试也不切换密钥，等于
 * 每一次搜索都注定失败。退回默认值至少让搜索继续工作。
 *
 * @param source - settings 服务，或它的 `get(namespace)` 结果。
 * @param namespace - 命名空间。
 * @returns `{ searchEnabled, fetchEnabled, fetchDepth, fetchFormat, schedulingPolicy,
 *   searchDepth, maxResults, topic, includeAnswer }`。
 */
export function readSettings(source, namespace = SETTINGS_NAMESPACE) {
  const raw = readNamespace(source, namespace);
  return {
    searchEnabled: readBoolean(raw?.searchEnabled, SEARCH_ENABLED_DEFAULT),
    fetchEnabled: readBoolean(raw?.fetchEnabled, FETCH_ENABLED_DEFAULT),
    fetchDepth: readEnum(raw?.fetchDepth, EXTRACT_DEPTH_VALUES, FETCH_PARAM_DEFAULTS.fetchDepth),
    fetchFormat: readEnum(raw?.fetchFormat, EXTRACT_FORMAT_VALUES, FETCH_PARAM_DEFAULTS.fetchFormat),
    schedulingPolicy: readEnum(raw?.schedulingPolicy, SCHEDULING_POLICY_VALUES, SCHEDULING_POLICY_DEFAULT),
    searchDepth: readEnum(raw?.searchDepth, SEARCH_DEPTH_VALUES, SEARCH_PARAM_DEFAULTS.searchDepth),
    maxResults: readBoundedInteger(
      raw?.maxResults,
      MAX_RESULTS_MIN,
      MAX_RESULTS_MAX,
      SEARCH_PARAM_DEFAULTS.maxResults,
    ),
    topic: readEnum(raw?.topic, TOPIC_VALUES, SEARCH_PARAM_DEFAULTS.topic),
    includeAnswer: readBoolean(raw?.includeAnswer, SEARCH_PARAM_DEFAULTS.includeAnswer),
  };
}

/**
 * 把搜索参数投影成发给 Tavily 的那几个字段（`CFG-3`）。
 *
 * 只挑出搜索本身需要的三项；`maxResults` 不在这里，因为它的最终值还取决于调用方
 * 在这次请求里要多少条（见 `effectiveMaxResults`）。
 *
 * @param settings - {@link readSettings} 的结果。
 * @returns `{ searchDepth, topic, includeAnswer }`。
 */
export function searchParamsOf(settings) {
  return {
    searchDepth: settings.searchDepth,
    topic: settings.topic,
    includeAnswer: settings.includeAnswer,
  };
}

/**
 * 发给 Tavily 的 `max_results`（`CFG-3`、`CFG-4`）。
 *
 * 取**用户配置值**与**本次调用方要的条数**中的较小者。两者都是真实存在的上界，所以
 * 这没有新增任何限制；它只是不向 Tavily 索取一份马上就要被 seam 丢掉的结果。宿主
 * 的 `dsh-tool-web` 总会带上 `maxResults`，因此实际上这个设置扮演的是「上限」：
 * 把它调小能少取几条，调大不会让调用方拿到更多（seam 仍按请求数截断）。
 *
 * 调用方没给（`undefined`）时按配置值发；这正是「`maxResults` 由 seam 的
 * `capSources` 做第二次截断」里属于本插件的那一次。
 *
 * @param configured - 设置里的 `maxResults`；已由 {@link readSettings} 保证落在区间内。
 * @param requested - `WebSearchRequest.maxResults`。
 * @returns 正整数。
 */
export function effectiveMaxResults(configured, requested) {
  if (!Number.isInteger(requested)) return configured;
  return Math.min(configured, requested);
}

/** 读命名空间，容忍服务缺席或形状改变。 */
function readNamespace(source, namespace) {
  if (source === null || source === undefined) return undefined;
  try {
    const get = source.get;
    if (typeof get === 'function') return get.call(source, namespace);
    return source[namespace];
  } catch {
    return undefined;
  }
}

/** 读一个布尔项；不是布尔时用默认值。 */
function readBoolean(value, fallback) {
  return typeof value === 'boolean' ? value : fallback;
}

/** 读一个枚举项；不在词表内时用默认值。 */
function readEnum(value, allowed, fallback) {
  return typeof value === 'string' && allowed.includes(value) ? value : fallback;
}

/** 读一个整数项；不是整数或越界时用默认值。 */
function readBoundedInteger(value, min, max, fallback) {
  if (!Number.isInteger(value) || value < min || value > max) return fallback;
  return value;
}

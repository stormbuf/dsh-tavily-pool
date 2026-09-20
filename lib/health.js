/**
 * 密钥健康状态与失败分类。
 *
 * 与宿主零耦合（`COMPAT-1`）：本模块只认「观测到的事实」（状态码、响应体措辞、
 * 机器码）与「据此刻该做什么」，不 import 任何 `@deepseek-ai/*`。
 *
 * 它回答两个问题，且只回答这两个：
 *
 * 1. **这次失败意味着这把密钥怎样**（{@link classifyFailure}）——冷却、额度耗尽、
 *    永久失效，还是请求本身有误。
 * 2. **这把密钥此刻能不能被选中**（{@link KeyHealth}）——以及状态变了之后怎么落盘。
 *
 * 排序与选择不在这里，在 `lib/scheduler.js`；把两者混在一起会让「余额怎么排」和
 * 「什么算失败」互相纠缠，而它们的变化原因毫不相干。
 *
 * @module dsh-tavily-pool/health
 */

import { estimateExtractCredits, estimateSearchCredits } from './tavily.js';
import { needsQuotaProbe } from './usage.js';

/**
 * 冷却的默认时长（秒）。
 *
 * `5xx` 与网络故障都不带 `Retry-After`（官方只有 `429` 的响应有该头），因此本地
 * 默认值是这些路径的唯一依据（`REST-11`）。
 */
export const DEFAULT_COOLDOWN_SECONDS = 60;

/**
 * 冷却下限（秒）。
 *
 * 上游给 `Retry-After: 0` 时冷却形同虚设，下一次调度会立刻再选它，于是故障切换
 * 退化成原地重试。
 */
export const MIN_COOLDOWN_SECONDS = 30;

/** 冷却上限（秒）：上游给 `86400` 时不该让一把密钥白冻一天。 */
export const MAX_COOLDOWN_SECONDS = 300;

/**
 * 判定「永久失效」的响应体措辞（`REST-5`）。
 *
 * `401` / `403` 单凭状态码**不足以**判定永久失效——这两个码也可能是代理、网关或
 * 一次瞬时鉴权异常造成的。只有上游明确说这把密钥本身不可再用时，才把它移出池子
 * 等用户处理。
 */
const PERMANENT_INVALID_PHRASES = Object.freeze([
  'invalid api key',
  'invalid api_key',
  'invalid key',
  'api key is invalid',
  'revoked',
  'deactivated',
  'suspended',
  'disabled',
  'expired',
  'deleted',
]);

/**
 * 由健康状态决定的下一步动作。
 *
 * 前三种都是**故障切换**：把该密钥按对应方式排除，然后改试池内另一把
 * （`SCHED-4`）。后两种不切换。
 */
export const FAILURE_ACTIONS = Object.freeze({
  /** 临时失败：冷却该密钥，冷却期内硬排除（`SCHED-3`）。 */
  COOLDOWN: 'cooldown',
  /** 额度耗尽：在 `/usage` 确认余额回升前不选中（`SCHED-8`）。 */
  EXHAUSTED: 'exhausted',
  /** 永久失效：用户必须处理，重试与等待都无意义。 */
  INVALID: 'invalid',
  /** 请求本身有误：重试与换密钥都不会改变结果（`REST-8`）。 */
  FATAL: 'fatal',
  /** 调用方取消：按取消向上传递，不计入密钥健康。 */
  ABORTED: 'aborted',
});

/**
 * 额度耗尽时该对用户说的话（`REST-7`）。
 *
 * 官方对 `432` 与 `433` 的自愈指引都是「到 Tavily dashboard 提高限额」，**不是**「换
 * 一把密钥」，因此这里必须说清前者。文案只此一份：分类给出它、编排层原样用它——同一
 * 句指引若在两处各写一遍，迟早会有一处先改，而用户看到的是哪一处取决于失败路径，
 * 那正是最难发现的一类不一致。
 */
export const QUOTA_ADVICE =
  'Credits reset on the 1st of each month regardless of the billing date; to search before then, '
  + 'increase the limit in the Tavily dashboard (https://app.tavily.com/account/plan). The key stays '
  + 'out of rotation until /usage reports a positive balance.';

/**
 * 把 `Retry-After` 解析为秒数（`REST-4`）。
 *
 * 官方只保证该头是「整数秒」，但 HTTP 规范允许 HTTP-date，而中间的反向代理完全可能
 * 发出后者；只认数字会让一个合法响应被当作「缺失」而退到本地默认值。
 *
 * @param value - 响应头的原始值。
 * @param nowMs - 当前时刻，用于把 HTTP-date 换算成相对秒数。
 * @returns 秒数（可能为 0 或负）；缺失或不可解析时返回 `undefined`。
 */
export function parseRetryAfter(value, nowMs = Date.now()) {
  if (typeof value !== 'string') return undefined;
  const text = value.trim();
  if (text.length === 0) return undefined;

  // delta-seconds：官方形式，也可能是小数或带符号的畸形值。
  if (/^[+-]?\d+(?:\.\d+)?$/u.test(text)) return Number(text);

  // HTTP-date：解析失败时 `Date.parse` 返回 NaN，此时按「缺失」处理。
  const parsed = Date.parse(text);
  if (Number.isNaN(parsed)) return undefined;
  return (parsed - nowMs) / 1000;
}

/**
 * 把冷却时长收敛到可用区间（`REST-4`、`REST-11`）。
 *
 * 两端都必须 clamp：下限防止上游给 0 让冷却失效，上限防止上游给一天把密钥白冻。
 *
 * @param seconds - 候选秒数；缺失或非有限数时用默认值。
 * @returns 落在 [{@link MIN_COOLDOWN_SECONDS}, {@link MAX_COOLDOWN_SECONDS}] 内的秒数。
 */
export function clampCooldownSeconds(seconds) {
  if (typeof seconds !== 'number' || !Number.isFinite(seconds)) return DEFAULT_COOLDOWN_SECONDS;
  return Math.min(MAX_COOLDOWN_SECONDS, Math.max(MIN_COOLDOWN_SECONDS, Math.ceil(seconds)));
}

/**
 * 判定响应体措辞是否指向上游明确认可的「永久失效」。
 *
 * **输入必须是上游自己给出的结构化错误文本**（`TavilyError.detail`，来自
 * `{detail:{error}}` 那一层）。这个函数只做子串匹配，分辨不出文本的出处，因此
 * 「哪段文本有资格到这里来」这件事由 `lib/tavily.js` 用两个字段划清：代理/WAF/CDN
 * 自己生成的 HTML 里出现 `expired` / `disabled` 这类词纯属偶然，那种片段走在
 * `bodyExcerpt` 上，根本不会成为判据的输入。
 *
 * @param detail - 上游错误文本；`detailOf` 已经把它从各种信封里取出来。
 * @returns 命中任一措辞时返回 true。
 */
export function isPermanentInvalidDetail(detail) {
  if (typeof detail !== 'string' || detail.length === 0) return false;
  const normalized = detail.toLowerCase().replace(/\s+/gu, ' ');
  return PERMANENT_INVALID_PHRASES.some((phrase) => normalized.includes(phrase));
}

/**
 * 按 Tavily 的状态码与响应体语义分类一次失败（`REST-4`～`REST-8`、`REST-11`、`FETCH-5`）。
 *
 * **两张错误表，不是一个。** `/search` 的状态码全集是 `400/401/403/422/429/432/433/500`，而
 * `/extract` 是 `400/401/429/432/433/500`——它**没有 403，也没有 422**（官方 OpenAPI 机器核验）。
 * 因此 `endpoint: 'extract'` 时那两个码
 * 走通用分支：它们不在那张表里，说明这一层没见过的某种情况发生了，而对一个来路不明的 `403`
 * 套用 `/search` 的「措辞命中就永久失效」语义，正是 `FETCH-5` 点名禁止的事。
 *
 * 两个码都落进「其余 4xx」那一档（`FATAL`，不重试也不换密钥）：这个判断对**未在官方错误表里
 * 出现**的客户端错误是安全的——换一把密钥不会改变一个「这个请求不被接受」的答复。
 *
 * **例外是 408 与 425，它们归入冷却。** 两者都不是「这个请求不被接受」：`408 Request
 * Timeout` 常由出口代理或负载均衡在等源站超时之后**自己**发出（上游可能根本没收到这次
 * 请求），而 `425 Too Early`（RFC 8470）的语义本身就是「稍后再试」。把它们当致命错误，
 * 后果是整次请求在**第一把**密钥上终结——池内其余健康密钥一次都不被尝试——而该密钥还
 * 不进冷却，下一次调度仍把它当完全正常的候选。这与 `5xx` 是同一种情形，因此按同一档
 * 处理。
 *
 * @param failure - 观测到的事实。
 * @param failure.status - 上游 HTTP 状态码；传输层失败时缺席。
 * @param failure.detail - 上游错误文本，用于 `401` / `403` 的措辞判定。只应是**上游信封
 *   里**的文本（`TavilyError.detail`）：代理自己生成的 HTML 不参与判定。
 * @param failure.code - 内核机器码，用于没有状态码的失败。
 * @param failure.retryAfter - 响应头 `Retry-After` 的原始值。
 * @param failure.endpoint - 这次调用打的是哪个端点：`search`（默认）或 `extract`。它决定
 *   哪些状态码在这张表里。
 * @returns `{ action, cooldownSeconds?, status?, code?, detail? }`。
 */
export function classifyFailure(failure = {}) {
  const { status, detail, code, retryAfter, endpoint = 'search' } = failure;

  if (code === 'TAVILY_ABORTED') {
    return { action: FAILURE_ACTIONS.ABORTED, code };
  }

  if (Number.isInteger(status)) {
    if (status === 429) {
      // 官方明确要求用响应头里的值，而不是写死一个数。
      return {
        action: FAILURE_ACTIONS.COOLDOWN,
        cooldownSeconds: clampCooldownSeconds(parseRetryAfter(retryAfter)),
        status,
      };
    }
    if (status === 432 || status === 433) {
      // 不区分账号级与密钥级：官方不提供密钥归属信息，「账号级」在本插件的位置上
      // 不可执行（`REST-6`）。两者都按「该密钥额度耗尽」处理。该说什么由调用方从
      // {@link QUOTA_ADVICE} 取，不在这里复述一份。
      return { action: FAILURE_ACTIONS.EXHAUSTED, status };
    }
    if (status === 401) {
      // 措辞命中才永久失效（`REST-5`）。泛化 401 归入冷却而不是放着不管：不加冷却的话，
      // 这把密钥在排序里仍在原位，下一次调度会立刻再选中它并再失败一次，故障切换等于没有
      // 发生。冷却不是隔离——它到点自动恢复，也不要求用户处理。两个端点都发 401。
      return isPermanentInvalidDetail(detail)
        ? { action: FAILURE_ACTIONS.INVALID, status, detail }
        : {
          action: FAILURE_ACTIONS.COOLDOWN,
          cooldownSeconds: clampCooldownSeconds(parseRetryAfter(retryAfter)),
          status,
        };
    }
    if (endpoint !== 'extract' && status === 403) {
      // **只有 `/search` 走到这里。** `/extract` 的表里没有 403，因此抓取路径上的 403 落到
      // 下面「其余 4xx」那一档。
      return isPermanentInvalidDetail(detail)
        ? { action: FAILURE_ACTIONS.INVALID, status, detail }
        : {
          action: FAILURE_ACTIONS.COOLDOWN,
          cooldownSeconds: clampCooldownSeconds(parseRetryAfter(retryAfter)),
          status,
        };
    }
    // 400 是「请求本身不合法」：换一把密钥不会让请求变得合法（`REST-8`）。422 同理，而它
    // 只在 `/search` 的表里。
    if (status === 400 || (endpoint !== 'extract' && status === 422)) {
      return { action: FAILURE_ACTIONS.FATAL, status };
    }
    if (status >= 500) {
      return {
        action: FAILURE_ACTIONS.COOLDOWN,
        cooldownSeconds: clampCooldownSeconds(parseRetryAfter(retryAfter)),
        status,
      };
    }
    // 408 与 425 是**中间层的瞬时**失败，不是「这个请求不被接受」：前者常由出口代理或
    // 负载均衡在等源站超时后自己发出，后者按 RFC 8470 的语义就是「稍后重试」。两者与
    // `5xx` 同档，因此该密钥进冷却、本次请求换下一把，而不是在第一把上终结。
    if (status === 408 || status === 425) {
      return {
        action: FAILURE_ACTIONS.COOLDOWN,
        cooldownSeconds: clampCooldownSeconds(parseRetryAfter(retryAfter)),
        status,
      };
    }
    // 其余 4xx 未在官方错误表中出现。按「客户端错误」处理：换密钥不修复它。
    if (status >= 400) return { action: FAILURE_ACTIONS.FATAL, status };
  }

  // 没有状态码：超时、传输失败，或 200 却给出无法解码的响应体。三者都是上游或链路
  // 的临时问题，与 `5xx` 同构。
  return {
    action: FAILURE_ACTIONS.COOLDOWN,
    cooldownSeconds: clampCooldownSeconds(parseRetryAfter(retryAfter)),
    code,
  };
}

/**
 * ISO 字符串转 epoch 毫秒；缺失或不可解析时返回 `undefined`。
 */
function toMillis(iso) {
  if (typeof iso !== 'string' || iso.length === 0) return undefined;
  const parsed = Date.parse(iso);
  return Number.isNaN(parsed) ? undefined : parsed;
}

/** epoch 毫秒转 ISO 字符串。 */
function toIso(ms) {
  return new Date(ms).toISOString();
}

/**
 * 每把密钥的健康状态，以及它落到密钥池文件里的方式。
 *
 * **状态只有一份**：它就在密钥池文档的 `stats` 里，本类只做读取、计算与增量写入，
 * 不在自己这边再缓存一份。这不是省内存，而是避免一类真实缺陷——调度是同步决策
 * （`SCHED-6`），若内存副本与文档各记一份，两者一旦分叉，调度看到的就是一份不存在的
 * 状态：刚失败的密钥仍然是候选，刚冷却的密钥仍然会被选中。
 *
 * 写入因此是「先改内存文档、再把落盘排队」：紧接着的调度立刻看到新状态，而磁盘最终
 * 与之一致。
 */
export class KeyHealth {
  #pool;
  #now;

  /**
   * @param options - 状态来源。
   * @param options.pool - 持久化密钥池；状态存在它的 `stats` 字段里。
   * @param options.now - 当前时刻，测试时可注入。
   */
  constructor({ pool, now = Date.now }) {
    this.#pool = pool;
    this.#now = now;
  }

  /** 某把密钥当前的原始统计；没有记录过时返回空对象。 */
  statsOf(id) {
    return this.#pool.statsOf(id) ?? {};
  }

  /**
   * 某把密钥此刻的全部状态，供调度器排序与过滤。
   *
   * @param id - 密钥 id。
   * @param nowMs - 当前时刻；冷却是否仍然有效按它判断。
   * @returns `{ cooling, cooldownUntilMs, quotaExhausted, permanentlyInvalid, lastUsedSeq, usage }`。
   */
  snapshotOf(id, nowMs = this.#now()) {
    const stats = this.statsOf(id);
    const cooldownUntilMs = toMillis(stats.cooldownUntil);
    return {
      cooling: cooldownUntilMs !== undefined && cooldownUntilMs > nowMs,
      cooldownUntilMs,
      quotaExhausted: toMillis(stats.quotaExhaustedAt) !== undefined,
      permanentlyInvalid: toMillis(stats.permanentlyInvalidAt) !== undefined,
      // 排序只认这个序号，不认时间戳：见 {@link KeyHealth#markSelected}。
      lastUsedSeq: typeof stats.useSeq === 'number' && Number.isFinite(stats.useSeq) ? stats.useSeq : 0,
      usage: this.#pool.usageOf(id),
    };
  }

  /**
   * 记录一次「已选中这把密钥」。
   *
   * 必须在调度决策的同步临界区里调用，用它驱动轮转（`SCHED-1`）：下一个并发请求
   * 看到的序号已经是本次的值，因此不会重复选中同一把同余额的密钥。
   *
   * 轮转依据的是**单调序号**而不是时间戳。毫秒精度的 `lastUsedAt` 在这里不够用：同一
   * 毫秒内的两次选择会得到完全相同的时间戳，并列之后排序退回到用户顺序，于是并发请求
   * 会持续偏向排在前面的那把——正是 `SCHED-1` 要避免的饿死。序号在同一份密钥池内全局
   * 递增，因此任意两次选择都可比。`lastUsedAt` 仍然记录，供面板展示。
   *
   * @param id - 密钥 id。
   * @param nowMs - 当前时刻。
   * @returns 落盘完成的 promise。
   */
  markSelected(id, nowMs = this.#now()) {
    const nextSeq = this.#nextUseSeq();
    return this.#merge(id, (stats) => ({
      ...stats,
      calls: (stats.calls ?? 0) + 1,
      useSeq: nextSeq,
      lastUsedAt: toIso(nowMs),
    }));
  }

  /** 池内已用的最大序号 + 1；没有用过任何密钥时为 1。 */
  #nextUseSeq() {
    return this.#pool.maxStat('useSeq') + 1;
  }

  /**
   * 记录一次成功，并按本次**估算**的消耗前推余额缓存（`USAGE-5`）。
   *
   * 成功即清除冷却：这把密钥刚刚被上游接受了，任何关于它「暂时不可用」的记录都已
   * 过时。额度耗尽的标记不在这里清除——`SCHED-8` 要求只由 `/usage` 确认恢复。
   *
   * **只前推，不记账**（2026-09-20 决定）。先前这里同时做两件事：把本次消耗累加进
   * `stats.credits`（流水，供面板展示），以及前推 `usageCache.key.usage`（调度真正读的
   * 那份余额）。现在只剩后者——积分规则由上游随时可能更改，插件不再统计自身消耗，也不
   * 展示任何自算的积分数字；面板与设置页只展示 `/usage` 的官方余额。
   *
   * 前推用的值是**估算**（{@link estimateSearchCredits} / {@link estimateExtractCredits}），
   * 它算错不影响任何展示，只让调度排序在两次 `/usage` 刷新之间略有偏差——而这比「完全
   * 不前推」好：不前推的话，额度充足的密钥会一直被排在前面，排序仍按上一次 `/usage` 的
   * 旧数字来，直到用户手动点一次刷新。
   *
   * 前推本身由 {@link PoolStore#advanceUsage} 判断可行性（没有缓存、无限额度、值不可用
   * 时都不动）。
   *
   * **抓取的估算在这里算，不在内核里算。** 官方按「每 5 个成功 URL」计费，而 5 是**跨请求
   * 累计**的——只有持有累计计数的地方才知道这一次有没有跨过档位，那个地方就是这里（它读得
   * 到 `stats.extractUrls`）。内核只交回「这一次成功了几个 URL」。
   *
   * @param id - 密钥 id。
   * @param outcome - 本次调用。
   * @param outcome.successfulUrls - 这次抓取成功了多少个 URL。给了它就**按累计档位**估算，
   *   否则按搜索估算。
   * @param outcome.extractDepth - 抽取深度，决定每档算 1 还是 2 积分。仅在给了
   *   `successfulUrls` 时参与计算。
   * @param outcome.searchDepth - 搜索深度，决定本次按 1 还是 2 积分估算。
   * @param outcome.durationMs - 本次耗时。
   * @param outcome.nowMs - 当前时刻。
   * @returns 落盘完成，并给出**本次估算了多少积分**（供测试断言；调用方不再把它写进历史）。
   */
  async recordSuccess(id, { successfulUrls, extractDepth, searchDepth, durationMs, nowMs = this.#now() } = {}) {
    const fetched = Number.isInteger(successfulUrls) && successfulUrls >= 0;
    let estimate;

    await this.#merge(id, (stats) => {
      const next = {
        ...stats,
        successes: (stats.successes ?? 0) + 1,
        lastDurationMs: durationMs,
        lastUsedAt: toIso(nowMs),
      };
      if (fetched) {
        // 累计计数只服务于估算：跨档判断需要知道「此前一共成功了多少个」。
        const before = Number.isInteger(stats.extractUrls) && stats.extractUrls > 0 ? stats.extractUrls : 0;
        estimate = estimateExtractCredits({ successfulUrls: before, added: successfulUrls, depth: extractDepth });
        next.extractUrls = before + successfulUrls;
      } else {
        estimate = estimateSearchCredits(searchDepth);
      }
      if (next.cooldownUntil !== undefined) delete next.cooldownUntil;
      return next;
    });
    // 估算值即使为 0 也交下去：`advanceUsage` 自己会忽略 0，而「这次没跨档」与「不知道
    // 花了多少」在估算口径下是同一件事，没有区分的必要。
    await this.#pool.advanceUsage(id, estimate ?? 0);
    return estimate;
  }

  /**
   * 记录一次失败，并按分类更新该密钥的状态。
   *
   * @param id - 密钥 id。
   * @param outcome - 本次调用。
   * @param outcome.failure - 观测到的事实：`{ status, detail, code, retryAfter }`。
   * @param outcome.message - 上游错误文本，存进 `lastError` 供面板展示。
   * @param outcome.durationMs - 本次耗时。
   * @param outcome.nowMs - 当前时刻。
   * @returns `{ classification, persisted }`，与 {@link classifyFailure} 同形。
   */
  recordFailure(id, { failure = {}, message, durationMs, nowMs = this.#now() } = {}) {
    const classification = classifyFailure(failure);
    const persisted = this.#merge(id, (stats) => {
      const next = {
        ...stats,
        failures: (stats.failures ?? 0) + 1,
        lastDurationMs: durationMs,
        lastError: {
          code: failure.code ?? (failure.status === undefined ? undefined : `TAVILY_HTTP_${String(failure.status)}`),
          status: failure.status,
          message: message ?? failure.detail,
          at: toIso(nowMs),
        },
      };

      if (classification.action === FAILURE_ACTIONS.COOLDOWN) {
        // 冷却只延长、不缩短：同一次请求里两个失败谈的是不同的等待时长，取更晚的那个
        // 才同时满足两者。
        const until = nowMs + classification.cooldownSeconds * 1000;
        const previous = toMillis(stats.cooldownUntil) ?? 0;
        next.cooldownUntil = toIso(Math.max(previous, until));
      } else if (classification.action === FAILURE_ACTIONS.EXHAUSTED) {
        next.quotaExhaustedAt = toIso(nowMs);
      } else if (classification.action === FAILURE_ACTIONS.INVALID) {
        next.permanentlyInvalidAt = toIso(nowMs);
        next.invalidReason = failure.detail;
      }
      return next;
    });
    return { classification, persisted };
  }

  /**
   * 清除某把密钥的**额度耗尽**标记（`SCHED-8`）。
   *
   * 这是 `quotaExhaustedAt` 唯一的清除路径，而调用它的地方只有一个：`/usage` 的实际
   * 返回值确认余额为正之后。刻意不给它别的入口——`recordSuccess` 都不清它，因为
   * 「这一次搜索成功了」并不能说明「这把密钥还有量」：一次成功完全可能发生在一把
   * 已经见底的密钥上（例如别的密钥先被选中、它只是没被用到）。
   *
   * 顺手清掉 `lastQuotaProbeAt`：探测窗口是「本次额度耗尽」的一部分，恢复之后它就没
   * 有意义了；留着它会让下一次额度耗尽的第一格探测被上一次的残留推后。
   *
   * @param id - 密钥 id。
   * @returns 确实清掉了一个标记时返回 true；本来就没标记时返回 false。
   */
  async clearQuotaExhausted(id) {
    const had = toMillis(this.statsOf(id).quotaExhaustedAt) !== undefined;
    await this.#merge(id, (stats) => {
      const next = { ...stats };
      delete next.quotaExhaustedAt;
      delete next.lastQuotaProbeAt;
      return next;
    });
    return had;
  }

  /**
   * 清除某把密钥的**永久失效**标记。
   *
   * 这个标记的判据是「上游说过这把密钥不可再用」，因此撤销它的证据必须是**上游反过来
   * 接受了这把密钥**。一次成功的 `/usage` 正是这样的证据：它带着这把密钥的
   * `Authorization` 且被官方读通了。因此调用它的地方只有一个——`lib/usage.js` 的刷新
   * 成功分支；面板上单把的「刷新余额」与「测试连通性」两条命令都走那条路径，于是用户
   * 有了一个可见的复位入口。
   *
   * **`recordSuccess` 不清它。** 那个标记在调度器里是硬排除（`SCHED-4`），因此它从一
   * 开始就不可能靠一次搜索成功来撤销：被排除的密钥根本没有机会成功。而且这个标记的
   * 全部依据都是「上游的措辞」，只有 `401`/`403` 那条路径会写它，写入的措辞判定又刻意
   * 收窄到上游信封里的文本（见 `lib/tavily.js` 的 `detail` / `bodyExcerpt`）。
   *
   * 顺手清掉 `invalidReason`：它是那个标记的注解，标记没了它就成了没有指涉的残留数据。
   *
   * @param id - 密钥 id。
   * @returns 确实清掉了一个标记时返回 true；本来就没标记时返回 false。
   */
  async clearPermanentlyInvalid(id) {
    const had = toMillis(this.statsOf(id).permanentlyInvalidAt) !== undefined;
    await this.#merge(id, (stats) => {
      const next = { ...stats };
      delete next.permanentlyInvalidAt;
      delete next.invalidReason;
      return next;
    });
    return had;
  }

  /**
   * 记录一次自动探测已发生（`SCHED-10`）。
   *
   * 只写时刻、不改状态：探测的结果由 `/usage` 的返回值决定，而那条路径会经
   * {@link clearQuotaExhausted} 或原样保留来处理。这里记的是「问过了」，防的是同一个
   * 6 小时栅格内被反复触发——没有它，每次搜索都会探测一次，10 分钟内就把官方配额
   * 打满。
   *
   * @param id - 密钥 id。
   * @param options - 本次探测。
   * @param options.nowMs - 当前时刻。
   * @returns 落盘完成的 promise。
   */
  recordQuotaProbe(id, { nowMs = this.#now() } = {}) {
    return this.#merge(id, (stats) => ({ ...stats, lastQuotaProbeAt: toIso(nowMs) }));
  }

  /**
   * 池中哪些额度耗尽的密钥此刻该做一次重置探测（`SCHED-10`）。
   *
   * 只回答「值不值得问一次」；「恢复没有」永远由 `/usage` 的返回值回答，而那是
   * {@link clearQuotaExhausted} 的事。
   *
   * @param ids - 要考虑的密钥 id。
   * @param nowMs - 当前时刻。
   * @returns 该探测的密钥 id。
   */
  quotaProbeDue(ids, nowMs = this.#now()) {
    return ids.filter((id) => needsQuotaProbe({ stats: this.statsOf(id), nowMs }));
  }

  /**
   * 最早到期的冷却时刻。
   *
   * 有界等待（`SCHED-9`）只对冷却类失败有意义：额度耗尽可能要等到下月 1 日，永久
   * 失效永不恢复，两者都不该让请求在这里挂着。因此这里**只**统计冷却。
   *
   * @param ids - 要考虑的密钥 id；省略表示全部。
   * @param nowMs - 当前时刻。
   * @returns 最早的到期时刻（epoch 毫秒）；没有处于冷却中的密钥时返回 `undefined`。
   */
  earliestCooldownExpiry(ids, nowMs = this.#now()) {
    let earliest;
    for (const id of ids) {
      const { cooling, cooldownUntilMs } = this.snapshotOf(id, nowMs);
      if (!cooling || cooldownUntilMs === undefined) continue;
      if (earliest === undefined || cooldownUntilMs < earliest) earliest = cooldownUntilMs;
    }
    return earliest;
  }

  /** 把一把密钥的统计改掉，并把落盘排进队列。 */
  #merge(id, mutate) {
    return this.#pool.writeStats(id, (stats) => mutate(stats ?? {}));
  }
}

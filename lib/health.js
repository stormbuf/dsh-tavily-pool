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
export const PERMANENT_INVALID_PHRASES = Object.freeze([
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

/** 额度耗尽时附给用户的官方自愈路径（`REST-7`）。 */
const QUOTA_ADVICE =
  'Tavily reports no credits left on this key for the current billing cycle. Credits reset on the '
  + '1st of each month regardless of the billing date; to search before then, increase the limit in '
  + 'the Tavily dashboard. The key stays out of rotation until /usage reports a positive balance.';

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
 * @param detail - 上游错误文本；`detailOf` 已经把它从各种信封里取出来。
 * @returns 命中任一措辞时返回 true。
 */
export function isPermanentInvalidDetail(detail) {
  if (typeof detail !== 'string' || detail.length === 0) return false;
  const normalized = detail.toLowerCase().replace(/\s+/gu, ' ');
  return PERMANENT_INVALID_PHRASES.some((phrase) => normalized.includes(phrase));
}

/**
 * 按 Tavily 的状态码与响应体语义分类一次失败（`REST-4`～`REST-8`、`REST-11`）。
 *
 * @param failure - 观测到的事实。
 * @param failure.status - 上游 HTTP 状态码；传输层失败时缺席。
 * @param failure.detail - 上游错误文本，用于 `401` / `403` 的措辞判定。
 * @param failure.code - 内核机器码，用于没有状态码的失败。
 * @param failure.retryAfter - 响应头 `Retry-After` 的原始值。
 * @returns `{ action, cooldownSeconds?, status?, code?, advice? }`。
 */
export function classifyFailure(failure = {}) {
  const { status, detail, code, retryAfter } = failure;

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
      // 不可执行（`REST-6`）。两者都按「该密钥额度耗尽」处理。
      return { action: FAILURE_ACTIONS.EXHAUSTED, status, advice: QUOTA_ADVICE };
    }
    if (status === 401 || status === 403) {
      // 措辞命中才永久失效（`REST-5`）。泛化 401/403 归入冷却而不是放着不管：不加
      // 冷却的话，这把密钥在排序里仍在原位，下一次调度会立刻再选中它并再失败一次，
      // 故障切换等于没有发生。冷却不是隔离——它到点自动恢复，也不要求用户处理。
      return isPermanentInvalidDetail(detail)
        ? { action: FAILURE_ACTIONS.INVALID, status, detail }
        : {
          action: FAILURE_ACTIONS.COOLDOWN,
          cooldownSeconds: clampCooldownSeconds(parseRetryAfter(retryAfter)),
          status,
        };
    }
    // 400 与 422 都是「请求本身不合法」：换一把密钥不会让请求变得合法（`REST-8`）。
    if (status === 400 || status === 422) {
      return { action: FAILURE_ACTIONS.FATAL, status };
    }
    if (status >= 500) {
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
   * 记录一次成功。
   *
   * 成功即清除冷却：这把密钥刚刚被上游接受了，任何关于它「暂时不可用」的记录都已
   * 过时。额度耗尽的标记不在这里清除——`SCHED-8` 要求只由 `/usage` 确认恢复。
   *
   * @param id - 密钥 id。
   * @param outcome - 本次调用。
   * @param outcome.credits - 上游回传的积分消耗；缺失表示记账未知（`REST-3`）。
   * @param outcome.durationMs - 本次耗时。
   * @param outcome.nowMs - 当前时刻。
   * @returns 落盘完成的 promise。
   */
  recordSuccess(id, { credits, durationMs, nowMs = this.#now() } = {}) {
    return this.#merge(id, (stats) => {
      const next = {
        ...stats,
        successes: (stats.successes ?? 0) + 1,
        lastDurationMs: durationMs,
        lastUsedAt: toIso(nowMs),
      };
      if (typeof credits === 'number' && Number.isFinite(credits)) {
        next.credits = (stats.credits ?? 0) + credits;
      } else {
        // 记「未知」而不是 0：`REST-3` 要求区分「本次没消耗」与「不知道消耗了多少」，
        // 记 0 会让余额前推长期偏低。
        next.creditsUnknown = (stats.creditsUnknown ?? 0) + 1;
      }
      if (next.cooldownUntil !== undefined) delete next.cooldownUntil;
      return next;
    });
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

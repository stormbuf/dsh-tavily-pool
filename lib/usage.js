/**
 * 余额刷新（`/usage`）与记账。
 *
 * 与宿主零耦合（`COMPAT-1`）：不 import 任何 `@deepseek-ai/*`。`fetch` 与当前时刻都是
 * 注入的依赖，因此每条时间相关路径都能在 `node:test` 下被确定地覆盖。
 *
 * 三件事在这里，且只在这里：
 *
 * 1. **怎么问**（{@link fetchUsage}）——Tavily `/usage` 的请求与解释。
 * 2. **还能不能问**（{@link UsageQuota}）——`USAGE-2` 的滑动窗口预占。
 * 3. **什么时候该问**（{@link shouldProbeAfterMonthStart}）——`SCHED-10` 的月起始探测窗口。
 *
 * {@link UsageRefresher} 把这三件串起来，并决定「问完之后把状态改成什么样」；「余额为正
 * 才恢复候选」那条规则（`SCHED-8`）由它经 {@link hasPositiveBalance} 与
 * `lib/health.js` 的 `clearQuotaExhausted` 共同落实——哪些密钥状态能清、哪些不能，属于
 * `lib/health.js`。
 *
 * @module dsh-tavily-pool/usage
 */

import {
  QUOTA_PROBE_INTERVAL_MS,
  QUOTA_PROBE_WINDOW_MS,
  TAVILY_USAGE_URL,
  USAGE_QUOTA_MAX_CALLS,
  USAGE_QUOTA_WINDOW_MS,
  USAGE_TIMEOUT_MS,
} from './constants.js';
import { TavilyError, detailOf, isAbortError } from './tavily.js';

/**
 * 判断一次 `/usage` 响应里的余额是否为正（`SCHED-8`、`SCHED-10`）。
 *
 * 三态，与调度器排序用的是同一套输入（`SCHED-2`）：
 *
 * - `limit === null` → 无限额度，**必然为正**。这是官方明确的「无限」表示。
 * - `usage` 小于有限的 `limit` → 正。
 * - 其余（`limit` 缺失、`usage` 缺失、`usage >= limit`）→ **不能确认为正**。
 *
 * 判据与 {@link balanceRank} 逐项相同（同一份输入下两者从不矛盾），**差别在返回类型的
 * 语义**：这里是布尔「能否确认可用」，那里是数值「排多前」。因此不要为一个想象中的分歧
 * 在这里加分支——真正需要多说的是第一行那个 `true`：`balanceRank` 对无限额度返回
 * `Infinity` 只是把它排在最前，而恢复判定必须把它读成「确认为正」。
 *
 * 「不能确认」与「确认为零」在这里被合并成同一个结果，因为它们对**恢复**这个决定的
 * 含义相同：`SCHED-8` 要求「`/usage` 确认其余额回升」才恢复，而一个读不出余额的响应
 * 什么也没有确认。宁可让一把密钥继续留在排除里，也不要因为一次残缺的响应把它放回
 * 候选——后者会让每一次搜索都白撞一次 `432`。
 *
 * @param usageEntry - 缓存下来的 `/usage` 响应，形状为 `{ key, account, ... }`。
 * @returns 能确认余额为正时返回 true。
 */
export function hasPositiveBalance(usageEntry) {
  const key = usageEntry?.key;
  if (key === null || typeof key !== 'object') return false;
  if (key.limit === null) return true;
  if (typeof key.limit !== 'number' || !Number.isFinite(key.limit)) return false;
  if (typeof key.usage !== 'number' || !Number.isFinite(key.usage)) return false;
  return key.usage < key.limit;
}

/**
 * 调用 Tavily `/usage`（`USAGE-1`）。
 *
 * 与 `/search` 共用同一套错误面（{@link TavilyError}），因此调用方可以用同一套分类
 * 逻辑判断这次失败意味着什么。`429` 的 `Retry-After` 同样原样搬运——它在这里表达
 * 的是「官方让你等一会儿再问」，而不是「这把密钥该冷却」。
 *
 * 返回的**只有解码后的响应体与上游的 `request_id`**：把官方值写进缓存是调用方的事，
 * 因为「怎么写、写失败怎么办」属于持久化（`USAGE-3`），不属于 HTTP 客户端。
 *
 * @param options - 本次查询。
 * @param options.apiKey - 用于认证的密钥。
 * @param options.signal - 调用方取消信号。
 * @param options.fetchImpl - `fetch` 实现。
 * @param options.timeoutMs - 本次请求的超时。
 * @returns `{ usage, requestId }`。
 * @throws {TavilyError} 失败或响应不可解码时抛出。
 */
export async function fetchUsage({ apiKey, signal, fetchImpl, timeoutMs = USAGE_TIMEOUT_MS }) {
  const timeout = AbortSignal.timeout(timeoutMs);
  const combined = signal === undefined ? timeout : AbortSignal.any([signal, timeout]);

  let response;
  try {
    // `GET`，不是 `POST`：官方 OpenAPI 定义如此，实测 `POST` 返回 405。
    response = await fetchImpl(TAVILY_USAGE_URL, {
      method: 'GET',
      headers: {
        authorization: `Bearer ${apiKey}`,
        accept: 'application/json',
      },
      signal: combined,
    });
  } catch (error) {
    if (signal?.aborted === true) {
      throw new TavilyError('Tavily usage query aborted by the caller', {
        code: 'TAVILY_ABORTED',
        cause: error,
      });
    }
    if (isAbortError(error)) {
      throw new TavilyError(`Tavily usage query timed out after ${String(timeoutMs)}ms`, {
        code: 'TAVILY_TIMEOUT',
        cause: error,
      });
    }
    throw new TavilyError(`Tavily usage query failed: ${String(error)}`, {
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
      `Tavily usage query returned HTTP ${String(response.status)}: ${detail}`
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
  if (parsed === null || typeof parsed !== 'object') {
    throw new TavilyError('Tavily usage query returned a body that is not JSON', {
      code: 'TAVILY_UNPROCESSABLE_RESPONSE',
      status: response.status,
    });
  }

  return { usage: parsed, requestId };
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

/**
 * 按密钥维度的滑动窗口配额预占（`USAGE-2`）。
 *
 * 官方对 `/usage` 的限流是硬拒绝（`429`），而「一键刷新全部余额」会按密钥数消耗
 * 配额——池子里有 12 把密钥时，连点两次就能撞上它。因此每一次**真实发出**的请求都
 * 要先在这里占一个名额。
 *
 * 预占是**记账式的**：{@link UsageQuota#tryAcquire} 先判额度再记账，两个动作之间没有
 * `await`，因此同一 tick 里的并发调用不可能各自读到「还有一个名额」的旧快照。
 *
 * 记录在内存里而不落盘：它是**限流**依据而非用户数据，进程重启后从零开始正是我们
 * 要的（重启意味着距上次刷新已经过去很久了）。把它写进 `keys.json` 只会让一份临时
 * 状态获得持久性，而它没有任何长期价值。
 */
export class UsageQuota {
  #windowMs;
  #maxCalls;
  #now;
  #calls = new Map();

  /**
   * @param options - 窗口参数。
   * @param options.windowMs - 窗口长度。
   * @param options.maxCalls - 每个窗口内允许的调用数。
   * @param options.now - 当前时刻，测试时可注入。
   */
  constructor({ windowMs = USAGE_QUOTA_WINDOW_MS, maxCalls = USAGE_QUOTA_MAX_CALLS, now = Date.now } = {}) {
    this.#windowMs = windowMs;
    this.#maxCalls = maxCalls;
    this.#now = now;
  }

  /**
   * 尝试为某把密钥占一个名额。
   *
   * @param id - 密钥 id。
   * @returns 占到名额时返回 true；窗口内已满时返回 false，且**不记账**。
   */
  tryAcquire(id) {
    const nowMs = this.#now();
    const recent = this.#recent(id, nowMs);
    if (recent.length >= this.#maxCalls) return false;
    recent.push(nowMs);
    this.#calls.set(id, recent);
    return true;
  }

  /** 某把密钥在窗口内的占位时刻，顺带把过期的挤出去。 */
  #recent(id, nowMs) {
    const cutoff = nowMs - this.#windowMs;
    const kept = (this.#calls.get(id) ?? []).filter((at) => at > cutoff);
    this.#calls.set(id, kept);
    return kept;
  }
}

/**
 * 判断一把额度耗尽的密钥是否已进入 `SCHED-10` 的自动探测窗口。
 *
 * 时间在这里**只是触发器，不是恢复依据**（`USAGE-4`）：本函数回答的是「现在值不值得
 * 去问一次」，而「恢复没有」永远只由 `/usage` 的返回值回答。
 *
 * 窗口从**标记之后的第一个 UTC 月起始**算起：
 *
 * - 标记还没跨过任何月起始 → 不探测。额度耗尽通常发生在月中，此时去问只会浪费配额。
 * - 跨过之后 48 小时内 → 按 6 小时间隔探测。这个长度覆盖了 UTC±14 的全部月初 0 点。
 * - 48 小时之后 → 停止自动探测。仍无恢复说明不是「还没到重置时刻」，而是要用户提额；
 *   此后只能靠手动刷新。
 *
 * 间隔从**上次探测**起算，因此 48 小时的窗口里最多 **8** 次探测（实测栅格为月起始后的
 * 0/6/12/…/42 小时），远低于「10 次 / 10 分钟」的官方配额。`USAGE-2` 的配额预占是第二道
 * 防线，不是唯一那道。
 *
 * @param options - 判断所需的事实。
 * @param options.quotaExhaustedAt - 额度耗尽的标记时刻（epoch 毫秒）。
 * @param options.nowMs - 当前时刻。
 * @param options.lastProbeAt - 上次探测的时刻（epoch 毫秒）；从未探测过时省略。
 * @returns `{ probe, monthStartMs }`：是否该探测，以及本次判断所用的月起始。
 */
export function shouldProbeAfterMonthStart({ quotaExhaustedAt, nowMs, lastProbeAt }) {
  const monthStartMs = utcMonthStartAfter(quotaExhaustedAt);
  if (monthStartMs === undefined || nowMs < monthStartMs) return { probe: false, monthStartMs };
  if (nowMs - monthStartMs >= QUOTA_PROBE_WINDOW_MS) return { probe: false, monthStartMs };

  // 上次探测发生在窗口开始**之前**时按「没探测过」处理：那是上一个窗口的事，不该
  // 让本窗口的第一格被它推后。
  if (lastProbeAt === undefined || lastProbeAt < monthStartMs) return { probe: true, monthStartMs };
  return { probe: nowMs - lastProbeAt >= QUOTA_PROBE_INTERVAL_MS, monthStartMs };
}

/**
 * 一个时刻之后的第一个 UTC 月起始。
 *
 * 用 UTC 而不是本地时区，因为官方从未说明重置发生在哪个时区的 0 点（Help Center 与
 * FAQ 两处原文都不含 `UTC` 或任何时区字样）。UTC 月起始是**最早可能**的重置时刻，
 * 从它开始探测意味着我们绝不会漏掉任何一个时区的重置。
 *
 * @param atMs - 标记时刻（epoch 毫秒）。
 * @returns 下一个 UTC 月起始的 epoch 毫秒；`atMs` 不可用时返回 `undefined`。
 */
export function utcMonthStartAfter(atMs) {
  if (typeof atMs !== 'number' || !Number.isFinite(atMs)) return undefined;
  const at = new Date(atMs);
  // `Date.UTC` 对月份溢出的处理正是我们要的：12 月会进位到下一年的 1 月。
  return Date.UTC(at.getUTCFullYear(), at.getUTCMonth() + 1, 1, 0, 0, 0, 0);
}

/**
 * 把官方 `/usage` 的返回值整体覆盖进缓存（`USAGE-1`、`USAGE-3`）。
 *
 * 两条规则，各自都对应一次真实事故：
 *
 * - **成功即整体覆盖**：不做字段合并。官方值是权威，本地那份是它的镜像；合并会让
 *   一个已经不被官方返回的旧字段永远留在缓存里。
 * - **失败绝不写入**：`USAGE-3` 明确要求失败时保留旧缓存并标记陈旧，而不是用 0 或
 *   `null` 覆盖。把一次网络失败写成「余额 0」会让一把好好的密钥在调度里排到最后，
 *   而且**看上去像是真的读到了 0**。
 */
export class UsageRefresher {
  #pool;
  #health;
  #quota;
  #now;
  #fetchImpl;
  #timeoutMs;

  /**
   * @param options - 协作者。
   * @param options.pool - 密钥池，提供 `usageOf()` / `setUsage()`。
   * @param options.health - 健康状态，提供 `clearQuotaExhausted()`。
   * @param options.quota - 配额预占（{@link UsageQuota}）。
   * @param options.fetchImpl - `fetch` 实现，测试时可注入。
   * @param options.timeoutMs - `/usage` 的超时。
   * @param options.now - 当前时刻，测试时可注入。
   */
  constructor({ pool, health, quota, fetchImpl, timeoutMs = USAGE_TIMEOUT_MS, now = Date.now }) {
    this.#pool = pool;
    this.#health = health;
    this.#quota = quota;
    this.#fetchImpl = fetchImpl;
    this.#timeoutMs = timeoutMs;
    this.#now = now;
  }

  /**
   * 刷新一把密钥的余额。
   *
   * 三条出口，且都**不抛**：这个函数在调度之前与面板按钮两条路径上被调用，让一次
   * 余额查询的失败炸掉一次搜索（或一次面板点击）是错误的量级——余额是优化，不是
   * 搜索能否进行的前提。
   *
   * @param id - 密钥 id。
   * @param apiKey - 明文密钥，仅在本次调用内使用。
   * @param options - 本次刷新的选项。
   * @param options.signal - 调用方取消信号。
   * @param options.reason - `'manual'` 或 `'probe'`；只用于结果区分，不影响行为。
   * @returns `{ ok, skipped?, stale?, error?, usage? }`。
   */
  async refresh(id, apiKey, { signal, reason = 'manual' } = {}) {
    if (!this.#quota.tryAcquire(id)) {
      // 跳过而不是排队：排队的刷新会在窗口滚动时突然一起发出去，正好撞上限流。
      return { ok: false, skipped: 'quota', reason };
    }

    let usage;
    try {
      ({ usage } = await fetchUsage({
        apiKey,
        signal,
        fetchImpl: this.#fetchImpl,
        timeoutMs: this.#timeoutMs,
      }));
    } catch (error) {
      // `USAGE-3`：失败时保留旧值，只把它标成陈旧。旧值一个字节也不会动——`setUsage`
      // 在这条路径上根本不被调用。
      //
      // 标记本身是尽力而为的：它也要写盘，而写盘正是可能刚刚失败的那件事（磁盘满、
      // 目录只读）。标记写不进去不该把「刷新失败」升级成一次抛出。
      await this.#pool.markUsageStale(id).catch(() => undefined);
      return { ok: false, stale: true, reason, error };
    }

    // 官方值已经拿到。这之后**任何**失败都只说明「没记住」，不说明「没读到」——因此
    // 不再走陈旧路径：把一份刚刚读到的新值标成陈旧，等于把一次成功的刷新报成失败。
    try {
      // **先**落地余额、**再**清额度耗尽标记：反过来的话，清除标记的那一瞬间调度器
      // 可能已经看到「可选中」，并把请求发给了一把官方刚刚说没量的密钥。
      //
      // 只清「能确认余额为正」的那一种（`SCHED-8`）：读不出余额的响应什么也没有确认，
      // 而把一把没量的密钥放回候选，代价是此后每一次搜索都白撞一次 432。
      const positive = hasPositiveBalance(usage);
      const written = await this.#pool.setUsage(id, usage, { nowMs: this.#now() });
      const recovered = positive ? await this.#health.clearQuotaExhausted(id) : false;
      return { ok: true, reason, usage: written, recovered };
    } catch (error) {
      return { ok: false, reason, error };
    }
  }
}

/**
 * 判断一把密钥现在是否应当被自动探测（`SCHED-10`）。
 *
 * 把 {@link shouldProbeAfterMonthStart} 需要的事实从密钥统计里取齐，使调度器不必知道
 * 月起始、探测栅格与窗口这些细节。
 *
 * @param options - 判断所需的事实。
 * @param options.stats - 该密钥的统计。
 * @param options.nowMs - 当前时刻。
 * @returns 是否该探测。
 */
export function needsQuotaProbe({ stats, nowMs }) {
  const quotaExhaustedAt = toMillis(stats?.quotaExhaustedAt);
  if (quotaExhaustedAt === undefined) return false;
  const { probe } = shouldProbeAfterMonthStart({
    quotaExhaustedAt,
    nowMs,
    lastProbeAt: toMillis(stats?.lastQuotaProbeAt),
  });
  return probe;
}

/** ISO 字符串转 epoch 毫秒；缺失或不可解析时返回 `undefined`。 */
function toMillis(iso) {
  if (typeof iso !== 'string' || iso.length === 0) return undefined;
  const parsed = Date.parse(iso);
  return Number.isNaN(parsed) ? undefined : parsed;
}

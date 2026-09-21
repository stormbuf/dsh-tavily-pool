/**
 * 条件式余额刷新：**只在插件被使用时**顺手刷新超龄的读数（`USAGE-8`）。
 *
 * 与宿主零耦合（`COMPAT-1`）：它只认密钥池与刷新器这两个抽象，因此能在 `node:test` 下
 * 用普通对象直接覆盖。
 *
 * ## 它解决的是什么
 *
 * 余额前推（`USAGE-5`）让调度在两次官方读数之间也能按大致余额排序，但前推的误差会
 * **一直累积到下一次官方读数为止**。先前那次读数只在用户手动点「刷新余额」时发生，
 * 于是误差可以累积几天。
 *
 * 本模块把那段空窗钉成有界的：某把密钥真的被用到、而它的读数已超过
 * {@link USAGE_REFRESH_AFTER_MS} 时，顺手问一次官方。
 *
 * ## 为什么不是一个定时器
 *
 * `USAGE-8` 明确要求**闲置时零调用**：插件不被使用时不该产生任何 `/usage` 流量。
 * 一个「每 N 分钟扫一遍池子」的后台任务恰好违背这一点——它在用户根本没搜索的时候
 * 也在发请求，消耗的是与恢复额度同一份配额。因此触发点只有真实动作：某把密钥被选中
 * 去发请求，或用户刚往池里加了密钥。
 *
 * ## 飞去重
 *
 * 同一把密钥的前一次刷新还没回来时不再排一次：一次搜索里的多次尝试、几秒钟内的连续
 * 几次搜索，问的都是同一个问题。去重按 id 记在 {@link BalanceRefresher} 的私有集合上，
 * **失败也要清**——否则一次失败的刷新会让这把密钥此后永远不再被自动刷新。
 *
 * @module dsh-tavily-pool/balance-refresh
 */

import { hasBalanceReading, needsBalanceRefresh } from './usage.js';

/**
 * 按需刷新池内密钥的余额。
 *
 * 它是「该不该问」的**唯一**执行点：判据本身在 `lib/usage.js` 的
 * {@link needsBalanceRefresh}（纯函数），而「还能不能问」由刷新器的滑动窗口预占回答
 * （`USAGE-2`）。本类只负责去重、触发与「绝不拖慢调用方」这三件事。
 */
export class BalanceRefresher {
  #pool;
  #refresh;
  #now;
  #inFlight = new Set();

  /**
   * @param options - 协作者。
   * @param options.pool - 密钥池，提供 `usageOf(id)`。
   * @param options.refresh - 刷新一把密钥：`(id, key, { reason }) => Promise`。它必须
   *   **从不抛错**（`UsageRefresher#refresh` 正是如此）；本类仍然加了一道 `catch`，
   *   因为一次余额查询绝不该有能力把调用方弄挂。
   * @param options.now - 当前时刻，测试时可注入。
   */
  constructor({ pool, refresh, now = Date.now }) {
    this.#pool = pool;
    this.#refresh = refresh;
    this.#now = now;
  }

  /** 此刻正在后台刷新的密钥 id 数量（供测试断言去重生效）。 */
  get inFlightCount() {
    return this.#inFlight.size;
  }

  /**
   * 某把密钥的读数超龄时，在后台刷新它。
   *
   * **立刻返回**，不等刷新完成：刷新是一次优化，不是这次调用的前提，让一次余额查询
   * 拖慢一次搜索是错误的量级。
   *
   * @param target - 刚被选中（或刚被加入）的密钥：`{ id, key }`。
   * @param options - 本次刷新。
   * @param options.reason - `'used'` 或 `'added'`；只用于结果区分，不影响行为。
   * @returns 确实排了一次刷新时返回 true。
   */
  refreshIfStale(target, { reason }) {
    if (target === null || typeof target !== 'object') return false;
    const { id, key } = target;
    if (typeof id !== 'string' || id.length === 0) return false;
    if (typeof key !== 'string' || key.length === 0) return false;
    if (this.#inFlight.has(id)) return false;
    if (!needsBalanceRefresh({ usage: this.#pool.usageOf(id), nowMs: this.#now() })) return false;

    this.#inFlight.add(id);
    void Promise.resolve()
      .then(() => this.#refresh(id, key, { reason }))
      .catch(() => undefined)
      .finally(() => {
        this.#inFlight.delete(id);
      });
    return true;
  }

  /**
   * 扫一遍给定的密钥，把读数超龄的各自刷一次。
   *
   * 用于「用户刚往池里加了密钥」这条路径：新加入的密钥没有余额缓存，因此
   * {@link needsBalanceRefresh} 对它们一律为真，于是这一趟正好把新密钥补齐。池里
   * 本来就有余额的密钥不会被碰——这正是「其余 key 有余额信息就不调」。
   *
   * 一趟里**已经排上的那些不再排第二次**（去重集合在循环中途就生效），因此同一批里
   * 的重复 id 只问一次。
   *
   * @param targets - 候选密钥，每项 `{ id, key }`。
   * @param options - 本次刷新。
   * @param options.reason - 见 {@link BalanceRefresher#refreshIfStale}。
   * @returns 排出去的刷新条数。
   */
  sweep(targets, { reason }) {
    let started = 0;
    for (const target of Array.isArray(targets) ? targets : []) {
      if (this.refreshIfStale(target, { reason })) started += 1;
    }
    return started;
  }

  /**
   * 扫一遍**整池**，把从来没有过余额读数的密钥补齐（`USAGE-8`）。
   *
   * 这是「检查所有 key，对无余额信息的调一次 `/usage`」那条规则的落实点，挂在每次真的
   * 用到插件时（搜索与抓取各一次）。
   *
   * **只补「从来没有过读数」的**，不碰「读数偏旧」的：后者由
   * {@link BalanceRefresher#refreshIfStale} 针对**被选中的那把**处理。这个分界是有意的
   * ——余额未知的密钥在调度里垫底（`SCHED-2`），补齐它们能立刻改善排序；而为一池子
   * 余额已知、只是读数偏旧的密钥集体发问，是拿官方配额换一点点排序精度。
   *
   * 停用中的密钥跳过：它们不参与调度，问它们的余额没有用处。
   *
   * @param records - 池内全部记录（`{ id, key, disabled }`）。
   * @param options - 本次刷新。
   * @param options.reason - 见 {@link BalanceRefresher#refreshIfStale}。
   * @returns 排出去的刷新条数。
   */
  sweepUnread(records, { reason }) {
    let started = 0;
    for (const record of Array.isArray(records) ? records : []) {
      if (record?.disabled === true) continue;
      if (hasBalanceReading(this.#pool.usageOf(record?.id))) continue;
      if (this.refreshIfStale(record, { reason })) started += 1;
    }
    return started;
  }
}

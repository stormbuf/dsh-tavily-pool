/**
 * 调度：为一次请求从池中选出一把密钥。
 *
 * 与宿主零耦合（`COMPAT-1`）。本模块只做决策，不发请求、不解释响应、不判断失败——
 * 那些分别属于 `lib/attempts.js` 与 `lib/health.js`。
 *
 * 三条规则决定了这里的一切：
 *
 * - **余额优先**（`SCHED-2`）：三态排序，无限最前、未知垫底、其余按
 *   `max(0, limit - usage)`。
 * - **硬排除**（`SCHED-3`、`SCHED-8`）：冷却中的密钥与额度耗尽的密钥不进候选，
 *   即使池内其它密钥都不可用也不得选中它们。这里没有「放宽条件」的档位。
 * - **有界等待**（`SCHED-9`）：全部候选都在冷却时，等最早到期的那个结束再试；
 *   上限由调用方给出的等待截止时刻决定。
 *
 * @module dsh-tavily-pool/scheduler
 */

/**
 * 计算一把密钥的余额排名（`SCHED-2`）。数值越大越优先。
 *
 * 三态语义，一个都不能少：
 *
 * - **无限**（`limit === null`）→ `Infinity`，排最前。
 * - **未知**（从未成功刷新过、或响应里没有可用的 `limit`/`usage`）→ `-Infinity`，
 *   垫底。它不是零，也不是无限；把未知当作零会让一把从未用过的密钥永远排在最后，
 *   把未知当作无限则会让它插到已知余额充足的密钥前面。
 * - **已知**→ `max(0, limit - usage)`，用 `max` 容忍本地前推让 `usage` 略微越过
 *   `limit` 的情形。
 *
 * 余额缓存按 `/usage` 响应的原样存放（`{ key, account, fetchedAt, stale }`），排序
 * 只读 `key` 那一层：`account.plan_*` 对多把同账户密钥毫无区分度。
 *
 * @param usageEntry - 该密钥的余额缓存项；缺失表示从未刷新过。
 * @returns 排名数值，可能是 `±Infinity`。
 */
export function balanceRank(usageEntry) {
  const key = usageEntry?.key;
  if (key === null || typeof key !== 'object') return Number.NEGATIVE_INFINITY;
  // 无限必须在读 usage 之前判断：`limit` 为 null 时根本没有可比较的剩余量。
  if (key.limit === null) return Number.POSITIVE_INFINITY;
  if (typeof key.limit !== 'number' || !Number.isFinite(key.limit)) return Number.NEGATIVE_INFINITY;
  if (typeof key.usage !== 'number' || !Number.isFinite(key.usage)) return Number.NEGATIVE_INFINITY;
  return Math.max(0, key.limit - key.usage);
}

/**
 * 把候选按「余额降序，同档最近最少使用优先」排序（`SCHED-1`）。
 *
 * 同余额档内按**使用序号**升序打散——从未用过的（序号 0）排最前，因此一把新加的密钥
 * 不会因为「余额相同」而被永远压在后面。序号是单调的，所以两次选择之间必定可比；
 * 用它而不是时间戳，是因为毫秒精度在同一毫秒内会并列，而并列会让排序退回用户顺序，
 * 于是并发请求偏向排在前面的那把。
 *
 * 完全并列（例如都没用过）时按用户顺序定序，使结果只取决于输入，而不是 `sort` 的
 * 实现细节。
 *
 * @param entries - 候选，每项 `{ id, balance, lastUsedSeq, order }`。
 * @returns 排好序的新数组。
 */
export function rankCandidates(entries) {
  return [...entries].sort((left, right) => {
    if (left.balance !== right.balance) return right.balance - left.balance;
    const leftUsed = left.lastUsedSeq ?? 0;
    const rightUsed = right.lastUsedSeq ?? 0;
    if (leftUsed !== rightUsed) return leftUsed - rightUsed;
    return left.order - right.order;
  });
}

/**
 * 在 `ms` 毫秒后落定，或在 `signal` 中止时立即落定。
 *
 * 等待期间必须响应取消（`SCHED-9`）：模型取消一次搜索时，插件不能还抱着一个 30 秒
 * 的定时器不放。这里的 promise 只表示「等完了」，中止与到期的区别由调用方按
 * `signal.aborted` 自行判断。
 *
 * @param ms - 等待时长。
 * @param signal - 调用方取消信号。
 * @returns 等待结束的 promise。
 */
export function sleep(ms, signal) {
  return new Promise((resolve) => {
    if (signal?.aborted === true) {
      resolve();
      return;
    }
    const finish = () => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', finish);
      resolve();
    };
    const timer = setTimeout(finish, ms);
    signal?.addEventListener('abort', finish, { once: true });
  });
}

/**
 * 单进程内互斥（`SCHED-6`）。
 *
 * 关键约束是临界区**同步**：`#decide` 里没有任何 `await`，因此两个并发请求不可能各自
 * 读到同一份「谁最近被用过」的旧快照再各选一把。
 *
 * 于是这里有两道各自独立的保障，去掉任何一道都仍然成立——这是有意的，不是冗余：
 * 「决策是同步的」保证了**当下**不会交错；互斥保证了**将来**有人给决策加上 `await`
 * 时也不会交错。单靠前者，一次看似无害的重构就能悄悄破坏 `SCHED-6`；单靠后者，
 * 同步区间之外的状态读写会多绕一圈。
 *
 * 锁不覆盖网络调用，也不覆盖有界等待：前者会把并发搜索排成一条队，后者会让一次
 * 等待堵死所有请求。
 */
export class Mutex {
  #tail = Promise.resolve();

  /**
   * 串行执行一个同步函数。
   *
   * @param fn - 临界区；不得返回 promise（见类注释）。
   * @returns 该函数返回值的 promise。
   */
  runExclusive(fn) {
    const result = this.#tail.then(fn);
    // 链条自身永远落定为已兑现，因此一个抛错的临界区不会毒害后续调用方。
    this.#tail = result.then(() => undefined, () => undefined);
    return result;
  }
}

/**
 * 调度器：按余额优先从池中选密钥，并把冷却、额度耗尽、永久失效、停用四类硬排除
 * 在候选之外。
 */
export class Scheduler {
  #pool;
  #health;
  #now;
  #sleep;
  #mutex = new Mutex();

  /**
   * @param options - 协作者。
   * @param options.pool - 密钥池，提供 `keysInOrder()`。
   * @param options.health - 健康状态，提供 `snapshotOf()` 与 `markSelected()`。
   * @param options.now - 当前时刻，测试时可注入。
   * @param options.sleep - 等待实现，测试时可注入。
   */
  constructor({ pool, health, now = Date.now, sleep: wait = sleep }) {
    this.#pool = pool;
    this.#health = health;
    this.#now = now;
    this.#sleep = wait;
  }

  /**
   * 选出一把密钥（`SCHED-1`、`SCHED-2`、`SCHED-3`、`SCHED-8`、`SCHED-9`）。
   *
   * 全部候选都在冷却时在这里等到最早到期的那个结束——但**仅当那一刻落在预算之内**。
   * 等一个到不了的到期时刻是有害的：它不会让任何请求成功，只是把失败推迟到预算耗尽，
   * 而 `REST-10` 要求此时尽快透穿最后一个真实的上游错误响应。
   *
   * `waitDeadlineMs` 是调用方给出的绝对时刻，过了它就不再等待；等待预算怎么折算属于
   * 调用方（见 `lib/attempts.js`），调度器只负责「等到什么时候还可以等」。
   *
   * @param options - 本次选择。
   * @param options.signal - 调用方取消信号；等待期间响应它。
   * @param options.exclude - 本次请求里已经试过的密钥 id；它们不再作为候选，也**不再
   *   构成等待的理由**——等一把刚刚失败的密钥再试一次，只会把失败推迟。
   * @param options.waitDeadlineMs - 允许等待到的最晚时刻；省略表示不等待。
   * @returns `{ key }`，或被阻塞的 `{ blocked, waitUntilMs? }`。
   *   `blocked` 取 `'no-keys'`（池中无启用的密钥）、`'all-unusable'`（全部额度耗尽或
   *   永久失效）、`'exhausted-attempts'`（本次请求允许试的都试过了）、`'cooling'`
   *   （全部处于冷却且等到期不值得）、`'aborted'`。
   */
  async select({ signal, exclude, waitDeadlineMs } = {}) {
    for (;;) {
      const outcome = await this.#mutex.runExclusive(() => this.#decide(exclude));
      if (outcome.key !== undefined) return outcome;
      if (outcome.blocked !== 'cooling') return outcome;

      const nowMs = this.#now();
      const allowedUntil = waitDeadlineMs ?? nowMs;
      if (outcome.waitUntilMs === undefined || outcome.waitUntilMs > allowedUntil) return outcome;

      await this.#sleep(outcome.waitUntilMs - nowMs, signal);
      if (signal?.aborted === true) return { blocked: 'aborted' };
    }
  }

  /**
   * 一次同步决策，在互斥区内执行。
   *
   * 被选中的密钥会立刻在内存里记上 `lastUsedAt`：下一个并发请求因此看到它「刚被用
   * 过」，从而选另一把同余额档的密钥——这正是 `SCHED-1` 的轮转，也是 `SCHED-6` 要
   * 防的重复选中。落盘是排队进行的，不参与决策。
   *
   * @param exclude - 本次请求里已经试过的密钥 id。
   */
  #decide(exclude) {
    const nowMs = this.#now();
    const candidates = [];
    const cooling = [];
    let enabled = 0;
    let retryable = 0;

    const records = this.#pool.keysInOrder();
    records.forEach((record, order) => {
      if (record.disabled === true) return;
      enabled += 1;
      // 本次请求里已经试过它：再试一次是原地重复，等待它更只是把失败推迟。
      if (exclude?.has(record.id) === true) return;
      retryable += 1;
      const state = this.#health.snapshotOf(record.id, nowMs);
      if (state.permanentlyInvalid || state.quotaExhausted) return;
      if (state.cooling) {
        cooling.push(record.id);
        return;
      }
      candidates.push({
        id: record.id,
        key: record.key,
        order,
        balance: balanceRank(state.usage),
        lastUsedSeq: state.lastUsedSeq,
      });
    });

    if (candidates.length > 0) {
      const [chosen] = rankCandidates(candidates);
      this.#health.markSelected(chosen.id, nowMs);
      return { key: { id: chosen.id, key: chosen.key } };
    }

    // 没有任何候选可用。只有冷却这一类的恢复时间在本次请求内是已知且有限的，因此
    // 只有它值得等；额度耗尽可能要等到下月 1 日，永久失效永不恢复。
    if (cooling.length > 0) {
      const waitUntilMs = this.#health.earliestCooldownExpiry(cooling, nowMs);
      return { blocked: 'cooling', waitUntilMs };
    }
    if (enabled === 0) return { blocked: 'no-keys' };
    if (retryable === 0) return { blocked: 'exhausted-attempts' };
    return { blocked: 'all-unusable' };
  }
}

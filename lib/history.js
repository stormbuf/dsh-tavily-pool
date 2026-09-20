/**
 * 调用历史：每次 Tavily 调用的可查记录（`14`）。
 *
 * 与宿主零耦合（`COMPAT-1`）：状态目录与文件系统操作都是注入的，因此本模块能在
 * `node:test` 下针对临时目录运行，且永远不需要知道 `~/.dsh` 在哪。
 *
 * ## 为什么是独立文件而不是 `keys.json` 里的一个数组
 *
 * 历史是**追加**型的，密钥池是**整体重写**型的：两者混在一个文件里，一次调用就要重写整份
 * 密钥池（含每把密钥的统计、余额缓存与用户排序），而一次密钥编辑也要带上整段历史。分开之后
 * 各自的写入频率与体积增长互不牵连，且 `keys.json` 的形状不必为历史改版。
 *
 * ## 裁剪策略（ticket `14` 的那条「未决」）
 *
 * 两条约束**同时**生效，取更严的那个：
 *
 * 1. **条数上限**（{@link HISTORY_MAX_ENTRIES}）：防止高频使用把文件写爆；
 * 2. **时间窗口**（{@link HISTORY_RETENTION_MS}）：防止低频使用时一份半年前的记录永远占着
 *    位置。
 *
 * 裁剪发生在**每次写入时**，而不是某个后台任务里：没有定时器要管，也没有「进程刚好退出在
 * 两次裁剪之间」的窗口。代价是每次追加都会扫一遍数组，而它最多 500 项。
 *
 * ## 写失败不抛错
 *
 * 与统计落盘同一条理由：历史是**记录**，不是正确性前提。写不进去只会让面板少一段曲线，
 * 绝不该让一次搜索失败。失败记在 {@link CallHistory#lastWriteError} 上，由调用方上报一次。
 *
 * ## 跨实例的排他（ticket `22` C2）
 *
 * 一次追加必须在**落盘那一刻**排他地完成「读盘 → 并入本次记录 → 写回」：`#writeChain` 只
 * 保证同一个实例内的顺序，两个实例（两个共享同一个 `~/.dsh` 的 DSH 进程，或热重载期间新旧
 * 交叠）各自的「读盘」与「rename」两个窗口一旦重叠，后一次 rename 就会盖掉前一次——实测
 * 5/5 丢一条，而两边都报成功。排他因此落在文件系统上：`.lock` 文件（见
 * {@link HISTORY_LOCK_SUFFIX}）以 `wx`（即 `O_CREAT | O_EXCL`）创建，拿不到就短暂退避重试；
 * 读改写全程持锁，写完（成功或失败）都释放。
 *
 * @module dsh-tavily-pool/history
 */

import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

import { HISTORY_MAX_ENTRIES, HISTORY_RETENTION_MS } from './constants.js';

/** 历史文档的 schema 版本。 */
export const HISTORY_SCHEMA_VERSION = 1;

/** 排他锁的文件名后缀：`history.json` 的锁是 `history.json.lock`。 */
export const HISTORY_LOCK_SUFFIX = '.lock';

/**
 * 抢锁的总预算（毫秒）。
 *
 * 上限而不是等待目标：拿不到就如实报失败，绝不两边都报成功。`index.js` 刻意不 `await`
 * 一次追加，因此这个预算也是「追加在后台最多占多久」的上限。
 */
export const HISTORY_LOCK_TIMEOUT_MS = 2000;

/**
 * 锁被视为**陈旧**的年龄（毫秒）。
 *
 * 写锁的进程崩溃时锁文件会留在磁盘上，没有这条规则后续追加会永远失败。锁的实际持有时间是
 * 一次小文件的读改写（毫秒级），因此这个阈值取比它高三个数量级的值。
 */
export const HISTORY_LOCK_STALE_MS = 10_000;

/** 抢锁失败后的首次退避（毫秒）。 */
const LOCK_RETRY_DELAY_MS = 5;

/** 退避的上限（毫秒）：指数增长到它为止，免得把预算全花在几次长等待上。 */
const LOCK_RETRY_DELAY_MAX_MS = 50;

/**
 * 记录里允许出现的端点。
 *
 * 白名单而不是自由字符串：面板按它分组画曲线，一个拼错的端点会静默变成第三条曲线。
 */
export const HISTORY_ENDPOINTS = Object.freeze(['search', 'extract']);

/**
 * 一次调用的记录。
 *
 * @typedef {object} CallRecord
 * @property {string} at - ISO-8601 时刻。
 * @property {string} endpoint - `search` 或 `extract`。
 * @property {string} keyId - 发起这次调用的密钥 id。
 * @property {string} keyMasked - 当时的脱敏形式；留着它是为了密钥被删掉之后这条记录仍然可读。
 * @property {'ok'|'failed'} outcome - 这次调用成没成。
 * @property {number|undefined} successfulUrls - 这次抓取成功了多少个 URL。
 *   抓取时它是累计档位算出来的（常常是 0），因此另配 `successfulUrls` 给出原始事实。
 * @property {number|undefined} successfulUrls - 抓取这次成功了几个 URL；搜索路径上没有这一项。
 * @property {number} durationMs - 耗时。
 * @property {number|undefined} status - 上游 HTTP 状态码，失败时才有。
 * @property {string|undefined} code - 机器码，失败时才有。
 * @property {string|undefined} requestId - 上游的 `request_id`，排障时凭它向 Tavily 追问。
 */

/** 一份全新的、合法的历史文档。 */
export function emptyHistory() {
  return { version: HISTORY_SCHEMA_VERSION, entries: [] };
}

/** 判断值是否为普通对象（非数组、非 null）。 */
function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/**
 * 校验解码后的历史文档。
 *
 * 对「这条记录还能不能画图」严格，对**未来**新增字段宽松——与 `validatePool` 同一套取舍：
 * 被更新版本写出的文件不该仅仅因为多带了数据就被丢弃。坏掉的**条目**被丢掉而不是让整个
 * 文件失效：一条读不出来的记录不该让用户丢掉其余几百条。
 *
 * **但已废弃的字段会被丢掉。** 这里逐字段重建记录而不是 `...entry` 展开：旧版本写下的
 * `credits` 因此不会随读盘回到内存，下次写盘时那个字段就永久消失了（2026-09-20 决定——
 * 插件不再统计自身消耗积分）。用展开的话，一份旧文件会在每次追加时把 `credits` 原样带
 * 回去，迁移永远不会发生。
 *
 * @param value - 解码后的 JSON 值。
 * @returns 通过校验的文档。
 * @throws {TypeError} 整体形状不是历史文档时抛出。
 */
export function validateHistory(value) {
  if (!isPlainObject(value)) throw new TypeError('history document must be a JSON object');
  if (value.version !== HISTORY_SCHEMA_VERSION) {
    throw new TypeError(`history document version ${String(value.version)} is not ${String(HISTORY_SCHEMA_VERSION)}`);
  }
  if (!Array.isArray(value.entries)) throw new TypeError('history document "entries" must be an array');

  const entries = [];
  for (const entry of value.entries) {
    if (!isPlainObject(entry)) continue;
    if (typeof entry.at !== 'string' || Number.isNaN(Date.parse(entry.at))) continue;
    if (!HISTORY_ENDPOINTS.includes(entry.endpoint)) continue;
    if (typeof entry.keyId !== 'string' || entry.keyId.length === 0) continue;
    // 逐字段重建：白名单之外的键（含已废弃的 `credits`）在这里被丢掉。
    const record = {
      at: entry.at,
      endpoint: entry.endpoint,
      keyId: entry.keyId,
      outcome: entry.outcome === 'ok' ? 'ok' : 'failed',
    };
    if (typeof entry.keyMasked === 'string') record.keyMasked = entry.keyMasked;
    if (Number.isFinite(entry.durationMs)) record.durationMs = entry.durationMs;
    if (Number.isInteger(entry.successfulUrls) && entry.successfulUrls >= 0) record.successfulUrls = entry.successfulUrls;
    if (Number.isInteger(entry.status)) record.status = entry.status;
    if (typeof entry.code === 'string' && entry.code.length > 0) record.code = entry.code;
    if (typeof entry.requestId === 'string' && entry.requestId.length > 0) record.requestId = entry.requestId;
    entries.push(record);
  }
  return { version: HISTORY_SCHEMA_VERSION, entries };
}

/**
 * 按条数与时间窗口裁掉最旧的记录（`14`）。
 *
 * 纯函数，因此裁剪策略本身可以脱离文件系统覆盖——它是这张票当初唯一的「未决」，值得
 * 单独钉住。
 *
 * 时间窗口用**最新一条**的时刻做基准而不是 `now`：进程的时钟与记录下来的时刻若有偏差
 * （用户改过系统时间、或文件是从别处复制来的），用 `now` 会把整份历史一次清空。
 *
 * 输入理应按时间升序（`append` 追加在尾部），但**先排一遍再裁**：一份被外部编辑过、或由别的
 * 工具写出的历史文件可以不是升序，而那时「以最新一条为基准」会按错误的基准算窗口。排序让这条
 * 策略与输入顺序无关，代价是每次写入多一趟 O(n log n)，而 n 最多 500。
 *
 * @param entries - 记录。
 * @param options - 裁剪参数。
 * @param options.maxEntries - 条数上限。
 * @param options.retentionMs - 时间窗口。
 * @returns 裁剪后的新数组，按时间升序。
 */
export function pruneHistory(entries, { maxEntries = HISTORY_MAX_ENTRIES, retentionMs = HISTORY_RETENTION_MS } = {}) {
  if (entries.length === 0) return [];
  const ordered = [...entries].sort((left, right) => Date.parse(left.at) - Date.parse(right.at));
  const newest = Date.parse(ordered[ordered.length - 1].at);
  const cutoff = newest - retentionMs;
  const withinWindow = ordered.filter((entry) => Date.parse(entry.at) >= cutoff);
  return withinWindow.length > maxEntries ? withinWindow.slice(withinWindow.length - maxEntries) : withinWindow;
}

/**
 * 把一条记录压成要落盘的对象。
 *
 * 只带白名单里的字段：调用方传进来的东西不原样进文件，否则一次重构多带的一个字段会悄悄
 * 进入用户的磁盘，而历史是长期留存的数据。
 *
 * @param entry - 调用方给的事实。
 * @param options - 落盘时的补充。
 * @param options.nowMs - 当前时刻。
 * @returns 可 JSON 序列化的记录。
 */
export function normalizeRecord(entry, { nowMs = Date.now() } = {}) {
  const record = {
    at: new Date(nowMs).toISOString(),
    endpoint: HISTORY_ENDPOINTS.includes(entry?.endpoint) ? entry.endpoint : 'search',
    keyId: typeof entry?.keyId === 'string' ? entry.keyId : '',
    keyMasked: typeof entry?.keyMasked === 'string' ? entry.keyMasked : '',
    outcome: entry?.outcome === 'ok' ? 'ok' : 'failed',
    durationMs: Number.isFinite(entry?.durationMs) ? Math.max(0, Math.round(entry.durationMs)) : 0,
  };
  // ⚠️ **没有 `credits` 字段**（2026-09-20 决定）。插件不再统计自身消耗积分：积分规则由
  // 上游随时可能更改，任何自算的数字都可能在某次规则调整后变成误导。面板与设置页只展示
  // `/usage` 的官方余额，而余额是「上限 − 已用」两个官方数字之差，不经过本地估算。
  //
  // 旧版本写下的 `credits` 不会原样保留：本函数是白名单式的，读到旧文件再写回时那个字段
  // 自然消失（`validateHistory` 同样不认它）。历史文件因此在下次追加时自动完成迁移。
  //
  // 抓取这一次成功了几个 URL 仍然保留：它是关于这次调用的事实（抓到了几个页面），不是
  // 任何积分估算的产物，排障时用得上。
  if (Number.isInteger(entry?.successfulUrls) && entry.successfulUrls >= 0) record.successfulUrls = entry.successfulUrls;
  if (Number.isInteger(entry?.status)) record.status = entry.status;
  if (typeof entry?.code === 'string' && entry.code.length > 0) record.code = entry.code;
  // `request_id` 是排障时向 Tavily 支持追问的凭据，因此只要上游给了就留下。
  if (typeof entry?.requestId === 'string' && entry.requestId.length > 0) record.requestId = entry.requestId;
  return record;
}

/**
 * 调用历史存储：追加一条、按策略裁剪、原子写入。
 *
 * 写入串行经过同一条 promise 链（与 `PoolStore` 同一手法），因此**同一个实例**上的两次并发
 * 追加不会交错成一份只写了一半的文件；每次写入先落临时文件再 rename 覆盖，中途被打断留下的
 * 是完整的旧文件。
 *
 * **不在内存里长期持有**：每次追加都读一次盘再写回。这与 `PoolStore` 的做法不同，而差别来自
 * 数据本身——密钥池是调度的输入，必须立刻可见；历史只被面板读，晚一次写入没有任何影响。
 *
 * **每次追加都排他**：读盘与 rename 之间不能有别的实例插进来（`#writeChain` 只管本实例）。
 * 因此这一对动作在 {@link CallHistory#append} 的同一个临界区里完成，临界区由
 * `history.json.lock` 这个以 `O_EXCL` 创建的文件守着——两个共享同一个 `~/.dsh` 的进程、
 * 或热重载期间新旧交叠的两个实例，都不会再互相覆盖出一份谁都不完整的历史。
 *
 * 抢锁最多等 {@link HISTORY_LOCK_TIMEOUT_MS} 毫秒，退避从 `LOCK_RETRY_DELAY_MS` 起
 * 指数增长到 `LOCK_RETRY_DELAY_MAX_MS`。超时就**如实失败**：记进
 * {@link lastWriteError} 并让 `append` 返回 `false`——一次没有写进去的追加绝不能报成功。
 * 崩溃留下的锁按年龄作废（{@link HISTORY_LOCK_STALE_MS}），否则一次崩溃会让此后每一次追加
 * 都永远失败。
 */
export class CallHistory {
  #filePath;
  #lockPath;
  #fs;
  #now;
  #writeChain = Promise.resolve();

  /**
   * 最近一次写入失败。
   *
   * 仅供展示：历史写不进去不影响调用是否可用，但用户应当能看见「记录没有被留下」。
   */
  lastWriteError;

  /**
   * @param options - 存储位置与文件系统接缝。
   * @param options.dir - 解析后的状态目录；绝不硬编码（`DOC-4`）。
   * @param options.fileName - `dir` 内的历史文件名。
   * @param options.fs - 文件系统操作，测试时可注入。
   * @param options.now - 当前时刻，测试时可注入。
   * @param options.maxEntries - 条数上限，测试时可注入。
   * @param options.retentionMs - 时间窗口，测试时可注入。
   * @param options.lockTimeoutMs - 抢锁预算，测试时可注入。
   */
  constructor({
    dir,
    fileName,
    fs = { mkdir, readFile, rename, unlink, writeFile },
    now = Date.now,
    maxEntries = HISTORY_MAX_ENTRIES,
    retentionMs = HISTORY_RETENTION_MS,
    lockTimeoutMs = HISTORY_LOCK_TIMEOUT_MS,
  }) {
    this.#filePath = join(dir, fileName);
    this.#lockPath = `${this.#filePath}${HISTORY_LOCK_SUFFIX}`;
    this.#fs = fs;
    this.#now = now;
    this.maxEntries = maxEntries;
    this.retentionMs = retentionMs;
    this.lockTimeoutMs = lockTimeoutMs;
  }

  /** 历史文件的绝对路径。 */
  get filePath() {
    return this.#filePath;
  }

  /** 排他锁的路径。 */
  get lockPath() {
    return this.#lockPath;
  }

  /**
   * 读回全部记录，按时间升序。
   *
   * 文件不存在（从未调用过）、内容坏掉或版本不认识时都返回空数组：历史是展示用的，绝不能让
   * 它把面板变成一片 500。坏掉这件事经 {@link readError} 如实报告。
   *
   * @returns 记录数组。
   */
  async read() {
    let raw;
    try {
      raw = await this.#fs.readFile(this.#filePath, 'utf8');
    } catch (error) {
      this.readError = error?.code === 'ENOENT' ? undefined : error;
      return [];
    }
    try {
      const decoded = validateHistory(JSON.parse(raw));
      this.readError = undefined;
      return decoded.entries;
    } catch (error) {
      this.readError = error;
      return [];
    }
  }

  /**
   * 读回最近 `limit` 条，**最新的在前**。
   *
   * 面板要的是这个方向，而在这里反转比让客户端反转更省事：客户端是零构建产物，能少一段
   * 逻辑就少一段。
   *
   * @param limit - 最多返回多少条。
   * @returns 记录数组，最新的在前。
   */
  async recent(limit) {
    const entries = await this.read();
    const tail = Number.isInteger(limit) && limit > 0 ? entries.slice(-limit) : entries;
    return tail.reverse();
  }

  /**
   * 追加一条记录，并按裁剪策略写回。
   *
   * **落盘那一刻才读盘**：读回来的就是磁盘上的最新内容，本次记录并进它，再原样写回——因此
   * 别的实例在本次进入 `append` 之后写下的记录不会被这次写入抹掉。整个「读 → 并 → 写」在
   * 排他锁里完成（见类注释）。
   *
   * **写失败不抛错**：失败记在 {@link lastWriteError} 上，调用方（`index.js`）在本次调用结束
   * 之后把它上报一次。一次搜索不该因为「历史没记上」而失败。抢不到锁同样走这条路：它是一
   * 次**没有发生**的写入，因此返回 `false`，绝不报成功。
   *
   * @param entry - 调用方给的事实；见 {@link normalizeRecord}。
   * @returns 落盘完成的 promise；失败时也兑现。
   */
  async append(entry) {
    const record = normalizeRecord(entry, { nowMs: this.#now() });
    if (record.keyId.length === 0) return false;

    return this.#enqueue(async () => {
      const release = await this.#acquireLock();
      try {
        const existing = await this.read();
        const next = pruneHistory([...existing, record], {
          maxEntries: this.maxEntries,
          retentionMs: this.retentionMs,
        });
        await this.#persist({ version: HISTORY_SCHEMA_VERSION, entries: next });
      } finally {
        await release();
      }
    });
  }

  /**
   * 以 `O_EXCL` 创建锁文件，拿到才返回。
   *
   * `wx` 就是 `O_CREAT | O_EXCL | O_WRONLY`：创建成功即持锁，`EEXIST` 即被别人持有——判据
   * 是内核给的，不靠任何约定。退避重试到 {@link CallHistory#lockTimeoutMs} 为止，超时抛一个
   * 带 `code = 'ELOCKED'` 的错误，由 {@link CallHistory#append} 如实记成写失败。
   *
   * @returns 释放锁的函数；调用它不会抛错（发布锁失败不该盖住本次写入的结果）。
   */
  async #acquireLock() {
    // **先确保目录在。** 抢锁发生在 {@link CallHistory#persist} 之前，而建目录原本是那边的
    // 事——于是一个全新的状态目录上第一次追加会以 `ENOENT` 失败，而 `#persist` 的 `mkdir`
    // 从来没机会跑到（ticket `22` 的真机实测发现：真机上「一次真实搜索之后历史是空的」）。
    // `recursive: true` 让两个实例同时建同一个目录也不冲突。
    await this.#fs.mkdir(dirname(this.#filePath), { recursive: true, mode: 0o700 });

    // 锁的时间一律取真实时间，不走注入的 `now`：注入的时钟是给记录时间戳用的（测试会把它
    // 冻住），拿它算重试预算会让冻结的时钟得到一个永不到期的截止时刻。
    const deadline = Date.now() + this.lockTimeoutMs;
    let delay = LOCK_RETRY_DELAY_MS;

    for (;;) {
      try {
        await this.#fs.writeFile(this.#lockPath, `${JSON.stringify({ pid: process.pid, at: new Date().toISOString() })}\n`, {
          encoding: 'utf8',
          flag: 'wx',
          mode: 0o600,
        });
        return async () => {
          await this.#fs.unlink(this.#lockPath).catch(() => undefined);
        };
      } catch (error) {
        if (error?.code !== 'EEXIST') throw error;
      }

      // 抢不到：要么是另一个实例正在写，要么是一个崩掉的进程留下的死锁。
      if (await this.#dropStaleLock()) continue;
      if (Date.now() >= deadline) {
        const error = new Error(`could not acquire ${this.#lockPath} within ${String(this.lockTimeoutMs)}ms`);
        error.code = 'ELOCKED';
        throw error;
      }
      await new Promise((resolve) => {
        setTimeout(resolve, delay);
      });
      delay = Math.min(delay * 2, LOCK_RETRY_DELAY_MAX_MS);
    }
  }

  /**
   * 锁文件老到不可能是活着的写者时把它删掉。
   *
   * 读不出来、或读出来不像我们写的锁，一律按「还锁着」处理：宁可等，也不去删一个来路不明
   * 的文件。时间戳不可解析时同样按还锁着处理。
   *
   * @returns 是否刚刚删掉了一个陈旧的锁。
   */
  async #dropStaleLock() {
    let held;
    try {
      held = JSON.parse(await this.#fs.readFile(this.#lockPath, 'utf8'));
    } catch {
      return false;
    }
    const heldAt = Date.parse(held?.at);
    if (Number.isNaN(heldAt) || Date.now() - heldAt < HISTORY_LOCK_STALE_MS) return false;

    await this.#fs.unlink(this.#lockPath).catch(() => undefined);
    return true;
  }

  /** 把「读当前文档 → 改 → 写」排到串行队列末尾。 */
  #enqueue(work) {
    const result = this.#writeChain.then(work, work);
    this.#writeChain = result.then(() => undefined, () => undefined);
    return result.then(
      () => {
        this.lastWriteError = undefined;
        return true;
      },
      (error) => {
        this.lastWriteError = error;
        return false;
      },
    );
  }

  /** 先写临时文件，再原子 rename 落盘。 */
  async #persist(document) {
    await this.#fs.mkdir(dirname(this.#filePath), { recursive: true, mode: 0o700 });
    const temporary = `${this.#filePath}.${String(process.pid)}.${randomUUID()}.tmp`;
    try {
      await this.#fs.writeFile(temporary, `${JSON.stringify(document, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
      await this.#fs.rename(temporary, this.#filePath);
    } catch (error) {
      // 否则每次重试都会把失败写入留下的临时文件攒在目录里。
      await this.#fs.unlink(temporary).catch(() => undefined);
      throw error;
    }
  }
}

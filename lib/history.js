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
 * @module dsh-tavily-pool/history
 */

import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

import { HISTORY_MAX_ENTRIES, HISTORY_RETENTION_MS } from './constants.js';

/** 历史文档的 schema 版本。 */
export const HISTORY_SCHEMA_VERSION = 1;

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
 * @property {number|undefined} credits - 这次调用消耗的积分；`undefined` 表示未知（`REST-3`）。
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
 * 对「这条记录还能不能画图」严格，对新增字段宽松——与 `validatePool` 同一套取舍：被更新
 * 版本写出的文件不该仅仅因为多带了数据就被丢弃。坏掉的**条目**被丢掉而不是让整个文件失效：
 * 一条读不出来的记录不该让用户丢掉其余几百条。
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
    entries.push({
      ...entry,
      outcome: entry.outcome === 'ok' ? 'ok' : 'failed',
    });
  }
  return { version: HISTORY_SCHEMA_VERSION, entries };
}

/**
 * 按条数与时间窗口裁掉最旧的记录（`14`）。
 *
 * 纯函数，因此裁剪策略本身可以脱离文件系统覆盖——它是这张票当初唯一的「未决」，值得
 * 单独钉住。
 *
 * 输入按**时间升序**，输出亦然。时间窗口用**最新一条**的时刻做基准而不是 `now`：进程的时钟
 * 与记录下来的时刻若有偏差（用户改过系统时间、或文件是从别处复制来的），用 `now` 会把整份
 * 历史一次清空。
 *
 * @param entries - 记录，按时间升序。
 * @param options - 裁剪参数。
 * @param options.maxEntries - 条数上限。
 * @param options.retentionMs - 时间窗口。
 * @returns 裁剪后的新数组。
 */
export function pruneHistory(entries, { maxEntries = HISTORY_MAX_ENTRIES, retentionMs = HISTORY_RETENTION_MS } = {}) {
  if (entries.length === 0) return [];
  const newest = Date.parse(entries[entries.length - 1].at);
  const cutoff = newest - retentionMs;
  const withinWindow = entries.filter((entry) => Date.parse(entry.at) >= cutoff);
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
  // 「不知道消耗了多少」与「本次没消耗」必须区分得开（`REST-3`），因此在文件里也保持这个
  // 区分：未知就没有 `credits` 这个键，而不是 `credits: 0`。
  if (typeof entry?.credits === 'number' && Number.isFinite(entry.credits)) record.credits = entry.credits;
  if (Number.isInteger(entry?.status)) record.status = entry.status;
  if (typeof entry?.code === 'string' && entry.code.length > 0) record.code = entry.code;
  // `request_id` 是排障时向 Tavily 支持追问的凭据，因此只要上游给了就留下。
  if (typeof entry?.requestId === 'string' && entry.requestId.length > 0) record.requestId = entry.requestId;
  return record;
}

/**
 * 调用历史存储：追加一条、按策略裁剪、原子写入。
 *
 * 写入串行经过同一条 promise 链（与 `PoolStore` 同一手法），因此两次并发追加不会交错成一份
 * 只写了一半的文件；每次写入先落临时文件再 rename 覆盖，中途被打断留下的是完整的旧文件。
 *
 * **不在内存里长期持有**：每次追加都读一次盘再写回。这与 `PoolStore` 的做法不同，而差别来自
 * 数据本身——密钥池是调度的输入，必须立刻可见；历史只被面板读，晚一次写入没有任何影响，而
 * 「永远从磁盘读」让多个进程（例如用户在两个 profile 里各跑一个实例）不会互相覆盖出一份
 * 谁都不完整的历史。
 */
export class CallHistory {
  #filePath;
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
   */
  constructor({
    dir,
    fileName,
    fs = { mkdir, readFile, rename, unlink, writeFile },
    now = Date.now,
    maxEntries = HISTORY_MAX_ENTRIES,
    retentionMs = HISTORY_RETENTION_MS,
  }) {
    this.#filePath = join(dir, fileName);
    this.#fs = fs;
    this.#now = now;
    this.maxEntries = maxEntries;
    this.retentionMs = retentionMs;
  }

  /** 历史文件的绝对路径。 */
  get filePath() {
    return this.#filePath;
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
   * **写失败不抛错**：失败记在 {@link lastWriteError} 上，调用方（`index.js`）在本次调用结束
   * 之后把它上报一次。一次搜索不该因为「历史没记上」而失败。
   *
   * @param entry - 调用方给的事实；见 {@link normalizeRecord}。
   * @returns 落盘完成的 promise；失败时也兑现。
   */
  async append(entry) {
    const record = normalizeRecord(entry, { nowMs: this.#now() });
    if (record.keyId.length === 0) return false;

    return this.#enqueue(async () => {
      const existing = await this.read();
      const next = pruneHistory([...existing, record], {
        maxEntries: this.maxEntries,
        retentionMs: this.retentionMs,
      });
      await this.#persist({ version: HISTORY_SCHEMA_VERSION, entries: next });
    });
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

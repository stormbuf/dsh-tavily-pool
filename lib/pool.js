/**
 * 密钥池持久化。
 *
 * 与宿主零耦合（`COMPAT-1`）：状态目录与文件系统操作都是注入的，因此本模块能在
 * `node:test` 下针对临时目录运行，且永远不需要知道 `~/.dsh` 在哪。
 *
 * 这里是 issue `01` 所需的子集——加载密钥池、原子写入、给出可用的第一把密钥。
 * 脱敏、完整的编辑接口、配额缓存与面板 HTTP 接口分别属于 issue `02`、`06`、`09`。
 *
 * @module dsh-tavily-pool/pool
 */

import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

/** 密钥池文档的 schema 版本。 */
export const POOL_SCHEMA_VERSION = 1;

/**
 * 脱敏时保留可见的前导字符数。
 *
 * `tvly-` 加几个字符足以让人分辨两把密钥，又远不足以当作凭据使用。
 */
const MASK_PREFIX_CHARS = 9;

/** 脱敏时保留可见的尾部字符数。 */
const MASK_SUFFIX_CHARS = 4;

/**
 * 为所有非本地文件的出口脱敏（`POOL-3`）。
 *
 * 短到前缀与后缀会重叠的密钥整体脱敏，而不是部分泄露：没有任何办法安全地展示
 * 它的一部分，而短字符串恰恰是「前缀」会占掉大半密钥的情形。
 *
 * @param key - 明文密钥。
 * @returns 脱敏形式，例如 `tvly-dev-…aV2i`。
 */
export function maskKey(key) {
  if (typeof key !== 'string' || key.length === 0) return '';
  if (key.length <= MASK_PREFIX_CHARS + MASK_SUFFIX_CHARS) return `${key.slice(0, 2)}…${key.slice(-1)}`;
  return `${key.slice(0, MASK_PREFIX_CHARS)}…${key.slice(-MASK_SUFFIX_CHARS)}`;
}

/** 一份全新的、合法的密钥池文档。 */
export function emptyPool() {
  return { version: POOL_SCHEMA_VERSION, keys: [], order: [], stats: {}, usageCache: {} };
}

/** 判断值是否为普通对象（非数组、非 null）。 */
function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/**
 * 密钥池文件存在但不可信时记录的错误。
 *
 * 只上报、不抛出（`POOL-7`）：损坏的文件绝不能让插件加载失败。以空池启动仍是一个
 * 能用的插件，而拒绝加载的插件会把搜索一起拖下水。
 */
export class PoolFileError extends Error {
  /**
   * @param message - 文件哪里出了问题。
   * @param path - 出问题的文件。
   * @param options - 失败事实。
   * @param options.reason - `'unreadable'` 或 `'malformed'`。
   * @param options.cause - 解码或校验错误。
   */
  constructor(message, path, options = {}) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = 'PoolFileError';
    this.path = path;
    this.reason = options.reason ?? 'malformed';
  }
}

/**
 * 校验解码后的密钥池文档。
 *
 * 对后续代码按 id 索引的部分严格，对新增字段宽松，这样由更新版本写出的文件不会
 * 仅仅因为多带了数据就被丢弃。
 *
 * @param value - 解码后的 JSON 值。
 * @returns 通过校验的文档。
 * @throws {TypeError} 形状不是密钥池文档时抛出。
 */
export function validatePool(value) {
  if (!isPlainObject(value)) throw new TypeError('pool document must be a JSON object');
  if (value.version !== POOL_SCHEMA_VERSION) {
    throw new TypeError(`pool document version ${String(value.version)} is not ${String(POOL_SCHEMA_VERSION)}`);
  }
  if (!Array.isArray(value.keys)) throw new TypeError('pool document "keys" must be an array');
  if (!Array.isArray(value.order)) throw new TypeError('pool document "order" must be an array');

  const keys = value.keys.map((entry, index) => {
    if (!isPlainObject(entry)) throw new TypeError(`pool key #${String(index)} must be an object`);
    if (typeof entry.id !== 'string' || entry.id.length === 0) {
      throw new TypeError(`pool key #${String(index)} has no id`);
    }
    if (typeof entry.key !== 'string' || entry.key.length === 0) {
      throw new TypeError(`pool key #${String(index)} has no key`);
    }
    return { ...entry, disabled: entry.disabled === true };
  });

  // 缺失或过期的 order 项被修复而不是拒绝：顺序是展示偏好，不是数据完整性事实，
  // 为它拒掉整个文件等于把用户的密钥丢掉。
  const ids = new Set(keys.map((entry) => entry.id));
  const order = value.order.filter((id, index) => ids.has(id) && value.order.indexOf(id) === index);
  for (const entry of keys) if (!order.includes(entry.id)) order.push(entry.id);

  return {
    version: POOL_SCHEMA_VERSION,
    keys,
    order,
    stats: isPlainObject(value.stats) ? value.stats : {},
    usageCache: isPlainObject(value.usageCache) ? value.usageCache : {},
  };
}

/**
 * 密钥池存储：加载一次、原子写入、按顺序给出密钥。
 *
 * 写入串行经过同一条 promise 链，因此两次并发编辑不会交错成一份只应用了一半的
 * 文件；每次写入都先落到临时文件，再 rename 覆盖目标（`POOL-6`）。同目录内的
 * rename 是原子的，所以中途被打断的写入会留下完整的旧文件，而不会留下截断的新文件。
 */
export class PoolStore {
  #filePath;
  #document = emptyPool();
  #loadError;
  #writeChain = Promise.resolve();

  /**
   * @param options - 存储位置与文件系统接缝。
   * @param options.dir - 解析后的状态目录；绝不硬编码。
   * @param options.fileName - `dir` 内的密钥池文件名。
   * @param options.fs - 文件系统操作，测试时可注入。
   */
  constructor({ dir, fileName, fs = { mkdir, readFile, rename, unlink, writeFile } }) {
    this.#filePath = join(dir, fileName);
    this.dir = dir;
    this.fs = fs;
  }

  /** 密钥池文件的绝对路径。 */
  get filePath() {
    return this.#filePath;
  }

  /**
   * 加载期的失败，发生于文件不可信时（`POOL-7`）。
   *
   * @returns 错误；文件正常加载或本就不存在时返回 `undefined`。
   */
  get loadError() {
    return this.#loadError;
  }

  /**
   * 从磁盘读取密钥池。
   *
   * 文件不存在属正常的首次运行。文件损坏时原样保留、经 {@link loadError} 上报；
   * 此后存储以空池运作，下一次成功写入会开出新文件。
   *
   * @returns 本存储，便于链式调用。
   */
  async load() {
    let raw;
    try {
      raw = await this.fs.readFile(this.#filePath, 'utf8');
    } catch (error) {
      this.#document = emptyPool();
      this.#loadError = error?.code === 'ENOENT'
        ? undefined
        : new PoolFileError(
          `key pool at ${this.#filePath} could not be read: ${String(error)}`,
          this.#filePath,
          { reason: 'unreadable', cause: error },
        );
      return this;
    }

    let decoded;
    try {
      decoded = JSON.parse(raw);
    } catch (error) {
      this.#document = emptyPool();
      this.#loadError = new PoolFileError(
        `key pool at ${this.#filePath} is not valid JSON: ${String(error)}`,
        this.#filePath,
        { reason: 'malformed', cause: error },
      );
      return this;
    }

    try {
      this.#document = validatePool(decoded);
      this.#loadError = undefined;
    } catch (error) {
      this.#document = emptyPool();
      this.#loadError = new PoolFileError(
        `key pool at ${this.#filePath} does not match the expected schema: ${String(error.message)}`,
        this.#filePath,
        { reason: 'malformed', cause: error },
      );
    }
    return this;
  }

  /** 当前文档的一份脱离副本。 */
  snapshot() {
    return structuredClone(this.#document);
  }

  /** 全部密钥记录，按用户顺序，含已停用者。 */
  keysInOrder() {
    const byId = new Map(this.#document.keys.map((entry) => [entry.id, entry]));
    return this.#document.order.map((id) => byId.get(id)).filter((entry) => entry !== undefined);
  }

  /**
   * 下一次搜索要使用的明文密钥。
   *
   * issue `01` 还没有调度器，因此这里取用户顺序中第一把启用的密钥。余额感知选择与
   * 硬排除会在调度器与健康状态两个 issue 里替换掉它；调用方应把它当作「某一次尝试
   * 的密钥」，而不是一个决策。
   *
   * @returns 密钥；池中没有可用项时返回 `undefined`。
   */
  firstUsableKey() {
    return this.keysInOrder().find((candidate) => candidate.disabled !== true)?.key;
  }

  /**
   * 持久化一次变更，并用结果替换内存中的文档。
   *
   * 变更函数收到的是脱离副本：它抛错时既不写盘、也不改动内存文档，因此一次被拒绝的
   * 编辑不会让存储停留在某个从未保存过的状态上。
   *
   * @param mutate - 收到文档副本，返回下一份文档。
   * @returns 持久化后的文档。
   */
  async update(mutate) {
    const run = async () => {
      const next = validatePool(await mutate(this.snapshot()));
      await this.#persist(next);
      this.#document = next;
      this.#loadError = undefined;
      return next;
    };
    // 无条件串行。链条在下面总会被落定为 `undefined`，因此它不会把拒绝传给下一个
    // 调用方——这正是这里可以直接写 `then(run)` 的原因。
    const result = this.#writeChain.then(run);
    this.#writeChain = result.then(() => undefined, () => undefined);
    return result;
  }

  /**
   * 添加一把密钥（`POOL-2`）。
   *
   * @param options - 新密钥。
   * @param options.key - 明文密钥。
   * @param options.label - 可选的用户备注。
   * @param options.nowMs - 当前 epoch 毫秒。
   * @returns 新建的记录。
   */
  async addKey({ key, label, nowMs = Date.now() }) {
    const record = {
      id: randomUUID(),
      key,
      ...label === undefined || label.length === 0 ? {} : { label },
      addedAt: new Date(nowMs).toISOString(),
      disabled: false,
    };
    await this.update((document) => {
      document.keys.push(record);
      document.order.push(record.id);
      return document;
    });
    return record;
  }

  /**
   * 面板与所有 HTTP 响应收到的脱敏视图（`POOL-3`）。
   *
   * 按白名单构造，而不是「删掉 key 字段」：这样将来给记录新增字段时，它不会默认
   * 从这个函数里泄露出去。
   *
   * @returns 每把密钥一项，不含明文。
   */
  maskedList() {
    return this.keysInOrder().map((entry) => ({
      id: entry.id,
      masked: maskKey(entry.key),
      label: entry.label ?? '',
      addedAt: entry.addedAt,
      disabled: entry.disabled,
      stats: this.#document.stats[entry.id] ?? undefined,
      usage: this.#document.usageCache[entry.id] ?? undefined,
    }));
  }

  /** 先写临时文件，再原子 rename 落盘。 */
  async #persist(document) {
    await this.fs.mkdir(dirname(this.#filePath), { recursive: true, mode: 0o700 });
    const temporary = `${this.#filePath}.${String(process.pid)}.${randomUUID()}.tmp`;
    try {
      await this.fs.writeFile(temporary, `${JSON.stringify(document, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
      await this.fs.rename(temporary, this.#filePath);
    } catch (error) {
      // 否则每次重试都会把失败写入留下的临时文件攒在目录里。
      await this.fs.unlink(temporary).catch(() => undefined);
      throw error;
    }
  }
}

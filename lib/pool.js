/**
 * 密钥池持久化。
 *
 * 与宿主零耦合（`COMPAT-1`）：状态目录与文件系统操作都是注入的，因此本模块能在
 * `node:test` 下针对临时目录运行，且永远不需要知道 `~/.dsh` 在哪。
 *
 * 这里是 issue `01` 所需的子集——加载密钥池、原子写入、给出可用的第一把密钥。
 * 脱敏、完整的编辑接口、配额缓存与面板 HTTP 接口分别属于 issue `02`、`06`、`09`。
 *
 * ## 真源语义（ticket `22` C1）
 *
 * **磁盘上的 `keys.json` 是密钥记录集合的真源；内存是这个集合的一份缓存，外加本进程的运行期
 * 状态。** 进程运行期间对文件的外部改动因此**算数**——补一把密钥、改一个备注、删掉一把、
 * 加一个本版本还不认识的顶层键，都会在下一次落盘或对账时被吸收，而不是在下一次写入时被
 * 整份覆盖。落盘（{@link PoolStore} 的每次写入）与对账（{@link PoolStore#refreshFromDisk}）
 * 都先重读磁盘，按下面这张表归并：
 *
 * | 数据 | 真源 | 归并规则 |
 * |---|---|---|
 * | 记录集合的增删（`keys` / `order` 里有哪些 id） | 磁盘 | 外部新增保留；外部删除生效；本进程尚未落盘的增删以「编辑意图」叠加 |
 * | 记录的 `key` / `label` / `disabled` / `addedAt` 与记录上的未知字段 | 磁盘 | 同一条 id 两边都有、且本进程没改过它时取磁盘那份（外部编辑不被覆盖） |
 * | `stats` | 内存 | 本进程的运行期记账；同 id 覆盖磁盘，且只保留归并后仍存在的记录 |
 * | `usageCache` | 内存 | 同上 |
 * | `order` 的先后 | 内存 | 本进程的重排立即生效；外部对先后顺序的改动不追溯（记录集合本身仍以磁盘为准） |
 * | 五个已知键之外的顶层键 | 磁盘 | 原样带上，同键时磁盘优先（未知顶层键的往返保留，ticket `22` C3） |
 *
 * 「本进程没改过它」不是猜的：每次经 {@link PoolStore#update} 的编辑都会与编辑前的内存文档
 * 比对，把动过的记录 id 记成**编辑意图**，写入成功之后才消费掉。因此顺序是「磁盘为基底、
 * 意图叠在上面」——既不会让外部编辑白做，也不会让自己刚做的编辑被磁盘盖回去。
 *
 * 两个刻意留下的边界：
 *
 * - **不做字段级三向归并**：同一条记录两边改的是同一个字段时，本进程改过就以本进程为准，
 *   没改过就以磁盘为准。跨进程仲裁同一个字段的两次并发编辑不在本仓库的克制标准之内。
 * - **文件读不出来（不存在、或内容坏掉）时什么都不做**：那既不是「空池」也不是「外部清空」，
 *   一次读盘失败不该把用户手上的密钥弄丢。删除整个文件因此**不等于**清空密钥池。
 *
 * @module dsh-tavily-pool/pool
 */

import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

import { BALANCE_KINDS, readBalance } from './balance.js';

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
 * 对后续代码按 id 索引的部分严格，对**多带的数据**宽松：未知的顶层键与记录级字段都原样
 * 保留。这样由更新版本写出的文件不会仅仅因为多带了数据就被丢弃，也不会回到本版本之后
 * 在下一次任意编辑时被无声抹掉（ticket `22` C3）。
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

  // 五个已知键之外的**顶层**键原样带上：它们是更新版本或用户自己写下的数据，本版本读不懂
  // 不等于可以把它抹掉。已知的五个键则一律按上面的校验结果重建。
  return {
    ...value,
    version: POOL_SCHEMA_VERSION,
    keys,
    order,
    stats: isPlainObject(value.stats) ? value.stats : {},
    usageCache: isPlainObject(value.usageCache) ? value.usageCache : {},
  };
}

/**
 * 两份 JSON 可序列化的值是否逐字一致。
 *
 * 名字刻意说「JSON」而不是「记录」：它在四处被用到，其中两处比的是**整份文档**
 * （{@link PoolStore#noteExternalChange} 的「文档层面变了没有」与「磁盘基线还在不在」），
 * 只有两处比的是单条记录。叫 `sameRecord` 会让文档层面的那两处读起来像在比一条记录。
 *
 * @param left - 任意可 JSON 序列化的值。
 * @param right - 同上。
 * @returns 序列化结果逐字相同时返回 true。
 */
function sameJson(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}

/**
 * 按模块头那张真源语义表把磁盘文档与内存文档归并成一份（纯函数）。
 *
 * @param options - 两份文档与编辑意图。
 * @param options.disk - 刚从磁盘读到的文档。
 * @param options.memory - 内存中的文档。
 * @param options.intents - 记录 id 到 `{ kind, edit }` 的映射；`kind` 是 `'upsert'` 或 `'removed'`，
 *   `edit` 是记下这条意图时的编辑次数。
 * @returns 归并后的文档，可直接落盘。
 */
function mergeDocuments({ disk, memory, intents }) {
  const memoryById = new Map(memory.keys.map((entry) => [entry.id, entry]));

  // 1. 记录集合以磁盘为基底：外部新增的天然在里面，外部删掉的天然不在。
  const records = new Map(disk.keys.map((entry) => [entry.id, entry]));
  // 2. 再把本进程尚未落盘的编辑意图叠上去：新增与改动以内存为准，删除真的删掉。磁盘上已被
  //    外部删除、而本进程并没有改过它的记录，到这里就自然退出了并集——不会再被写回。
  for (const [id, intent] of intents) {
    if (intent.kind === 'removed') {
      records.delete(id);
      continue;
    }
    const record = memoryById.get(id);
    if (record !== undefined) records.set(id, record);
  }

  // 3. 顺序以内存为准（本进程的重排已经生效），磁盘独有的记录按磁盘里的次序补在后面。
  const order = [];
  const seen = new Set();
  for (const id of [...memory.order, ...disk.order, ...records.keys()]) {
    if (!records.has(id) || seen.has(id)) continue;
    seen.add(id);
    order.push(id);
  }
  const keys = order.map((id) => records.get(id));

  // 4. 统计与余额缓存以内存为准，且只保留归并后仍存在的记录：记录没了，它的历史也一起走
  //    （与 removeKey 同一条规则）。
  const stats = {};
  const usageCache = {};
  for (const id of order) {
    const statsEntry = memory.stats[id] ?? disk.stats[id];
    if (statsEntry !== undefined) stats[id] = statsEntry;
    const usageEntry = memory.usageCache[id] ?? disk.usageCache[id];
    if (usageEntry !== undefined) usageCache[id] = usageEntry;
  }

  // 5. 记录之外的部分以磁盘为准；内存里磁盘没有的未知顶层键也留着。
  return { ...memory, ...disk, version: POOL_SCHEMA_VERSION, keys, order, stats, usageCache };
}

/**
 * 密钥池存储：加载一次、原子写入、按顺序给出密钥。
 *
 * 写入串行经过同一条 promise 链，因此两次并发编辑不会交错成一份只应用了一半的
 * 文件；每次写入都先落到临时文件，再 rename 覆盖目标（`POOL-6`）。同目录内的
 * rename 是原子的，所以中途被打断的写入会留下完整的旧文件，而不会留下截断的新文件。
 *
 * 每次落盘前都重读一次磁盘并按模块头那张表归并（ticket `22` C1）：密钥池是小文件，
 * 一次多余的读盘换的是「外部改动不会被静默覆盖」。**写入的是归并结果，不是内存文档的
 * 直接序列化**——这是本类与「内存即真源」那份旧实现的分界。
 */
export class PoolStore {
  #filePath;
  #document = emptyPool();
  /** 我们已知磁盘上那份文档长什么样：加载、对账与成功写入之后都会更新。 */
  #diskDocument;
  #loadError;
  #writeChain = Promise.resolve();
  /** 本进程做出、尚未落盘的记录级编辑意图：id → `{ kind, edit }`。 */
  #intents = new Map();
  /**
   * 本进程做出的编辑次数，每次调用方的变更 +1。
   *
   * 两个地方按它对齐：编辑意图带着它，落盘成功之后才消费掉「这次写入真正带上」的那些；
   * 写盘失败的编辑按它判断「是否已有更晚的编辑接管了这份文档」——有就不回滚，没有就整体
   * 回滚。对账（{@link PoolStore#refreshFromDisk}）与加载**不**算编辑：它们不是调用方的
   * 变更，一次失败的编辑在它们之后仍然该被回滚掉。
   */
  #edit = 0;

  /**
   * 最近一次排队的统计落盘失败。
   *
   * 仅供展示：统计写不进去不影响搜索是否可用，但用户应当能看见「状态没有被记住」。
   */
  lastWriteError;

  /**
   * 最近一次观察到的**外部改动**（ticket `22` C1）。
   *
   * 每次重读磁盘都会与「上一次读到或写下的那份」比对，发现差异就如实记在这里：
   *
   * - `at`：观察到它的时刻（ISO-8601）。
   * - `added` / `removed` / `changed`：外部对**记录集合**做的事——新增几条、删掉几条、
   *   改了几条的字段。
   * - `documentChanged`：记录之外的部分（顺序、未知顶层键、统计、余额缓存）也有变化。
   *
   * 与 {@link lastWriteError} 同一约定：**这里只记录事实，由调用方读走并自行清除**
   * （`index.js` 的 `reportWriteErrors` 是既有的上报出口）。它是「最近一次」而不是队列，
   * 后来的一次外部改动会覆盖它。
   */
  lastExternalChange;

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
   * 加载是**建立基线**而不是此后唯一的读盘：本次读到的内容被记成「磁盘上那份」，
   * 此后的每一次落盘与对账都会重读并与它比对。
   *
   * @returns 本存储，便于链式调用。
   */
  async load() {
    let raw;
    try {
      raw = await this.fs.readFile(this.#filePath, 'utf8');
    } catch (error) {
      this.#replaceDocument(emptyPool());
      // 文件不存在 = 磁盘上还没有这份记录；其它读失败则连「磁盘上有什么」都不知道。
      if (error?.code === 'ENOENT') this.#diskDocument = emptyPool();
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
      this.#replaceDocument(emptyPool());
      this.#loadError = new PoolFileError(
        `key pool at ${this.#filePath} is not valid JSON: ${String(error)}`,
        this.#filePath,
        { reason: 'malformed', cause: error },
      );
      return this;
    }

    try {
      const document = validatePool(decoded);
      this.#replaceDocument(document);
      this.#diskDocument = document;
      this.#loadError = undefined;
    } catch (error) {
      this.#replaceDocument(emptyPool());
      this.#loadError = new PoolFileError(
        `key pool at ${this.#filePath} does not match the expected schema: ${String(error.message)}`,
        this.#filePath,
        { reason: 'malformed', cause: error },
      );
    }
    return this;
  }

  /**
   * 与磁盘对账一次：把外部改动吸收进内存，但**不落盘**（ticket `22` C1）。
   *
   * 读路径也要看见外部改动——面板刚打开时读到的必须是磁盘实况，而调度器手里的候选
   * 也不该包含一把已经被外部删掉的密钥。归并规则与落盘完全同一套（模块头那张表）。
   *
   * 文件读不出来时什么都不做：一次读盘失败不该把内存池清空，也不该让调用方失败。
   *
   * @returns 对账后的文档；没有可对账的内容时返回当前文档。
   */
  async refreshFromDisk() {
    const disk = await this.#readDiskDocument();
    if (disk === undefined) return this.#document;

    const memory = this.#document;
    this.#noteExternalChange(disk);
    const merged = mergeDocuments({ disk, memory, intents: this.#intents });
    // 读盘期间有人改过内存就不装回去：那份更新，下一次对账或落盘会重新算一遍。
    if (this.#document === memory) this.#document = merged;
    this.#diskDocument = disk;
    return this.#document;
  }

  /** 当前文档的一份脱离副本。 */
  snapshot() {
    return structuredClone(this.#document);
  }

  /**
   * 某把密钥的余额缓存，取自当前文档而不做副本。
   *
   * 余额会被 `/usage` 刷新（`06`）与面板改写，而调度器每个请求都要读一次——每次
   * 都为它克隆整份文档毫无意义，读一份过期副本则会让刚刷新出来的余额不生效。
   *
   * @param id - 密钥 id。
   * @returns 缓存项；没有时返回 `undefined`。
   */
  usageOf(id) {
    return this.#document.usageCache[id];
  }

  /** 某把密钥的统计，同样不做副本。 */
  statsOf(id) {
    return this.#document.stats[id];
  }

  /**
   * 全部密钥统计里某个数值字段的最大值。
   *
   * 供调度轮转的使用序号使用，因此刻意不做文档副本：它每个请求都要读一次，而克隆
   * 整份密钥池只为求一个最大值毫无意义。
   *
   * @param field - 字段名。
   * @returns 最大值；没有任何记录时返回 0。
   */
  maxStat(field) {
    let highest = 0;
    for (const stats of Object.values(this.#document.stats)) {
      const value = stats?.[field];
      if (typeof value === 'number' && Number.isFinite(value) && value > highest) highest = value;
    }
    return highest;
  }

  /** 全部密钥记录，按用户顺序，含已停用者。 */
  keysInOrder() {
    const byId = new Map(this.#document.keys.map((entry) => [entry.id, entry]));
    return this.#document.order.map((id) => byId.get(id)).filter((entry) => entry !== undefined);
  }

  /**
   * 持久化一次编辑，并用结果替换内存中的文档。
   *
   * 变更函数收到的是脱离副本：它抛错时既不写盘、也不改动内存文档，因此一次被拒绝的
   * 编辑不会让存储停留在某个从未保存过的状态上。**面板的编辑走这条路**：写盘失败的
   * 编辑必须整体回滚，否则面板会显示一份只存在于内存里、重启就消失的密钥池。
   *
   * 变更**同步**应用到内存，落盘排队。这一点是必需的而不是优化：`writeStats` 也写
   * 同一份文档，两条路径若一条同步一条异步，慢的那条落盘时会把快的那条的成果覆盖掉
   * ——症状是「用户改了排序，磁盘上却没改」，而内存与磁盘从此长期不一致。
   *
   * 变更函数**不得返回 promise**，且必须同步完成。
   *
   * 这次编辑动过的**记录**会被记成编辑意图（见模块头那张真源语义表）：落盘要先把磁盘上的
   * 外部改动并进来，而「本进程刚改过哪几条」只有在编辑的这一刻才分得清。写盘失败的编辑连同
   * 它的意图一起回滚——留下的意图会在下一次落盘时把一次**没有生效**的编辑重新写进磁盘。
   *
   * @param mutate - 收到文档副本，返回下一份文档。
   * @returns 持久化后的文档。
   * @throws 写盘失败时抛出，且内存回滚到调用前的状态。
   */
  async update(mutate) {
    const previous = this.#document;
    const previousIntents = new Map(this.#intents);
    const next = validatePool(mutate(this.snapshot()));
    this.#edit += 1;
    const myEdit = this.#edit;
    this.#noteIntents(previous, next);
    this.#document = next;
    this.#loadError = undefined;

    return this.#enqueue().then(
      () => next,
      (error) => {
        // 只有在没有**更晚的编辑**时才回滚：更晚的编辑已经把状态推进到别处了，此时回滚反而
        // 会把它们的成果抹掉。回滚之后内存与磁盘仍然一致——磁盘上留下的正是上一次成功的写入。
        if (this.#edit === myEdit) {
          this.#document = previous;
          this.#intents = previousIntents;
        }
        throw error;
      },
    );
  }

  /**
   * 同步更新某把密钥的统计，并把落盘排进队列。
   *
   * 统计必须**立刻**可见，因为调度决策是同步做的（`SCHED-6`），它读的正是冷却与额度
   * 耗尽这些字段；等落盘完成再更新内存，会让同一时刻的第二次调度看到一份旧状态，于是
   * 重新选中一把刚失败的密钥。
   *
   * 落盘失败不会回滚内存，也不会让搜索失败：统计是记录，不是正确性前提。失败被记在
   * {@link lastWriteError} 上，由调用方上报。
   *
   * @param id - 密钥 id。
   * @param mutate - 收到当前统计（可能是 `undefined`），返回下一份统计。
   * @returns 落盘完成的 promise；失败时也兑现，结果由 `lastWriteError` 反映。
   */
  writeStats(id, mutate) {
    const document = this.snapshot();
    document.stats[id] = mutate(document.stats[id]);
    this.#document = validatePool(document);
    this.#edit += 1;
    this.#loadError = undefined;

    return this.#enqueue().then(
      () => true,
      (error) => {
        this.lastWriteError = error;
        return false;
      },
    );
  }

  /**
   * 按本次消耗前推某把密钥的余额缓存（`USAGE-5`）。
   *
   * **只前推 `usage`，不编造 `limit`。** 上限只能来自官方，本地永远不知道它——凭空造一个
   * 出来会让调度器按一个我们猜的数字排序。因此上限或用量的读不出来时什么都不做：那种情况
   * 下余额本来就按「未知」排在最后（`SCHED-2`），前推只会凭空造出一份看起来像官方值的
   * 本地数据。
   *
   * **无限额度时也不前推**：没有有限的余额可供减少，排序恒为最前（`SCHED-2`），前推不改变
   * 任何决策，却会让缓存里那份「最后一次官方读数」悄悄变成一个本地估计值。
   *
   * 「上限在哪」由 `lib/balance.js` 判定，这里只消费它的结论：`20` 之前这里写的是
   * `key.limit === null` 就不前推，而免费账号的 `key.limit` 恰好也是 `null`——于是那把
   * 密钥的余额永远停在官方读数上，本可以前推的估计一次也没做。
   *
   * 不改变 `fetchedAt` / `stale`：这两个字段谈的是「上一次官方读数」，而前推不是一次读数。
   * 于是面板仍能如实说出「这个数字多久没跟官方对过了」。
   *
   * @param id - 密钥 id。
   * @param credits - 本次**估算**的积分消耗（只用于调度排序，不是记账；见 `lib/health.js`）。
   * @returns 前推后的缓存项；没有可前推的缓存时返回 `undefined`。
   */
  async advanceUsage(id, credits) {
    const current = this.#document.usageCache[id];
    const balance = readBalance(current);
    if (balance.kind !== BALANCE_KINDS.known) return undefined;
    if (typeof credits !== 'number' || !Number.isFinite(credits) || credits === 0) return undefined;

    return this.#patchUsage(id, {
      ...current,
      key: { ...current.key, usage: balance.used + credits },
    });
  }

  /**
   * 用官方 `/usage` 的返回值整体覆盖某把密钥的余额缓存（`USAGE-1`、`USAGE-3`）。
   *
   * **整体覆盖，不做字段合并。** 官方值是权威，本地这份是它的镜像；合并会让一个已经
   * 不被官方返回的旧字段永远留在缓存里。
   *
   * 覆盖时清掉 {@link markUsageStale} 打的陈旧标记：这次刚拿到官方值，任何关于这份
   * 数据「不可信」的记录都已过时。
   *
   * 与 {@link writeStats} 一样**同步**改内存、落盘排队：调度决策是同步做的
   * （`SCHED-6`），等落盘完成再更新内存会让同一时刻的下一次调度读到一份旧余额，
   * 于是刚刚被官方降到垫底的密钥仍然排在最前。
   *
   * @param id - 密钥 id。
   * @param usage - 官方 `/usage` 响应体。
   * @param options - 本次写入。
   * @param options.nowMs - 当前时刻。
   * @returns 写进去的那份缓存项。
   */
  async setUsage(id, usage, { nowMs = Date.now() } = {}) {
    const entry = {
      key: usage?.key,
      account: usage?.account,
      fetchedAt: new Date(nowMs).toISOString(),
      stale: false,
    };
    await this.#patchUsage(id, entry);
    return entry;
  }

  /**
   * 标记某把密钥的余额缓存为**陈旧**（`USAGE-3`）。
   *
   * 只动 `stale`，不碰 `key` / `account` / `fetchedAt`——「刷新失败不污染缓存」的全部
   * 含义就在这里：旧值仍然是最后一次**成功**读到的官方值，它只是不再可信。
   *
   * 从未成功刷新过时什么都不做：没有旧值可标记，凭空造一个「陈旧的空余额」只会让
   * 调度器把它当成「余额未知」，而它与「从未刷新过」本来就是同一件事。
   *
   * @param id - 密钥 id。
   * @returns 标记后的缓存项；没有缓存时返回 `undefined`。
   */
  async markUsageStale(id) {
    const current = this.#document.usageCache[id];
    if (current === undefined) return undefined;
    const entry = { ...current, stale: true };
    await this.#patchUsage(id, entry);
    return entry;
  }

  /**
   * 覆盖某把密钥的余额缓存，并同步更新内存。
   *
   * 与 {@link writeStats} 共用同一条落盘队列，因此一次余额刷新与一次统计写入不会
   * 交错成一份只应用了一半的文件。
   */
  async #patchUsage(id, entry) {
    const document = this.snapshot();
    document.usageCache[id] = entry;
    this.#document = validatePool(document);
    this.#edit += 1;
    this.#loadError = undefined;
    await this.#enqueue();
    return entry;
  }

  /**
   * 把「与磁盘对账后写入」排到串行队列末尾。
   *
   * 落盘的是**任务执行那一刻**重读磁盘、再按真源语义表归并出来的文档，而不是排队时的那
   * 一份：排队期间可能又发生了别的变更（写旧的那份会把它们丢掉），磁盘上也可能刚被外部
   * 改过（写内存那一份会把它抹掉）。队列保证顺序，因此最后一次写入落下的就是最终状态。
   */
  #enqueue() {
    const result = this.#writeChain.then(() => this.#persist());
    // 无条件串行。链条自身总会被落定为 `undefined`，因此一次失败不会毒害后续调用方。
    this.#writeChain = result.then(() => undefined, () => undefined);
    return result;
  }

  /** 记下这次编辑动了哪些**记录**；统计、余额与顺序有各自的无条件规则，无需进意图表。 */
  #noteIntents(previous, next) {
    const before = new Map(previous.keys.map((entry) => [entry.id, entry]));
    const after = new Map(next.keys.map((entry) => [entry.id, entry]));
    for (const [id, entry] of after) {
      const old = before.get(id);
      if (old === undefined || !sameJson(old, entry)) this.#intents.set(id, { kind: 'upsert', edit: this.#edit });
    }
    for (const id of before.keys()) {
      if (!after.has(id)) this.#intents.set(id, { kind: 'removed', edit: this.#edit });
    }
  }

  /** 把内存文档换成刚加载出来的那一份。加载不算一次编辑：它不消费也不留下编辑意图。 */
  #replaceDocument(document) {
    this.#document = document;
    this.#intents.clear();
  }

  /**
   * 重读磁盘上的密钥池，供落盘前的归并与对账使用。
   *
   * **任何读不出来的情况都返回 `undefined`，绝不抛出**：它跑在每次搜索、每次抓取与每次面板
   * 请求的路径上，一次读盘失败不该让它们失败。而且「读不出来」在这里的含义是「不知道磁盘上
   * 有什么」，不是「磁盘上是空的」——当成空池会把用户手上的密钥清掉。
   */
  async #readDiskDocument() {
    let raw;
    try {
      raw = await this.fs.readFile(this.#filePath, 'utf8');
    } catch {
      return undefined;
    }
    try {
      return validatePool(JSON.parse(raw));
    } catch {
      return undefined;
    }
  }

  /** 把「磁盘上的内容不是我们上次读到或写下的那份」如实记进 {@link lastExternalChange}。 */
  #noteExternalChange(disk) {
    const base = this.#diskDocument;
    if (base !== undefined && sameJson(base, disk)) return;

    const known = new Map((base?.keys ?? []).map((entry) => [entry.id, entry]));
    const observed = new Map(disk.keys.map((entry) => [entry.id, entry]));
    let added = 0;
    let removed = 0;
    let changed = 0;
    for (const [id, entry] of observed) {
      const before = known.get(id);
      if (before === undefined) added += 1;
      else if (!sameJson(before, entry)) changed += 1;
    }
    for (const id of known.keys()) if (!observed.has(id)) removed += 1;

    this.lastExternalChange = {
      at: new Date().toISOString(),
      added,
      removed,
      changed,
      documentChanged: !sameJson({ ...base, keys: [] }, { ...disk, keys: [] }),
    };
  }

  /**
   * 归并并落盘。
   *
   * 归并所依据的内存文档与编辑次数都在**读盘之后**取：读盘期间发生的编辑已经在内存里了，
   * 把它们一起算进去，才不会让刚做的编辑被这一次写入落下。
   */
  async #persist() {
    const disk = await this.#readDiskDocument();
    const memory = this.#document;
    const edit = this.#edit;
    if (disk !== undefined) this.#noteExternalChange(disk);
    const merged = disk === undefined ? memory : mergeDocuments({ disk, memory, intents: this.#intents });

    await this.#writeDocument(merged);

    // 读盘与写盘期间没人换掉内存文档时才把归并结果装回去：换掉它的要么是更晚的编辑（那份更新，
    // 由排在后面的写入落定），要么是一次对账（那份已经把外部改动算进去了）。写失败时根本走不
    // 到这里——`update()` 还要按「有没有更晚的编辑」决定该不该整体回滚。
    if (this.#document === memory) this.#document = merged;
    this.#diskDocument = merged;
    // 只消费这次写入真正带上的那些意图：写盘期间新记下的意图属于更晚的编辑，留给下一次。
    for (const [id, intent] of this.#intents) if (intent.edit <= edit) this.#intents.delete(id);
  }

  /** 先写临时文件，再原子 rename 落盘。 */
  async #writeDocument(document) {
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
    const [record] = await this.addKeys({ keys: [{ key, label }], nowMs });
    return record;
  }

  /**
   * 一次添加多把密钥（`POOL-8`）。
   *
   * **一次落盘，而不是把 {@link addKey} 循环 N 次。** 每一次 `update` 都要走一遍
   * 「临时文件 + rename」，粘贴 50 行就是 50 次写入：中间任何一次失败都会留下一个只加进去
   * 一半的池子，而用户点的是一个按钮，期望的是一个结果。批量因此天然是一次编辑。
   *
   * 批量内的每一把共享同一个 `addedAt`：它们是同一次动作的结果，让 50 把密钥各自相差几毫秒
   * 只会给「这一批是什么时候加的」这个问题制造 50 个答案。
   *
   * **不去重。** 重复与否是**领域判断**（`lib/panel.js` 才知道池里已有什么、用户粘贴的
   * 文本有哪些重复行），这里只管写入——把判断塞进存储层，会让「同一把密钥能不能加两次」
   * 这个问题有两个答案。
   *
   * @param options - 新密钥。
   * @param options.keys - 每项是 `{ key, label? }`。
   * @param options.nowMs - 当前 epoch 毫秒。
   * @returns 新建的记录，与入参同序。
   */
  async addKeys({ keys, nowMs = Date.now() }) {
    if (keys.length === 0) return [];
    const addedAt = new Date(nowMs).toISOString();
    const records = keys.map(({ key, label }) => ({
      id: randomUUID(),
      key,
      ...label === undefined || label.length === 0 ? {} : { label },
      addedAt,
      disabled: false,
    }));
    await this.update((document) => {
      for (const record of records) {
        document.keys.push(record);
        document.order.push(record.id);
      }
      return document;
    });
    return records;
  }

  /**
   * 面板与所有 HTTP 响应收到的脱敏视图（`POOL-3`）。
   *
   * @returns 每把密钥一项，不含明文。
   */
  maskedList() {
    return this.keysInOrder().map((entry) => this.#maskedEntry(entry));
  }

  /**
   * 启用或停用一把密钥（`POOL-4`、`POOL-5`）。
   *
   * 停用只影响调度：记录本身、它的统计与余额缓存都原样保留，重新启用时历史还在。
   *
   * @param id - 密钥 id。
   * @param disabled - 目标状态。
   * @returns 更新后的脱敏记录，与 {@link maskedList} 的单项同形。
   * @throws {RangeError} 池中没有该 id 时抛出。
   */
  async setDisabled(id, disabled) {
    this.#requireRecord(id);
    await this.update((document) => {
      document.keys = document.keys.map((entry) => (entry.id === id ? { ...entry, disabled } : entry));
      return document;
    });
    return this.#maskedEntry(this.#requireRecord(id));
  }

  /**
   * 改写一把密钥的备注（`POOL-4`）。
   *
   * 备注纯属展示，因此空字符串表示「没有备注」，而不是把空串存进文件。
   *
   * @param id - 密钥 id。
   * @param label - 新备注。
   * @returns 更新后的脱敏记录。
   * @throws {RangeError} 池中没有该 id 时抛出。
   */
  async rename(id, label) {
    this.#requireRecord(id);
    await this.update((document) => {
      document.keys = document.keys.map((entry) => {
        if (entry.id !== id) return entry;
        const renamed = { ...entry };
        if (typeof label === 'string' && label.length > 0) renamed.label = label;
        else delete renamed.label;
        return renamed;
      });
      return document;
    });
    return this.#maskedEntry(this.#requireRecord(id));
  }

  /**
   * 删除一把密钥（`POOL-4`）。
   *
   * 连同它的统计与余额缓存一起删除：留着这些数据既没有展示价值，又会让「重新添加
   * 同一把密钥」继承一份不属于它的历史。
   *
   * @param id - 密钥 id。
   * @returns 被删除的脱敏记录。
   * @throws {RangeError} 池中没有该 id 时抛出。
   */
  async removeKey(id) {
    const removed = this.#maskedEntry(this.#requireRecord(id));
    await this.update((document) => {
      document.keys = document.keys.filter((entry) => entry.id !== id);
      document.order = document.order.filter((entryId) => entryId !== id);
      delete document.stats[id];
      delete document.usageCache[id];
      return document;
    });
    return removed;
  }

  /**
   * 一次删除多把密钥（ticket `22` D2）。
   *
   * **一次落盘，而不是把 {@link removeKey} 循环 N 次。** 理由与 {@link addKeys} 逐字对称：
   * 每一次 `update` 都要走一遍「临时文件 + rename」，删 200 把就是 200 次写入——中间任何
   * 一次失败（EACCES、ENOSPC）都会留下一个**删了一半**的池子，而用户点的是一个按钮，
   * 期望的是一个结果。
   *
   * **不做去重与存在性判断**：那是领域判断（`lib/panel.js` 才知道用户选了哪些行、哪些 id
   * 是合法的），这里只管删除——把判断塞进存储层会让「一个不存在的 id 算不算错」这个问题
   * 有两个答案。未知 id 在这里是**无害的**：过滤掉它什么都不影响，而调用方若要报错，自己
   * 先校验。
   *
   * @param ids - 要删除的密钥 id。
   * @returns 被删除的脱敏记录，与入参同序（未知 id 不出现在结果里）。
   */
  async removeKeys(ids) {
    const requested = Array.isArray(ids) ? ids : [];
    if (requested.length === 0) return [];
    const wanted = new Set(requested);
    const removed = this.keysInOrder()
      .filter((entry) => wanted.has(entry.id))
      .map((entry) => this.#maskedEntry(entry));

    await this.update((document) => {
      document.keys = document.keys.filter((entry) => !wanted.has(entry.id));
      document.order = document.order.filter((entryId) => !wanted.has(entryId));
      for (const id of wanted) {
        delete document.stats[id];
        delete document.usageCache[id];
      }
      return document;
    });
    return removed;
  }

  /**
   * 重排密钥（`POOL-4`）。
   *
   * 传进来的 id 顺序即新顺序。未出现在列表里的密钥保持相对次序、追加在后面，未知
   * id 被丢弃，重复项折叠——与 {@link validatePool} 对陈旧 order 的处理同一套规则，
   * 因为「顺序是展示偏好，不是数据完整性事实」。
   *
   * @param ids - 新的 id 顺序。
   * @returns 重排后的完整顺序。
   */
  async reorder(ids) {
    const requested = Array.isArray(ids) ? ids : [];
    const next = await this.update((document) => {
      const rank = new Map();
      requested.forEach((id, index) => {
        if (typeof id === 'string' && !rank.has(id)) rank.set(id, index);
      });
      document.order = document.order
        .map((id, index) => ({ id, index }))
        .sort((left, right) => {
          const leftRank = rank.get(left.id) ?? Number.POSITIVE_INFINITY;
          const rightRank = rank.get(right.id) ?? Number.POSITIVE_INFINITY;
          return leftRank === rightRank ? left.index - right.index : leftRank - rightRank;
        })
        .map((item) => item.id);
      return document;
    });
    return next.order;
  }

  /**
   * 取一把密钥的脱敏视图。
   *
   * 按白名单构造，而不是「删掉 key 字段」：这样将来给记录新增字段时，它不会默认
   * 从这里泄露出去。
   */
  #maskedEntry(entry) {
    return {
      id: entry.id,
      masked: maskKey(entry.key),
      label: entry.label ?? '',
      addedAt: entry.addedAt,
      disabled: entry.disabled,
      stats: this.#document.stats[entry.id] ?? undefined,
      usage: this.#document.usageCache[entry.id] ?? undefined,
    };
  }

  /** 一次编辑之后的脱敏记录；池中没有该 id 时抛出。 */
  #requireRecord(id) {
    const entry = this.keysInOrder().find((candidate) => candidate.id === id);
    if (entry === undefined) throw new RangeError(`no key with id ${id} in the pool`);
    return entry;
  }

}

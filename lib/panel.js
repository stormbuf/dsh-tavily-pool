/**
 * 设置面板的领域逻辑：状态投影与命令执行（`PANEL-4`、`POOL-3`）。
 *
 * 本模块与宿主零耦合（`COMPAT-1`）：不 import 任何 `@deepseek-ai/*`，也完全不认识
 * WHATWG `Request` / `Response`——HTTP 的编解码属于 `lib/dsh/panel-routes.js`。这样
 * 切分是为了可测性：面板的全部行为（脱敏、入参校验、错误映射、配额跳过如实上报）都能
 * 用普通对象在 `node:test` 下覆盖，而适配器只剩一层机械转换。
 *
 * **明文密钥只在一个方向上流动**：`add` 命令带着明文进来，此后任何返回值都不含它。
 * 状态投影只经 `PoolStore.maskedList()`，那是按白名单构造的视图（`POOL-3`）——本项目
 * 刻意**不提供**任何返回明文的接口，因此这里连「按 id 取明文」的函数都没有。
 *
 * 返回形状统一为 `{ status, body }`，其中 `status` 已经是可以直接写进 HTTP 响应的
 * 状态码。把状态码的决定权留在这里（而不是适配器里）是有意的：哪一次失败是 400、哪一次
 * 是 404、哪一次是 503，属于面板的语义，不是传输层的细节；把它放在传输层，行为就只能
 * 靠起一个 HTTP 服务来测。
 *
 * @module dsh-tavily-pool/panel
 */

import { basename } from 'node:path';

import {
  HISTORY_MAX_ENTRIES,
  PANEL_KEY_MAX_LENGTH,
  PANEL_KEYS_MAX,
  PANEL_KEYS_MAX_PER_REQUEST,
} from './constants.js';
import { classifyFailure } from './health.js';

/**
 * 面板错误码。
 *
 * 它们是**机器码**而不是给用户看的文案：面板据以选择本地化文案，模型与日志据以定位
 * 问题。`message` 才是细节，且按仓库约定用英文（见 `AGENTS.md` 的诊断字符串例外）。
 */
export const PANEL_ERROR_CODES = Object.freeze({
  /** 入参形状不对：缺字段、类型错、空密钥。 */
  BAD_REQUEST: 'PANEL_BAD_REQUEST',
  /** 这一条命令名不存在。 */
  UNKNOWN_COMMAND: 'PANEL_UNKNOWN_COMMAND',
  /** 引用了池中不存在的密钥 id。 */
  NO_SUCH_KEY: 'PANEL_NO_SUCH_KEY',
  /** 设置值被宿主 schema 拒绝（`CFG-4`）。 */
  INVALID_SETTINGS: 'PANEL_INVALID_SETTINGS',
  /** 设置已在别处被改动（宿主 revision 冲突）。 */
  SETTINGS_CONFLICT: 'PANEL_SETTINGS_CONFLICT',
  /** 密钥池编辑没能落盘。 */
  KEY_EDIT_FAILED: 'PANEL_KEY_EDIT_FAILED',
  /** 面板依赖的能力此刻不可用（插件初始化失败、宿主没有 settings 服务）。 */
  UNAVAILABLE: 'PANEL_UNAVAILABLE',
});

/**
 * 面板路由拒绝一次请求时抛出的错误。
 *
 * `status` 由抛出点决定，因此「哪一类失败算 404」这件事在阅读错误抛出点时就一目了然，
 * 不必去适配器里追一张映射表。
 */
export class PanelError extends Error {
  /**
   * @param message - 面向开发者与日志的英文说明。
   * @param options - 错误分类。
   * @param options.code - {@link PANEL_ERROR_CODES} 中的一个机器码。
   * @param options.status - HTTP 状态码。
   * @param options.cause - 原始错误。
   */
  constructor(message, { code = PANEL_ERROR_CODES.BAD_REQUEST, status = 400, cause } = {}) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = 'PanelError';
    this.code = code;
    this.status = status;
  }
}

/**
 * 面板状态的投影（`CFG-5`、`COMPAT-3`、`POOL-7`、`PANEL-6`）。
 *
 * 每一块都对应一条需求：`settings` 是开关与搜索参数（`CFG-3`），`keys` 是脱敏后的
 * 密钥列表连同各自的统计与余额（`USAGE-7`、`PANEL-6`），`capabilities` 是加载期的
 * 能力探测结果（`COMPAT-3`），`fallback` 是回落目标的两态凭据（`CFG-5`），
 * `poolError` 是密钥池文件不可用时的报告（`POOL-7`），`history` 是调用历史与按日汇总
 * （`14`）。
 *
 * 插件初始化失败时 `pool` 缺席，此时返回空列表加一条 `poolError`，而不是让整个面板
 * 变成一片 500：`PIN-5` 的「半坏仍可用」对面板同样成立——用户最需要看到诊断信息的
 * 时刻，恰恰是插件坏掉的时候。
 *
 * @param options - 状态来源。
 * @param options.settings - 当前设置值。
 * @param options.pool - 密钥池；插件初始化失败时缺席。
 * @param options.capabilityReport - 加载期的能力探测报告。
 * @param options.fallback - 回落目标状态，由 `lib/dsh/fallback.js` 解析（宿主知识）。
 * @param options.history - `{ entries, error }`：最近的调用记录（最新的在前）与读取失败的原因。
 *   插件初始化失败或缺席时给空数组，面板因此画不出曲线而不是变成一片 500。
 * @param options.hostBudget - 最近一次为每条路径定下的总预算与来源（`host-contract-2`）：
 *   `{ search?: {budgetMs, source, hostSource}, fetch?: {...} }`。`source` 为 `'host'` 表示
 *   取自宿主绑定的 tool `timeoutMs`，`'constant'` 表示退回了本插件的常量。它是**观测**而不是
 *   决策依据——决策读的是那次调用的返回值——因此缺席（还没搜过）时如实给 `null`。
 * @param options.nowMs - 当前时刻，供按日汇总定出「今天」。
 * @returns 可 JSON 序列化的面板状态，**不含任何密钥明文**。
 */
export function readPanelState({ settings, pool, capabilityReport, fallback, history, hostBudget, nowMs = Date.now() }) {
  const entries = Array.isArray(history?.entries) ? history.entries : [];
  return {
    settings,
    keys: pool === undefined ? [] : pool.maskedList(),
    poolError: pool === undefined
      ? { message: 'the key pool is unavailable because the plugin did not finish loading', path: null, reason: 'unavailable' }
      : describePoolError(pool),
    capabilities: capabilityReport === undefined
      ? { ok: false, missingRequired: [], missingOptional: [], summary: 'the host was not probed', findings: [] }
      : {
        ok: capabilityReport.ok,
        missingRequired: capabilityReport.missingRequired,
        missingOptional: capabilityReport.missingOptional,
        summary: capabilityReport.summary,
        findings: capabilityReport.findings,
      },
    fallback,
    hostBudget: hostBudget ?? null,
    history: {
      // 面板只画最近这些条。上限与保留窗口是**文件**层面的裁剪（`lib/history.js`），这里
      // 再截一次是因为状态响应每次都整份发出：把 500 条全塞进去只会让面板变慢，而曲线看
      // 不出第 500 条与前 200 条的差别。适配层给的就是这个上限，这里的截断只是兜住
      // 「history 由别处传进来」的情形。
      entries: entries.slice(0, PANEL_HISTORY_ENTRIES),
      daily: dailyCalls(entries, { nowMs }),
      error: history?.error === null || history?.error === undefined ? null : String(history.error),
    },
  };
}

/**
 * 面板状态里最多回传多少条调用记录。
 *
 * **与文件层面的条数上限一致**（`HISTORY_MAX_ENTRIES`）：先前这里取 200，于是 14 天里调用超过
 * 200 次时曲线会静默少算前面那些——而「图表正确反映积分趋势」正是这张票的验收之一。体积由文件
 * 那一层的裁剪兜住，这里没有理由再截一刀。
 */
export const PANEL_HISTORY_ENTRIES = HISTORY_MAX_ENTRIES;

/** 按日汇总的天数（`14` 的图表窗口）。 */
export const HISTORY_CHART_DAYS = 14;

/**
 * 把调用记录按**日**汇总成**调用次数**（`14` 的图表数据）。
 *
 * 在服务端算而不是让卡片算，是因为卡片是零构建产物：能少一段逻辑就少一段。而这一段的
 * 输入就是历史本身，放在这里也让它可以用普通对象直接覆盖。
 *
 * ⚠️ 这里画的是**次数**，不是积分（2026-09-20 决定）。插件不再统计自身消耗积分：积分规则
 * 由上游随时可能更改，任何自算的数字都可能在某次规则调整后变成误导。面板只展示 `/usage`
 * 的官方余额，而余额是「上限 − 已用」两个官方数字之差，不经过本地估算。次数则完全来自
 * 本地事实（一条记录就是一次真实调用），不受上游规则影响。
 *
 * **按本地日期分桶**，不是 UTC：用户看的是「我昨天调了几次」，而他的昨天由他的时区决定。
 * `toISOString().slice(0, 10)` 会把它算成 UTC 日期，在 UTC+8 的早晨会把前一晚的调用算到
 * 前一天去。
 *
 * 固定输出 {@link HISTORY_CHART_DAYS} 天（含今天），没有调用的那天补零——曲线的横轴必须是
 * 均匀的，跳过空白天会让「两天没调用」看起来像「连续调用」。
 *
 * @param entries - 调用记录，最新的在前。
 * @param options - 汇总参数。
 * @param options.nowMs - 当前时刻。
 * @param options.days - 汇总多少天。
 * @returns `[{ date, search, extract, calls }]`，按日期升序；`search` / `extract` 是次数。
 */
export function dailyCalls(entries, { nowMs = Date.now(), days = HISTORY_CHART_DAYS } = {}) {
  const buckets = new Map();
  const today = new Date(nowMs);
  for (let offset = days - 1; offset >= 0; offset -= 1) {
    const day = new Date(today.getFullYear(), today.getMonth(), today.getDate() - offset);
    buckets.set(dayKey(day), { date: dayKey(day), search: 0, extract: 0, calls: 0 });
  }

  for (const entry of entries) {
    const at = Date.parse(entry?.at);
    if (Number.isNaN(at)) continue;
    const bucket = buckets.get(dayKey(new Date(at)));
    if (bucket === undefined) continue;
    bucket.calls += 1;
    if (entry.endpoint === 'extract') bucket.extract += 1;
    else bucket.search += 1;
  }

  return [...buckets.values()];
}

/** 本地日期键（`YYYY-MM-DD`）。 */
function dayKey(date) {
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${String(date.getFullYear())}-${month}-${day}`;
}

/**
 * 密钥池文件的错误描述（`POOL-7`）。
 *
 * @param pool - 密钥池。
 * @returns `null`，或一份不含明文的描述。
 */
function describePoolError(pool) {
  const error = pool.loadError;
  if (error === undefined) return null;
  return {
    message: error.message,
    path: pool.filePath,
    reason: error.reason ?? 'malformed',
  };
}

/**
 * 执行一条面板命令。
 *
 * @param command - 命令名：`keys` / `settings` / `refresh` / `test`。
 * @param payload - 已解码的请求体；`GET` 路由传 `undefined`。
 * @param deps - 本模块无法自己获得的东西，全部由适配器注入。
 * @param deps.pool - 密钥池。
 * @param deps.readSettings - 读取当前设置的 thunk（宿主知识）。
 * @param deps.writeSettings - 写入部分设置的 thunk（宿主知识）。
 * @param deps.refresh - `UsageRefresher.refresh`，刷新一把密钥的余额。
 * @returns `{ status, body }`。
 * @throws {PanelError} 入参非法、id 不存在、写入被拒时抛出。
 */
export async function runPanelCommand(command, payload, deps) {
  switch (command) {
    case 'keys':
      return runKeysCommand(payload, deps);
    case 'settings':
      return runSettingsCommand(payload, deps);
    case 'refresh':
      return runRefreshCommand(payload, deps);
    case 'test':
      return runTestCommand(payload, deps);
    default:
      throw new PanelError(`unknown panel command ${JSON.stringify(String(command))}`, {
        code: PANEL_ERROR_CODES.UNKNOWN_COMMAND,
        status: 404,
      });
  }
}

/**
 * 密钥池的增删改启停排序（`POOL-4`）、批量添加（`POOL-8`）与批量删除。
 *
 * 每条命令都返回**完整**的脱敏列表，而不是只返回被动的那一项：卡片据此重绘，于是
 * 「排序」「启停」这类会改变其他行位置的操作不必让前端自己推断新顺序——顺序的权威在
 * 密钥池文件里，前端再算一遍只会多出一份可能分叉的推断。
 *
 * 添加的两条路径（`add` / `addBatch`）共用同一份去重判据与同一套上限；删除的两条
 * （`remove` / `removeBatch`）共用同一条「id 不存在即 404」的规则。
 *
 * @param payload - `{ action, ... }`。
 * @param deps - 面板依赖。
 * @returns `{ status, body }`。
 */
async function runKeysCommand(payload, deps) {
  const pool = requirePool(deps);
  const action = readString(payload, 'action');
  const body = () => ({ keys: pool.maskedList() });

  switch (action) {
    case 'add': {
      const key = readString(payload, 'key');
      if (key.trim().length === 0) {
        throw new PanelError('a Tavily API key is required', { code: PANEL_ERROR_CODES.BAD_REQUEST });
      }
      const plain = key.trim();
      requireKeyLength(plain.length, 'the submitted key');
      // **单把与批量走同一份去重判据**（`POOL-9`）。存储层明确不去重（见 `PoolStore.addKeys`
      // 的注释：重复与否是领域判断），因此这个判断只能在这里做，而这里只该有一个答案。
      //
      // 重复**不是入参非法**：这一把密钥本身完全合法、也确实属于用户，只是池里已经有了，
      // 因此回 200 加一份计数，而不是 400。原先没有这一步时，同一把明文提交两次会占两个
      // 槽位，两行掩码一模一样，而冷却与额度耗尽按各自的 record id 独立记账——一次 429 只
      // 冷却其中一行，故障切换被自我抵消，同一个上游配额也被用得更快（`panel-http-3`）。
      const claimNew = claimNewKey(pool.keysInOrder().map((record) => record.key));
      if (!claimNew(plain)) {
        return { status: 200, body: { ...body(), summary: { received: 1, added: 0, duplicates: 1 } } };
      }
      requireCapacity(pool, 1);
      const label = readOptionalString(payload, 'label');
      await withKeyEdit(pool, () => pool.addKey({ key: plain, label }));
      return { status: 200, body: { ...body(), summary: { received: 1, added: 1, duplicates: 0 } } };
    }
    case 'addBatch': {
      // 粘贴的文本原样进来，**切行与去重都在这里做**（`POOL-8`）：那是一套领域规则，
      // 放在卡片里就得再写一遍，而两份「什么算一行、什么算重复」的答案迟早会分叉。
      // 单把与批量共用同一份判据，因此「同一把明文提交两次」在两条入口上得到同一个答案。
      const { fresh, duplicates, received, oversized } = parseKeyLines(readString(payload, 'text'), {
        existing: pool.keysInOrder().map((record) => record.key),
      });
      // 空文本与「全是空行、全是重复」在界面上长得一样，但用户需要知道是哪一种，因此
      // 「一行密钥都没有」按入参非法拒绝，而不是回一个 `added: 0` 让界面自己猜。
      if (received === 0) {
        throw new PanelError('the pasted text contains no Tavily API key', { code: PANEL_ERROR_CODES.BAD_REQUEST });
      }
      // 上限在这里判，而不是在解析里把超出的行丢掉：静默丢弃会让用户以为写出去了。
      // 条数先于长度，是因为「一次粘了 5000 行」比「其中一行特别长」更像那个真正的误操作。
      if (received > PANEL_KEYS_MAX_PER_REQUEST) {
        throw new PanelError(
          `the pasted text contains ${received} keys but a single paste may add at most ${PANEL_KEYS_MAX_PER_REQUEST}`
          + ': check what was pasted; nothing was written to the key pool',
          { code: PANEL_ERROR_CODES.BAD_REQUEST },
        );
      }
      if (oversized !== null) {
        requireKeyLength(oversized.length, `line ${oversized.line} of the pasted text`);
      }
      if (fresh.length > 0) requireCapacity(pool, fresh.length);
      // 一把新的都没有时这里不做特判：`addKeys` 收到空数组就什么都不做（那属于存储层的
      // 语义，在这里再判一遍只会多出第二份「什么算空」的答案）。
      await withKeyEdit(pool, () => pool.addKeys({ keys: fresh.map((key) => ({ key })) }));
      return {
        status: 200,
        body: { ...body(), summary: { received, added: fresh.length, duplicates } },
      };
    }
    case 'remove': {
      const id = requireKeyId(pool, payload);
      await withKeyEdit(pool, () => pool.removeKey(id));
      return { status: 200, body: body() };
    }
    case 'removeBatch': {
      // 批量删除是**一次请求删多把**。面板原先只有逐把删除的出口，而一次误粘就能把池子
      // 撑到几百把（`panel-http-4`）——清理那条路上没有任何说得通的入口。
      //
      // **删除不设条数上限**，这是它与添加刻意不对称的地方：条数上限是为了让池子回到可用
      // 规模，而删除正是那条路；给清理加上限会让一个被误粘撑大的池子只能一点点清。
      //
      // 先全部确认存在、再动手删：一个不存在的 id 必须**一把都不删**（票面验收原文），
      // 而边删边发现会留下一个删了一半的池子，用户点的是一个按钮。重复出现的 id 折叠
      // （与 `reorder` 同一套规则）：同一次请求里重复给到同一行，不该变成一次 404。
      const ids = [...new Set(readIdList(payload))];
      for (const id of ids) requireRecord(pool.keysInOrder(), id);
      // **一次落盘，而不是 `removeKey` 循环 N 次**——理由与 `addBatch` 走 `addKeys` 逐字
      // 对称：N 次「临时文件 + rename」中间任何一次失败都会留下删了一半的池子。存在性校验
      // 仍然留在上面：`removeKeys` 对未知 id 是静默过滤的（存储层不做领域判断）。
      await withKeyEdit(pool, () => pool.removeKeys(ids));
      return { status: 200, body: { ...body(), summary: { received: ids.length, removed: ids.length } } };
    }
    case 'setDisabled': {
      const id = requireKeyId(pool, payload);
      if (typeof payload?.disabled !== 'boolean') {
        throw new PanelError('"disabled" must be a boolean', { code: PANEL_ERROR_CODES.BAD_REQUEST });
      }
      await withKeyEdit(pool, () => pool.setDisabled(id, payload.disabled));
      return { status: 200, body: body() };
    }
    case 'rename': {
      const id = requireKeyId(pool, payload);
      // 备注允许是空串——它的含义是「没有备注」，不是「非法入参」。
      const label = payload?.label;
      if (typeof label !== 'string') {
        throw new PanelError('"label" must be a string (use an empty string to clear it)', {
          code: PANEL_ERROR_CODES.BAD_REQUEST,
        });
      }
      await withKeyEdit(pool, () => pool.rename(id, label));
      return { status: 200, body: body() };
    }
    case 'reorder': {
      const ids = readIdList(payload);
      // 未知 id 与重复项由 `PoolStore.reorder` 自己折叠（那里与 `validatePool` 对陈旧
      // order 的处理共用同一套规则），因此这里只检查形状。
      await withKeyEdit(pool, () => pool.reorder(ids));
      return { status: 200, body: body() };
    }
    default:
      throw new PanelError(`unknown key-pool action ${JSON.stringify(action)}`, {
        code: PANEL_ERROR_CODES.UNKNOWN_COMMAND,
        status: 404,
      });
  }
}

/**
 * 「这一把是不是新的」的判定器（`POOL-9`）。
 *
 * 它是这个问题的**唯一一份**答案：`add` 与 `addBatch` 都经它判断，而存储层明确不参与
 * （`PoolStore.addKeys` 的注释：重复与否是领域判断）。比较用**逐字相等**，与添加一致：
 * 不认前缀、不做大小写折叠。Tavily 将来换个前缀形状时，这里跟着失效的会是「去重」而不是
 * 「添加」——把用户粘进来的东西原样存下，永远比猜它合法要好。
 *
 * 一次调用返回的判定器同时覆盖**池内已有**与**这一次已经见过的**：批量添加里第二行与
 * 第一行相同时，第二行不算新增。
 *
 * @param existing - 池中已有密钥的明文。
 * @returns 判定函数：明文此前没见过时记下并返回 true，否则返回 false。
 */
function claimNewKey(existing) {
  const seen = new Set(existing);
  return (key) => {
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  };
}

/**
 * 把粘贴进来的一整块文本切成待添加的密钥（`POOL-8`）。
 *
 * 规则只有三条，且都是「用户粘贴时的实际排版」逼出来的：**一行一把**、**两侧空白不算内容**、
 * **重复的只算一次**。空行不算密钥——从表格或聊天窗口复制出来的文本里，空行是排版而不是
 * 内容，把它当成一把空密钥只会得到一条无从理解的报错。去重走 {@link claimNewKey}，与单把
 * 添加是同一份判据。
 *
 * **重复的判定拿得到明文，返回的却只有计数。** 池里已有的与本次批内重复的走同一条路：
 * 两者都是「这一行不会带来一把新密钥」，而用户需要的是「几把加进去了、几把没加」，不是
 * 一份他刚刚亲手粘贴过的清单（`POOL-3`：任何出口都只有脱敏形式）。
 *
 * 超过长度上限的行**原样留在 `fresh` 里**，只额外报出它的位置与长度：是否拒绝由调用方决定
 * （`addBatch` 拒绝），而这个函数自己不写盘、也不该悄悄把用户给的东西丢掉。
 *
 * @param text - 粘贴的原始文本。
 * @param options - 去重依据。
 * @param options.existing - 池中已有密钥的明文。
 * @returns `{ fresh, duplicates, received, oversized }`：待添加的明文、跳过的重复条数、识别到
 *   的非空行数，以及第一条超长行的 `{ line, length }`（没有时为 `null`；`line` 是原文里的
 *   行号，从 1 起算，用于让拒绝消息指名改哪一行）。
 */
export function parseKeyLines(text, { existing = [] } = {}) {
  const claimNew = claimNewKey(existing);
  const fresh = [];
  let duplicates = 0;
  let oversized = null;

  for (const [index, line] of text.split(/\r?\n/u).entries()) {
    const key = line.trim();
    if (key.length === 0) continue;
    if (oversized === null && key.length > PANEL_KEY_MAX_LENGTH) {
      oversized = { line: index + 1, length: key.length };
    }
    if (claimNew(key)) fresh.push(key);
    else duplicates += 1;
  }

  return { fresh, duplicates, received: fresh.length + duplicates, oversized };
}

/**
 * 改写搜索开关与搜索参数（`CFG-3`、`CFG-4`）。
 *
 * 写入走宿主自己的 settings 服务，因此 `CFG-4` 的校验是**宿主**按我们注册的 schema
 * 做的，不是这里重写一遍。这一点很重要：校验规则只能有一个来源，否则面板放行的值迟早
 * 会与 schema 允许的值分叉。
 *
 * 失败文案**原样透出**（形如 `$.maxResults expected number <= 20 but got 21`）。它是
 * 用户唯一能据以改正的线索，把它换成一句泛化的「保存失败」等于把可操作的诊断丢掉。
 *
 * @param payload - `{ patch }`。
 * @param deps - 面板依赖。
 * @returns `{ status, body }`。
 */
async function runSettingsCommand(payload, deps) {
  const patch = payload?.patch;
  if (patch === null || typeof patch !== 'object' || Array.isArray(patch)) {
    throw new PanelError('"patch" must be an object of settings to merge', {
      code: PANEL_ERROR_CODES.BAD_REQUEST,
    });
  }
  try {
    await deps.writeSettings(patch);
  } catch (error) {
    throw mapSettingsWriteError(error);
  }
  return { status: 200, body: { settings: deps.readSettings() } };
}

/**
 * 刷新余额（`USAGE-1`、`USAGE-2`）。
 *
 * 不传 id 时刷新池内**全部**密钥，含已停用者：停用只影响调度（`POOL-5`），而用户点
 * 「刷新余额」想看的是每一把密钥的实际余量。
 *
 * **`skipped: 'quota'` 必须如实上报。** `USAGE-2` 的滑动窗口预占会挡掉多余调用，而
 * 假装全部刷新成功会让用户以为屏幕上的余额是新鲜的——那正是这个按钮存在的意义。因此
 * 结果逐个返回，跳过、失败、成功三种出口各带自己的状态。
 *
 * 串行而不是并发：配额预占按密钥维度记账，并发只会让「跳过」出现在不可预期的位置，
 * 且一次连点就有机会撞上官方限流。
 *
 * @param payload - `{ id? }`。
 * @param deps - 面板依赖。
 * @returns `{ status, body }`。
 */
async function runRefreshCommand(payload, deps) {
  const pool = requirePool(deps);
  const refresh = requireRefresher(deps);
  const records = pool.keysInOrder();
  const targets = payload?.id === undefined
    ? records
    : [requireRecord(records, readString(payload, 'id'))];

  const results = [];
  for (const record of targets) {
    results.push(describeRefresh(record.id, await refresh(record.id, record.key, { reason: 'manual' })));
  }
  return { status: 200, body: { results } };
}

/**
 * 单密钥连通性测试（`12`）。
 *
 * 打的是 `/usage` 而不是 `/search`：它对单把密钥做完整鉴权校验，且**不消耗搜索积分**。
 * 代价是它受 `USAGE-2` 的配额预占约束——配额用尽时如实返回 `quota` 分类，而不是静默
 * 失败或偷偷改打 `/search`。
 *
 * 分类复用 `04` 的 {@link classifyFailure}，因此「鉴权失败」「被限流」「网络不可达」
 * 与调度路径对同一次失败的理解永远一致。
 *
 * @param payload - `{ id }`。
 * @param deps - 面板依赖。
 * @returns `{ status, body }`。
 */
async function runTestCommand(payload, deps) {
  const pool = requirePool(deps);
  const refresh = requireRefresher(deps);
  const id = readString(payload, 'id');
  const record = requireRecord(pool.keysInOrder(), id);

  const outcome = await refresh(id, record.key, { reason: 'manual' });
  if (outcome.ok === true) {
    return { status: 200, body: { id, ok: true, classification: 'ok', error: null } };
  }
  if (outcome.skipped === 'quota') {
    return {
      status: 200,
      body: {
        id,
        ok: false,
        classification: 'quota',
        error: {
          code: 'TAVILY_USAGE_QUOTA_EXHAUSTED',
          status: null,
          message: 'the /usage quota reserved for this key is exhausted (10 calls per 600s); try again later',
        },
      },
    };
  }
  return { status: 200, body: { id, ok: false, classification: classifyConnectivity(outcome.error), error: describeError(outcome.error) } };
}

/**
 * 把一次刷新结果压成面板要的形状。
 *
 * 刻意**不含** `usage`：官方返回值里的余额已经写进缓存，卡片随后重新读 `/state` 就能
 * 看到它。把同一份数据在同一次响应里再搬一遍，只会多出一条需要同步维护的格式。
 *
 * @param id - 密钥 id。
 * @param outcome - `UsageRefresher.refresh` 的返回值。
 * @returns 可 JSON 序列化的结果项。
 */
function describeRefresh(id, outcome) {
  if (outcome?.ok === true) {
    return { id, ok: true, skipped: null, stale: false, recovered: outcome.recovered === true, error: null };
  }
  return {
    id,
    ok: false,
    skipped: outcome?.skipped ?? null,
    stale: outcome?.stale === true,
    recovered: false,
    error: describeError(outcome?.error),
  };
}

/**
 * 把一次连通性失败归到用户能据以行动的一类（`12`）。
 *
 * 先经 `04` 的分类器，再把它的动作与状态码翻成这里的词表。**不在这里重新读状态码做
 * 判断**：那样会得到第二份「401 算不算鉴权问题」的答案，而两份答案迟早会分叉。
 *
 * 与 `classifyFailure` 的差别只在措辞粒度：那里关心「下一步对这把密钥做什么」
 * （冷却 / 排除 / 放弃），这里关心「用户该去改什么」。`429` 与 `401` 在那边都归入冷却，
 * 在这里必须分开——一个要等，一个要换密钥。
 *
 * @param error - 刷新的失败原因。
 * @returns `ok` 除外的分类词：`auth` / `rate-limited` / `exhausted` / `upstream` / `network` / `fatal` / `aborted`。
 */
export function classifyConnectivity(error) {
  const failure = classifyFailure({
    status: error?.status,
    detail: error?.detail,
    code: error?.code,
    retryAfter: error?.retryAfter,
  });
  if (failure.action === 'aborted') return 'aborted';
  if (failure.action === 'invalid') return 'auth';
  if (failure.action === 'exhausted') return 'exhausted';
  if (failure.action === 'fatal') return 'fatal';
  if (failure.status === 401 || failure.status === 403) return 'auth';
  if (failure.status === 429) return 'rate-limited';
  if (typeof failure.status === 'number' && failure.status >= 500) return 'upstream';
  return 'network';
}

/**
 * 把一次失败压成不含敏感信息的描述。
 *
 * `Error` 直接 JSON 序列化会得到 `{}`，因此必须显式取字段。只取上游给的诊断信息：
 * `TavilyError` 从不在消息里放密钥，这一点由 `lib/tavily.js` 保证。
 *
 * @param error - 失败原因。
 * @returns 可 JSON 序列化的错误描述；无错误时返回 `null`。
 */
function describeError(error) {
  if (error === null || error === undefined) return null;
  return {
    code: typeof error.code === 'string' ? error.code : null,
    status: Number.isInteger(error.status) ? error.status : null,
    detail: typeof error.detail === 'string' ? error.detail : null,
    retryAfter: typeof error.retryAfter === 'string' ? error.retryAfter : null,
    message: typeof error.message === 'string' ? error.message : String(error),
  };
}

/**
 * 把宿主的 settings 写入失败翻成面板错误。
 *
 * 两处必须保留原文：schema 拒绝的文案（用户据此改正取值）与冲突的语义（用户在别处
 * 改了同一项）。其余一律按 400 处理——settings 的写入路径上，入参不合格是绝大多数情形，
 * 而把一个内部故障报成 400 至少不会让用户以为「保存成功了」。
 *
 * @param error - `settings.update` 的拒绝原因。
 * @returns {PanelError} 可直接抛出的面板错误。
 */
function mapSettingsWriteError(error) {
  if (error instanceof PanelError) return error;
  if (error?.code === 'SETTINGS_CONFLICT') {
    return new PanelError(error.message, {
      code: PANEL_ERROR_CODES.SETTINGS_CONFLICT,
      status: 409,
      cause: error,
    });
  }
  if (error?.code === PANEL_ERROR_CODES.UNAVAILABLE) {
    return new PanelError(error.message, {
      code: PANEL_ERROR_CODES.UNAVAILABLE,
      status: 503,
      cause: error,
    });
  }
  return new PanelError(error?.message ?? String(error), {
    code: PANEL_ERROR_CODES.INVALID_SETTINGS,
    status: 400,
    cause: error,
  });
}

/** 密钥池的编辑失败：落盘失败是 500，id 不存在是 404，两者都不是「入参非法」。 */
async function withKeyEdit(pool, edit) {
  try {
    await edit();
  } catch (error) {
    if (error instanceof PanelError) throw error;
    if (error instanceof RangeError) {
      throw new PanelError(error.message, { code: PANEL_ERROR_CODES.NO_SUCH_KEY, status: 404, cause: error });
    }
    if (error?.code === PANEL_ERROR_CODES.UNAVAILABLE) {
      throw new PanelError(error.message, { code: PANEL_ERROR_CODES.UNAVAILABLE, status: 503, cause: error });
    }
    throw new PanelError(describeKeyEditFailure(pool, error), {
      code: PANEL_ERROR_CODES.KEY_EDIT_FAILED,
      status: 500,
      cause: error,
    });
  }
}

/**
 * 把一次密钥池写入失败翻成**按白名单构造**的对外文案。
 *
 * 这里必须自己拼消息，不能把 fs 的原文透出去：`EACCES: permission denied, open '/Users/…/
 * keys.json.66473.d80cb783-….tmp'` 那句原文同时带着运行账户的绝对状态目录、进程 pid 与内部
 * 临时文件名，而这条消息会被卡片渲染到界面上（`panel-http-6`）。
 *
 * 白名单只有三项，每一项都是排障真正用得上、且**不含用户环境信息**的：errno（`EACCES` /
 * `EISDIR` / `ENOSPC` 这些能直接拿去搜索的机器码）、失败的 syscall（`open` 失败是建不出临时
 * 文件，`rename` 失败是换不掉目标）、以及**文件名**（`keys.json`，不带目录）。它们之外的一切
 * ——绝对路径、pid、随机 uuid、`.tmp` 后缀——都不出现。
 *
 * 换成一句泛化的「内部错误」是另一头的错：面板接口是排障入口，errno 与文件名正是用户与
 * 维护者唯一的线索。原文并没有丢——它作为 `cause` 留在抛出的 `PanelError` 上，在进程内可查。
 *
 * @param pool - 密钥池；文件名取自它的路径，因此报出来的是**它真正在写的那一个**。
 * @param error - 落盘失败的原因。
 * @returns 只含白名单字段的英文文案。
 */
function describeKeyEditFailure(pool, error) {
  return `writing the key pool file ${basename(pool.filePath)} failed: ${describeWriteFailure(error)}`
    + '; check that the plugin state directory is writable by the process running DSH and that the disk has free space';
}

/**
 * 一个 fs 错误的可外发摘要。
 *
 * 三个字段各自按**形状**判定，而不是按取值枚举：errno 是 libuv 的定长机器码，syscall 是小写
 * 标识符，`name` 是构造器名。三者都不可能装下路径或 pid，因此不必再逐个清洗。
 *
 * @param error - 落盘失败的原因。
 * @returns 形如 `EACCES during rename` 的英文片段。
 */
function describeWriteFailure(error) {
  const errno = typeof error?.code === 'string' && /^E[A-Z0-9]+$/u.test(error.code) ? error.code : null;
  if (errno === null) {
    const name = typeof error?.name === 'string' && /^[A-Za-z][A-Za-z0-9]*$/u.test(error.name) ? error.name : null;
    return name ?? 'an unknown error';
  }
  const syscall = typeof error?.syscall === 'string' && /^[a-z]+$/u.test(error.syscall) ? error.syscall : null;
  return syscall === null ? errno : `${errno} during ${syscall}`;
}

/**
 * 一把明文超过长度上限时以入参非法拒绝（`panel-http-4`）。
 *
 * 上限是**拒绝**而不是截断：截断后的字符串既不是用户给的密钥、也不会是别的合法密钥，而用户
 * 会以为它写进去了。消息里必须同时有上限、实收长度与位置——只说「太长」的消息没法让人判断
 * 该删掉哪一行。
 *
 * @param length - 实收长度。
 * @param where - 这一把在请求里的位置，用于让用户知道去改哪里。
 * @throws {PanelError} 超限时抛出 400。
 */
function requireKeyLength(length, where) {
  if (length <= PANEL_KEY_MAX_LENGTH) return;
  throw new PanelError(
    `each Tavily API key must be at most ${PANEL_KEY_MAX_LENGTH} characters, but ${where} is ${length}`
    + ': check what was pasted; nothing was written to the key pool',
    { code: PANEL_ERROR_CODES.BAD_REQUEST },
  );
}

/**
 * 这次要写入的新密钥是否会撑破池内总数上限（`panel-http-4`）。
 *
 * 容量是「{@link PANEL_KEYS_MAX} 减去池里已有」，因此池子满了之后**添加**被拒，而删除、读取
 * 与去重判定照常——上限是为了让池子回到可用规模，不是为了把它锁死。
 *
 * @param pool - 密钥池。
 * @param incoming - 这次要写进去的新密钥条数。
 * @throws {PanelError} 放不下时抛出 400。
 */
function requireCapacity(pool, incoming) {
  const held = pool.keysInOrder().length;
  if (held + incoming <= PANEL_KEYS_MAX) return;
  throw new PanelError(
    `the key pool already holds ${held} keys and adding ${incoming} would exceed the maximum of ${PANEL_KEYS_MAX}`
    + ': remove some keys from the pool and add again; nothing was written',
    { code: PANEL_ERROR_CODES.BAD_REQUEST },
  );
}

/** 取密钥池；插件没加载完时以 503 拒绝，而不是抛一个 TypeError。 */
function requirePool(deps) {
  if (deps?.pool === undefined || deps.pool === null) {
    throw new PanelError('the key pool is unavailable because the plugin did not finish loading', {
      code: PANEL_ERROR_CODES.UNAVAILABLE,
      status: 503,
    });
  }
  return deps.pool;
}

/** 取余额刷新器；它属于插件初始化的一部分，缺席同样是 503。 */
function requireRefresher(deps) {
  if (typeof deps?.refresh !== 'function') {
    throw new PanelError('the balance refresher is unavailable because the plugin did not finish loading', {
      code: PANEL_ERROR_CODES.UNAVAILABLE,
      status: 503,
    });
  }
  return deps.refresh;
}

/** 从池中取一把密钥；不存在时以 404 拒绝。 */
function requireRecord(records, id) {
  const record = records.find((candidate) => candidate.id === id);
  if (record === undefined) {
    throw new PanelError(`no key with id ${JSON.stringify(id)} in the pool`, {
      code: PANEL_ERROR_CODES.NO_SUCH_KEY,
      status: 404,
    });
  }
  return record;
}

/** 读一个必填字符串字段。 */
function readString(payload, field) {
  const value = payload?.[field];
  if (typeof value !== 'string' || value.length === 0) {
    throw new PanelError(`${JSON.stringify(field)} must be a non-empty string`, {
      code: PANEL_ERROR_CODES.BAD_REQUEST,
    });
  }
  return value;
}

/** 读一个可选字符串字段；缺席或空串都算「没有」。 */
function readOptionalString(payload, field) {
  const value = payload?.[field];
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

/**
 * 读一个 id 列表。
 *
 * `reorder` 与 `removeBatch` 共用它：两处要的都是「一串 id」，而**只检查形状**——未知 id 与
 * 重复项由各自的领域规则折叠（`reorder` 丢掉未知项，`removeBatch` 折叠重复项并让未知 id 走
 * 404），在这里再判一遍只会多出第二份答案。
 *
 * @param payload - 请求载荷。
 * @returns 字符串 id 数组，原样且原序。
 */
function readIdList(payload) {
  const ids = payload?.ids;
  if (!Array.isArray(ids) || ids.some((id) => typeof id !== 'string')) {
    throw new PanelError('"ids" must be an array of key ids', { code: PANEL_ERROR_CODES.BAD_REQUEST });
  }
  return ids;
}

/** 读一个必填的密钥 id，并确认它在池中存在。 */
function requireKeyId(pool, payload) {
  return requireRecord(pool.keysInOrder(), readString(payload, 'id')).id;
}

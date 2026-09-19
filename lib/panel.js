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
 * `poolError` 是密钥池文件不可用时的报告（`POOL-7`）。
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
 * @returns 可 JSON 序列化的面板状态，**不含任何密钥明文**。
 */
export function readPanelState({ settings, pool, capabilityReport, fallback }) {
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
  };
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
 * 密钥池的增删改启停排序（`POOL-4`）。
 *
 * 每条命令都返回**完整**的脱敏列表，而不是只返回被动的那一项：卡片据此重绘，于是
 * 「排序」「启停」这类会改变其他行位置的操作不必让前端自己推断新顺序——顺序的权威在
 * 密钥池文件里，前端再算一遍只会多出一份可能分叉的推断。
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
      const label = readOptionalString(payload, 'label');
      await withKeyEdit(() => pool.addKey({ key: key.trim(), label }));
      return { status: 200, body: body() };
    }
    case 'remove': {
      const id = requireKeyId(pool, payload);
      await withKeyEdit(() => pool.removeKey(id));
      return { status: 200, body: body() };
    }
    case 'setDisabled': {
      const id = requireKeyId(pool, payload);
      if (typeof payload?.disabled !== 'boolean') {
        throw new PanelError('"disabled" must be a boolean', { code: PANEL_ERROR_CODES.BAD_REQUEST });
      }
      await withKeyEdit(() => pool.setDisabled(id, payload.disabled));
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
      await withKeyEdit(() => pool.rename(id, label));
      return { status: 200, body: body() };
    }
    case 'reorder': {
      const ids = payload?.ids;
      if (!Array.isArray(ids) || ids.some((id) => typeof id !== 'string')) {
        throw new PanelError('"ids" must be an array of key ids', { code: PANEL_ERROR_CODES.BAD_REQUEST });
      }
      // 未知 id 与重复项由 `PoolStore.reorder` 自己折叠（那里与 `validatePool` 对陈旧
      // order 的处理共用同一套规则），因此这里只检查形状。
      await withKeyEdit(() => pool.reorder(ids));
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
async function withKeyEdit(edit) {
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
    throw new PanelError(`the key pool could not be written: ${String(error?.message ?? error)}`, {
      code: PANEL_ERROR_CODES.KEY_EDIT_FAILED,
      status: 500,
      cause: error,
    });
  }
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

/** 读一个必填的密钥 id，并确认它在池中存在。 */
function requireKeyId(pool, payload) {
  return requireRecord(pool.keysInOrder(), readString(payload, 'id')).id;
}

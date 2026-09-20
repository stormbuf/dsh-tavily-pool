/**
 * 面板 HTTP 接口的宿主适配层（`PANEL-4`）。
 *
 * 挂在 `ctx.connection.fetch.register` 上的 `/api` 精确路由：Connection 在把请求交给
 * 这条路由**之前**就已经应用了 Host/Origin fence 与 cookie 鉴权，因此这里一行鉴权代码
 * 都不写——自己再判一次 401/403 只会得到第二份「什么算已鉴权」的答案。
 *
 * 本文件只做机械转换：`Request` → 命令载荷，`{status, body}` → `Response`。所有判断
 * （脱敏、校验、错误码、配额跳过）都在 `lib/panel.js`，那里不认识 HTTP，因此可以在
 * `node:test` 下直接覆盖。
 *
 * **路径只注册一次。** Connection 对同一路径的第二次注册会抛错，因此这里刻意不做「已存在
 * 就跳过」的幂等包装：那会把一次真实的重复注册伪装成成功，让两处代码争夺同一条路由而不留
 * 痕迹。
 *
 * 「重复注册不会发生」靠的是**宿主**的行为：`HostConnectionService.registerFetchRoute` 内部
 * 就是 `owner.effect(...)`，而 `owner` 是读取该服务的那个 context——也就是本插件的 fiber。
 * 因此插件 fiber 卸载时这些路由随之摘除，重新加载不会撞上重复注册。注意这是**宿主的**保证，
 * 不是本文件做了 `ctx.effect`：本文件不持有 disposer，也不该持有（多一层会让「谁负责摘除」
 * 出现两个答案）。它属于 ADR-0003 的第 11 个耦合点，升级时按那里的清单复核。
 *
 * @module dsh-tavily-pool/dsh/panel-routes
 */

import { PANEL_ERROR_CODES, PANEL_HISTORY_ENTRIES, PanelError, readPanelState, runPanelCommand } from '../panel.js';
import { probeCapabilities } from './capabilities.js';
import { describeOfficialCredential } from './fallback.js';
import { ensurePoolLoaded } from './pool-load.js';
import { readService } from './read-service.js';
import { readPluginSettings, writePluginSettings } from './settings.js';

/**
 * 面板路由的绝对路径。
 *
 * 与宿主的既有路由同一命名法（`/api/present.open`）：都用 `.` 分隔「谁的」与「哪个
 * 资源」，因此一条 URL 自身就说清了归属。段名只含字母、数字与 `-`，符合 Connection
 * 对路径段的字符约束。
 */
export const PANEL_ROUTE_PATHS = Object.freeze({
  state: '/api/tavily-pool.state',
  keys: '/api/tavily-pool.keys',
  settings: '/api/tavily-pool.settings',
  refresh: '/api/tavily-pool.refresh',
  test: '/api/tavily-pool.test',
});

/** 需要请求体的命令，各自对应一条 POST 路由。 */
const POST_COMMANDS = Object.freeze(['keys', 'settings', 'refresh', 'test']);

/**
 * 注册面板 HTTP 接口。
 *
 * 返回 `false` 而不是抛错，是因为 `connection` 是一项**可选**能力：宿主形状变了的时候
 * 搜索必须照常可用（`PIN-5`），面板缺席只是少了一个配置入口。缺失本身会被能力探测
 * 记为 `connection.fetch.register` 并上报（`COMPAT-2`、`COMPAT-3`）。
 *
 * @param ctx - 插件 context。
 * @param state - 插件运行期状态；路由**惰性**读取它，因此注册可以早于协作者的构造，
 *   而 `state.pool` 之类的字段在请求到达时已经就位。
 * @returns 注册成功时返回 true；宿主没有该能力时返回 false。
 */
export function registerPanelRoutes(ctx, state) {
  const connection = readService(ctx, 'connection');
  const register = connection?.fetch?.register;
  if (typeof register !== 'function') return false;

  register.call(connection.fetch, {
    path: PANEL_ROUTE_PATHS.state,
    methods: ['GET'],
    requestBody: 'buffered',
    fetch: (request) => handlePanelRequest(ctx, state, 'state', request),
  });
  for (const command of POST_COMMANDS) {
    register.call(connection.fetch, {
      path: PANEL_ROUTE_PATHS[command],
      methods: ['POST'],
      requestBody: 'buffered',
      fetch: (request) => handlePanelRequest(ctx, state, command, request),
    });
  }
  return true;
}

/**
 * 处理一次面板请求。
 *
 * **每一条命令都先确保密钥池已加载**（`POOL-1`、ticket `21`）。这一步不是优化而是正确性前提：
 * 加载是惰性的、且只有搜索与抓取路径会触发它，于是进程重启后只要还没搜索过，面板读到的就是
 * **空的内存池**——而它**写**的时候用的也是那份空池，一次「添加密钥」会把磁盘上原有的密钥
 * 全部抹掉（2026-09-20 在隔离实例上复现：磁盘 3 把 → 加入一把之后只剩 1 把）。用户看到的现象
 * 是「重启之后密钥不见了」，而数据其实一直在文件里。
 *
 * 任何抛出都在这里变成响应：面板接口坏掉不该在宿主日志里留下一串未处理的 rejection，
 * 而用户需要的是「哪一步失败了」，不是空白。
 *
 * @param ctx - 插件 context。
 * @param state - 插件运行期状态。
 * @param command - 命令名。
 * @param request - 已通过鉴权的请求。
 * @returns HTTP 响应。
 */
async function handlePanelRequest(ctx, state, command, request) {
  try {
    await ensurePoolLoaded(state);
    if (command === 'state') return json(200, await panelState(ctx, state));
    const result = await runPanelCommand(command, await decodeBody(request), panelDeps(ctx, state));
    return json(result.status, result.body);
  } catch (error) {
    return errorResponse(error);
  }
}

/**
 * 组装面板状态。
 *
 * 回落目标那一段是**异步**的：它要经 credentials 服务与启动环境走一遍凭据解析才能说
 * 出「未配置」还是「已配置」（`CFG-5`）。把它缓存在内存里会让用户在 Models 页配好凭据
 * 之后，面板一直显示旧结论——而这正是他会回来再看一眼的时刻。
 *
 * @param ctx - 插件 context。
 * @param state - 插件运行期状态。
 * @returns 可 JSON 序列化的面板状态。
 */
async function panelState(ctx, state) {
  // 调用历史（`14`）是**异步**读的：它每次现读磁盘（见 `lib/history.js` 的类注释——历史不被
  // 长期持有，因为面板读到旧一份没有任何代价，而永远重读让两个进程不会互相覆盖）。
  const history = await readHistory(state);
  return readPanelState({
    settings: readPluginSettings(ctx),
    pool: state.pool,
    history,
    // **当场探测**而不是读一份加载期缓存：三项注入服务要到 profile 组合完成之后才可见
    // （实测时序见 `index.js`），缓存下来的那份会在插件刚加载完的那几秒里谎报缺失。
    capabilityReport: probeCapabilities({ ctx }),
    // 预算的来源（`host-contract-2`）：读到了宿主绑定的值还是退回了常量，是「宿主收紧
    // timeout 之后我们有没有跟着收」这个问题的唯一观测面。它由搜索/抓取路径在每次调用时
    // 写下，因此这里读的是**最近一次**读数；一次都还没搜过时它是 `undefined`，投影成 `null`。
    hostBudget: state.hostBudget,
    fallback: {
      target: 'deepseek-official',
      reason: state.reportedFallbackReason ?? null,
      lastFailureAt: state.lastFallbackFailure?.at ?? null,
      ...await describeOfficialCredential(ctx, { lastFailureCode: state.lastFallbackFailure?.code }),
    },
  });
}

/**
 * 读回调用历史，失败时如实带出原因（`14`）。
 *
 * `CallHistory.read()` 对损坏的文件返回空数组并把错误挂在 `readError` 上（历史是展示用的，
 * 不该让面板变成一片 500）。这里把那个错误**原样交给面板**而不是吞掉：一份读不出来的历史
 * 与一份空历史在屏幕上长得一样，而用户需要知道是前者。
 *
 * @param state - 插件运行期状态。
 * @returns `{ entries, error }`。
 */
async function readHistory(state) {
  if (state.history === undefined) return { entries: [], error: null };
  const entries = await state.history.recent(PANEL_HISTORY_ENTRIES);
  return {
    entries,
    error: state.history.readError === undefined ? null : String(state.history.readError),
  };
}

/**
 * 面板命令的依赖。
 *
 * 把「怎么读设置」「怎么刷新余额」做成 thunk 交给 `lib/panel.js`，是为了让那个模块对
 * 宿主一无所知：它不知道 settings 服务长什么样，也不需要知道。
 *
 * @param ctx - 插件 context。
 * @param state - 插件运行期状态。
 * @returns 面板命令依赖。
 */
function panelDeps(ctx, state) {
  return {
    pool: state.pool,
    readSettings: () => readPluginSettings(ctx),
    writeSettings: (patch) => writePluginSettings(ctx, patch),
    refresh: state.usageRefresher === undefined
      ? undefined
      : (id, key, options) => state.usageRefresher.refresh(id, key, options),
  };
}

/**
 * 解码请求体。
 *
 * 空体返回 `undefined` 而不是抛错：`refresh` 不带 id 就是「刷新全部」，那是一条合法的
 * 空请求。至于是不是每一条命令都允许空体，由命令自己判断——它才知道自己需要什么。
 *
 * @param request - 请求。
 * @returns 解码后的载荷，或 `undefined`。
 * @throws {PanelError} 请求体不是合法 JSON 时抛出。
 */
async function decodeBody(request) {
  const text = await request.text();
  if (typeof text !== 'string' || text.trim().length === 0) return undefined;
  try {
    return JSON.parse(text);
  } catch (error) {
    throw new PanelError(`the request body is not valid JSON: ${String(error.message)}`, {
      code: PANEL_ERROR_CODES.BAD_REQUEST,
      cause: error,
    });
  }
}

/**
 * 把任意抛出编成响应。
 *
 * `message` **原样透出**，因为构造它的那一层已经按白名单筛过：`lib/panel.js` 的
 * `withKeyEdit` 把 fs 的原文翻成「errno + 文件名 + 下一步」，剥掉了绝对路径、进程 pid 与
 * `.tmp` 临时文件名（`panel-http-6`）。这里因此一行改写都不做——把它换成一句泛化的
 * 「内部错误」会让用户与维护者同时失去唯一的线索，而在这里再清洗一遍会多出第二份
 * 「什么能外发」的答案。
 *
 * @param error - 抛出值。
 * @returns HTTP 响应。
 */
function errorResponse(error) {
  const status = Number.isInteger(error?.status) && error.status >= 400 && error.status <= 599
    ? error.status
    : 500;
  return json(status, {
    error: {
      code: typeof error?.code === 'string' ? error.code : 'PANEL_INTERNAL_ERROR',
      message: typeof error?.message === 'string' ? error.message : String(error),
    },
  });
}

/**
 * 编一个 JSON 响应。
 *
 * `no-store` 是必需的：余额与密钥列表随时会变，而浏览器缓存一个 `GET` 的 JSON 响应
 * 会让用户在点完「刷新余额」之后仍然看到旧值。
 *
 * @param status - HTTP 状态码。
 * @param body - 响应体。
 * @returns HTTP 响应。
 */
function json(status, body) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
    },
  });
}

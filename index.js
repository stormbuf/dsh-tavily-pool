/**
 * dsh-tavily-pool —— 用 Tavily 承载 DeepSeek Harness 的 `web_search`。
 *
 * 本文件是 harness 加载的插件入口。它只做三件事，其余全部委派出去：
 *
 * 1. 注册搜索提供方，且放在**最前**，先于任何可能失败的步骤（`PIN-5`，硬约束 5）；
 * 2. 在 `try`/`catch` 内构造面向宿主的协作者（能力探测、设置、状态目录、密钥池、
 *    调度器），使注册之后的失败退化为「半坏的插件」而不是一次搜索中断；
 * 3. 交给提供方一个 thunk，每次搜索时读取当前状态，于是配置变更无需重新注册任何
 *    东西即可生效。
 *
 * 最要紧的细节是 `available()`。由于 `cordis.patch.yml` 把 `searchProvider` 静态
 * pin 住，一个自称不可用的提供方会导致硬抛 `WEB_PROVIDER_CONFIGURED_UNAVAILABLE`，
 * 而不是回落。因此所有真正的判断都活在 `search()` 里。
 *
 * @module dsh-tavily-pool
 */

import z from '@deepseek-ai/schemastery';

import { runWithFailover } from './lib/attempts.js';
import {
  FETCH_TOTAL_BUDGET_MS,
  HISTORY_FILE_NAME,
  HOST_BUDGET_MARGIN_MS,
  KEYS_FILE_NAME,
  MIN_ATTEMPT_TIMEOUT_MS,
  SEARCH_TOTAL_BUDGET_MS,
  SETTINGS_NAMESPACE,
  TAVILY_TIMEOUT_MS,
} from './lib/constants.js';
import { KeyHealth } from './lib/health.js';
import { CallHistory } from './lib/history.js';
import { PoolStore, maskKey } from './lib/pool.js';
import { Scheduler } from './lib/scheduler.js';
import { searchParamsOf, effectiveMaxResults } from './lib/settings.js';
import { TavilyError, extractTavily, searchTavily } from './lib/tavily.js';
import { UsageQuota, UsageRefresher } from './lib/usage.js';
import { probeCapabilities, describeMissingCapabilities } from './lib/dsh/capabilities.js';
import { officialFetchProvider, searchWithOfficialProvider } from './lib/dsh/fallback.js';
import { TavilyFetchProvider } from './lib/dsh/fetch-provider.js';
import { resolveStateDir } from './lib/dsh/home-path.js';
import { effectiveBudgetMs, readHostToolBudgetMs } from './lib/dsh/host-budget.js';
import { bindHostServices, hostView } from './lib/dsh/host-services.js';
import { registerPanelRoutes } from './lib/dsh/panel-routes.js';
import { ensurePoolLoaded } from './lib/dsh/pool-load.js';
import { registerFetchProvider, registerSearchProvider } from './lib/dsh/register.js';
import { TavilySearchProvider } from './lib/dsh/search-provider.js';
import { readPluginSettings, registerSettings } from './lib/dsh/settings.js';

/** Cordis 插件名，供 loader 诊断使用。 */
export const name = 'tavily-pool';

/**
 * 本插件注册进的那个 seam。
 *
 * 声明为依赖，是因为 `web` 行的配置属于 profile patch 的一部分：改动它会重建服务
 * 实例并清空提供方注册表，而只有这条声明才能让 harness 重新执行 `apply()` 把它填
 * 回去。少了它，提供方会无声消失。
 */
export const inject = ['web'];

/**
 * 本插件所在行（row）的组合配置。
 *
 * 为空，是因为所有面向用户的设置都放在 `dsh-tavily-pool` 设置命名空间里，那里改动
 * 即时生效且会出现在面板上。它仍然被声明、且不可为空：行的 `config` 会先经这份
 * schema 校验，再交给 `apply()`，因此一个形状错误的值（字符串而非对象）会在加载期
 * 以 loader 自己的诊断失败，而不是未经检查地递进来。
 */
export const Config = z.object({});

/**
 * 插件运行期的可变状态。
 *
 * @typedef {object} PluginState
 * @property {object} ctx - 插件 context。
 * @property {object} host - {@link hostView} 给出的 context 视图；`lib/dsh/` 的其余模块
 *   一律经它读取宿主服务，因为 `settings` / `connection` / `credentials` 三项在插件本体的
 *   context 上根本看不见（实测见 `lib/dsh/host-services.js`）。
 * @property {string|undefined} reportedCapabilities - 已经上报过的那份能力缺失清单。去重是
 *   必需的：探测会在多个时机重跑（每个服务就绪时、第一次搜索时），而「缺了什么」是个持续
 *   状态，每次搜索都刷一遍只会把真正新发生的事淹掉。
 * @property {PoolStore|undefined} pool
 * @property {KeyHealth|undefined} health
 * @property {Scheduler|undefined} scheduler
 * @property {UsageRefresher|undefined} usageRefresher
 * @property {CallHistory|undefined} history - 调用历史（`14`）。
 * @property {Promise<void>|undefined} poolLoad
 * @property {Error|undefined} initError
 * @property {string|undefined} reportedPoolLoadError - 已经报告过的那次密钥池读取失败的
 *   消息，用于让一个持续存在的坏文件只产生一条日志，而不是每次搜索各一条。
 * @property {string|undefined} reportedFallbackReason - 已经报告过的那次回落原因，同样
 *   用于去重：一次成功的回落会让请求静默地走上官方提供方，因此它必须留下痕迹，但同一个
 *   原因不该每次搜索都刷一遍。
 * @property {string|undefined} reportedFetchFallbackReason - 抓取回落的原因，去重规则与
 *   上一条相同，但**分开记**：两个开关各自控制一条路径，共用一个字段会让「关掉抓取开关」
 *   把上一次「搜索开关关了」的记录覆盖掉，于是改回搜索时又刷一遍同一条日志。
 * @property {{code: string, at: string}|undefined} lastFallbackFailure - 最近一次回落
 *   **失败**的机器码与时刻。面板据它区分「官方凭据未配置」与「官方凭据已失效」
 *   （`CFG-5`）——那两者的区别只有一次真实失败才能提供，探测只能说「有值」。
 *   它描述的是**此刻仍然成立**的结论：一次成功的回落会清掉它（那是官方反过来接受了
 *   这把凭据的直接证据），`MISSING` 档同样不留痕。
 * @property {boolean|undefined} panelRegistered - 面板 HTTP 接口是否已注册。
 * @property {{search?: {budgetMs: number, source: string, hostSource: string}, fetch?: {budgetMs: number, source: string, hostSource: string}}|undefined}
 *   hostBudget - 最近一次为每条路径定下的总预算与它的来源（`host-contract-2`）：`source`
 *   为 `'host'` 表示取自宿主绑定的 tool `timeoutMs`，`'constant'` 表示退回本插件的常量。
 *   它只是**观测**，不参与决策——决策读的是那次调用的返回值。
 */

/**
 * 向宿主注册 Tavily 搜索提供方。
 *
 * @param ctx - 插件 context。
 * @param _config - 校验后的组合配置；目前未使用。
 */
export function apply(ctx, _config) {
  /** @type {PluginState} */
  const state = {
    ctx,
    host: undefined,
    pool: undefined,
    health: undefined,
    scheduler: undefined,
    usageRefresher: undefined,
    history: undefined,
    poolLoad: undefined,
    initError: undefined,
    reportedPoolLoadError: undefined,
    reportedFallbackReason: undefined,
    reportedFetchFallbackReason: undefined,
    lastFallbackFailure: undefined,
    panelRegistered: undefined,
    reportedCapabilities: undefined,
    hostBudget: undefined,
  };

  // 刻意作为第一条效果语句（硬约束 5）：profile patch 把 searchProvider pin 到本插件，
  // 因此一个加载了却没注册的插件会让每次搜索都抛
  // WEB_PROVIDER_CONFIGURED_MISSING。上面的 provider 构造与状态字面量都不会失败；
  // 一切可能失败的事都在下面。
  registerSearchProvider(ctx, new TavilySearchProvider((request, signal) => search(state, request, signal)));

  // 抓取提供方同理，但**包在 `try` 里**：`web.registerFetchProvider` 是可选能力
  // （`lib/dsh/capabilities.js`），宿主少了它只该让 `web_fetch` 走官方提供方，不该连
  // 搜索一起拖下水。注册本身仍然发生在任何可能失败的事之前——它是这一段里第一件做的事。
  try {
    registerFetchProvider(ctx, new TavilyFetchProvider((request, signal) => fetchUrl(state, request, signal)));
  } catch (error) {
    report(
      ctx,
      'warn',
      `dsh-tavily-pool: could not register the Tavily fetch provider, so web_fetch keeps using the `
      + `host's own provider; search is unaffected: ${String(error)}`,
    );
  }

  // `settings` / `connection` / `credentials` 三项**必须经 `ctx.inject` 才能看见**
  // （实测见 `lib/dsh/host-services.js` 的表），而插件自己的 `inject` 是全有或全无的：
  // 写进去就等于「宿主缺任何一项，搜索一并不可用」，那违背 `PIN-5`。因此这里按服务逐个
  // 绑，缺一项只丢那一项。
  //
  // 回调**不是**同步的：它们要等整个 profile 组合完成才跑（时序见下面那段注释），因此
  // 每一处需要「服务已就绪」的判断都只能放在回调里。
  const services = {};
  state.host = hostView(ctx, services);
  bindHostServices(ctx, services, {
    settings: () => {
      // 命名空间不可重复注册。重复注册会抛错，而它说明的是「我们注册了两次」——一个真实
      // 的缺陷，不该被吞掉；但也不该把搜索一起关掉，所以只上报，不设 `initError`。
      try {
        registerSettings(state.host);
      } catch (error) {
        report(ctx, 'warn', `dsh-tavily-pool: could not register the settings namespace: ${String(error)}`);
      }
      refreshCapabilities(state);
    },
    connection: () => {
      registerPanelRoutesSafely(state);
      refreshCapabilities(state);
    },
  });

  try {
    state.pool = new PoolStore({ dir: resolveStateDir(state.host), fileName: KEYS_FILE_NAME });
    state.health = new KeyHealth({ pool: state.pool });
    // 策略以**函数**交给调度器：它每次决策都读一次当前设置，于是面板上换策略即时生效，
    // 而插件不必为了携带新值去重新注册提供方（`SCHED-7`）。
    state.scheduler = new Scheduler({
      pool: state.pool,
      health: state.health,
      policy: () => readPluginSettings(state.host).schedulingPolicy,
    });
    state.usageRefresher = new UsageRefresher({
      pool: state.pool,
      health: state.health,
      quota: new UsageQuota(),
      // 与搜索共用 `globalThis.fetch`：两者都是对同一个 API 的出站请求，测试里替换
      // 一次就该同时覆盖它们，而不是留下一条绕开替换的隐藏通道。
      fetchImpl: (...args) => globalThis.fetch(...args),
    });
    // 调用历史（`14`）。它读盘失败、写盘失败都只上报：历史是记录，不是正确性前提。
    state.history = new CallHistory({ dir: resolveStateDir(state.host), fileName: HISTORY_FILE_NAME });
  } catch (error) {
    state.initError = error;
    report(ctx, 'warn', `dsh-tavily-pool: initialization failed, continuing with search registered: ${String(error)}`);
  }

  // 能力探测**不能**在这里同步做。
  //
  // `settings` / `connection` / `credentials` 三项只能经 `ctx.inject` 取得，而它的回调要等到
  // 整个 profile 组合完成之后才跑。2026-09-19 在隔离的 `dsh web` 实例里实测（毫秒为相对
  // 进程启动的时刻）：
  //
  //     apply:start @+817   apply:end @+817   microtask @+1417
  //     setTimeout(0) @+3373                   inject:settings @+3385
  //
  // 也就是说同步探测（乃至任何固定延时）都会把这三项报成缺失，而它们随后就到了——那会把
  // 「一切正常」报成「宿主坏了一半」。因此探测挂在**真实事件**上：每个服务就绪时刷新一次，
  // 第一次搜索时再刷新一次（覆盖「三项一个都没到」的退化和「压根没有 inject 回调」的宿主）。
  //
  // 面板读到的那份是**当场探测**的，不经这里缓存（见 `lib/dsh/panel-routes.js`），因此面板
  // 永远准。
}

/**
 * 跑一次能力探测，并在「缺了什么」这件事发生变化时上报一次。
 *
 * 探测挂在真实事件上而不是某个延时上：注入回调就绪时各跑一次、第一次搜索时再跑一次。
 * 去重按**消息文本**：它描述的是一个持续状态，每次搜索都刷一遍只会把真正新发生的事淹掉；
 * 而清单真的变了（例如某个服务随后到位）时会重新记一条，那条恰好是最有价值的。
 *
 * 探测本身永不抛出（它经 `ctx.get` 读取，缺失时返回 `undefined`），因此不必包 `try`。
 * 空清单在 {@link report} 里本来就被忽略——能力齐备时不该留下任何日志。
 *
 * @param state - 插件运行时状态。
 */
function refreshCapabilities(state) {
  const message = describeMissingCapabilities(probeCapabilities({ ctx: state.host }));
  if (message === state.reportedCapabilities) return;
  state.reportedCapabilities = message;
  report(state.host, 'warn', message);
}

/**
 * 注册面板 HTTP 接口，失败只上报。
 *
 * 面板是一项**可选**能力：注册失败只该让面板缺席，绝不该被记成 `initError` 而把搜索一起
 * 关掉（`PIN-5`）。路由**惰性**读取 `state`，因此注册时 `pool` / `usageRefresher` 还没
 * 构造出来是没关系的——请求到达时它们已经就位；真的没就位（初始化抛过错），接口会以 503
 * 如实回答，而不是抛出。
 *
 * @param state - 插件运行时状态。
 */
function registerPanelRoutesSafely(state) {
  try {
    state.panelRegistered = registerPanelRoutes(state.host, state);
    if (state.panelRegistered !== true) {
      report(
        state.host,
        'warn',
        'dsh-tavily-pool: the host exposes no ctx.connection.fetch.register, so the settings '
        + 'card cannot manage keys; search is unaffected.',
      );
    }
  } catch (error) {
    report(state.host, 'warn', `dsh-tavily-pool: could not register the panel HTTP API: ${String(error)}`);
  }
}

/**
 * 经宿主 logger 服务输出日志，容忍其缺席。
 *
 * `ctx.logger` 是每个 context 的自有属性（`LoggerService` 被构造到它上面），
 * **不是** provided service——因此反射式 `ctx.get('logger')` 返回 `undefined`，
 * 会让每条消息被静默丢弃。读该属性是安全的：context proxy 只对完全无法解析的名字
 * 抛出，而这个名字始终存在。
 *
 * logger 缺失或行为异常绝不能成为插件加载失败的原因，因此整个调用都留在一个不会
 * 向外传播的 `try` 里。
 *
 * @param ctx - 插件 context。
 * @param level - 要调用的 logger 方法。
 * @param message - 消息；空字符串不记录。
 */
function report(ctx, level, message) {
  if (typeof message !== 'string' || message.length === 0) return;
  try {
    const logger = ctx.logger;
    const write = logger?.[level];
    if (typeof write === 'function') write.call(logger, message);
  } catch {
    // 日志按定义就是尽力而为；绝不让它打断初始化。
  }
}

/**
 * 一次完整的搜索：读设置、必要时回落、否则按余额调度并跨密钥故障切换。
 *
 * 之所以按次解析而非在加载时捕获：密钥池会随用户编辑而变化，设置会随面板变化；把
 * 这些读取留在每次搜索的开头，正是「改动即时生效、且无需重新注册提供方」的实现。
 *
 * **回落共有三条入口**，全部收敛到 {@link fallbackToOfficial}，因而三种情形在用户
 * 那里得到同一套错误面（`PIN-3`、`SCHED-5`）：
 *
 * 1. 搜索开关关闭；
 * 2. 密钥池文件不可读——按 `POOL-7` 以空池继续，于是落进第 3 条；
 * 3. 池内没有任何**可能在本次请求内恢复**的候选（空池、全部停用、全部额度耗尽或
 *    永久失效）。
 *
 * 第 3 条**不**覆盖「刚试过、刚失败」的情形：那时手上有真实的上游响应，`REST-10`
 * 要求把它透穿给调用方，而不是换一个来源重试。两者的分界在编排层，见
 * {@link runWithFailover} 的 `blocked` 字段。
 *
 * @param state - 插件运行时状态。
 * @param request - seam 的搜索请求。
 * @param signal - 调用方取消信号。
 * @returns seam 归一化后的结果。
 * @throws {TavilyError} 无法完成搜索时抛出。
 */
async function search(state, request, signal) {
  // 第一次真正用到宿主时再探一次：注入回调通常在插件加载后不久就绪，但「三项一个都没到」
  // 的退化宿主不会触发任何回调，而那正是最需要留下一条日志的情形。
  refreshCapabilities(state);
  if (signal?.aborted === true) {
    throw new TavilyError('Tavily search aborted by the caller', { code: 'TAVILY_ABORTED' });
  }
  if (state.initError !== undefined) {
    throw new TavilyError(
      `dsh-tavily-pool failed to initialize and has no key pool: ${String(state.initError)}`,
      { code: 'TAVILY_NOT_INITIALIZED', cause: state.initError },
    );
  }
  if (state.pool === undefined || state.health === undefined || state.scheduler === undefined) {
    throw new TavilyError('dsh-tavily-pool has no key pool; the plugin did not finish loading', {
      code: 'TAVILY_NOT_INITIALIZED',
    });
  }

  const settings = readPluginSettings(state.host);
  // 开关先判：它与密钥池能不能读、有没有密钥都无关（`PIN-3`）。这也是唯一一条**不**
  // 需要先把池读进来的回落路径，因此它排在最前。
  if (settings.searchEnabled !== true) {
    return fallbackToOfficial(state, request, signal, `the Tavily search toggle is off (${SETTINGS_NAMESPACE})`);
  }

  await ensurePoolLoaded(state);

  // 密钥池文件存在但不可信（`POOL-7`）：按空池继续，因此直接落进下面的「没有候选」
  // 分支去回落。**这条线索只报告一次**——文件坏掉是个持续状态，每一次搜索都刷同一条
  // 日志只会把真正新发生的事淹掉。回落一旦成功，这条记录就只剩日志与面板了。
  //
  // 按**消息文本**而不是错误对象去重：坏文件每次搜索都会被重新读一遍（见 `ensureLoaded`），
  // 于是每次都是一个新对象，用身份比较等于没有去重。
  if (state.pool.loadError !== undefined) {
    const message = state.pool.loadError.message;
    if (state.reportedPoolLoadError !== message) {
      state.reportedPoolLoadError = message;
      report(
        state.host,
        'warn',
        `dsh-tavily-pool: ${message}; falling back to the official search provider `
        + `and starting from an empty pool. Fix or remove ${state.pool.filePath} to use Tavily again.`,
      );
    }
    return fallbackToOfficial(state, request, signal, `the key pool could not be read: ${message}`);
  }

  const startedAt = Date.now();
  // 总预算**先问宿主**（`host-contract-2`）：宿主把 `web_search` 的单次预算绑在工具定义上，
  // 由 timeout-policy 武装成硬 deadline。按写死的常量排布时，宿主先到点就会用一句
  // `tool call timed out after …ms` 顶掉上游的真实错误（`REST-10` 要求透穿的正是后者）。
  // 读不到（退化宿主、或 `tools` 在本 fiber 不可见）才退回常量，`state.hostBudget.search.source`
  // 如实说出走的是哪一档，面板可以据此显示。
  const deadlineMs = startedAt + budgetFor(state, 'search').budgetMs;
  let result;
  try {
    ({ result } = await runWithFailover({
      scheduler: state.scheduler,
      health: state.health,
      signal,
      // 总预算交给编排层：有界等待（`SCHED-9`）与单次尝试的超时都从它里面分。
      deadlineMs,
      // 搜索深度决定本次按 1 还是 2 积分估算——只用于余额前推，不写进历史。
      searchDepth: settings.searchDepth,
      // `SCHED-5` 的例外：池内只剩额度耗尽的密钥时，先看看有没有哪把已经跨过月起始、
      // 值得问一次官方（`SCHED-10`）。
      probeQuota: () => probeQuotaForReset(state, signal),
      onAttempt: (attempt) => recordCall(state, 'search', attempt),
      invoke: ({ key }) => searchTavily({
        apiKey: key,
        query: request.query,
        // 用户配置与调用方请求取较小者：两者都是真实的上界，见 `effectiveMaxResults`。
        maxResults: effectiveMaxResults(settings.maxResults, request.maxResults),
        params: searchParamsOf(settings),
        signal,
        fetchImpl: globalThis.fetch,
        timeoutMs: attemptTimeoutMs(deadlineMs),
      }),
    }));
  } catch (error) {
    // 池内没有任何可能在本次请求内恢复的候选，且**没有**真实的上游失败可透穿：这正是
    // `SCHED-5` 说的那种情形，按 `PIN-3` 回落。
    if (error?.blocked === 'all-unusable' || error?.blocked === 'no-keys') {
      return fallbackToOfficial(state, request, signal, `no Tavily key is usable: ${error.message}`);
    }
    throw error;
  }

  reportWriteErrors(state);
  return result;
}

/**
 * 一次完整的抓取：读设置、必要时回落，否则按余额调度并跨密钥故障切换（`10`）。
 *
 * 结构与 {@link search} 逐段对应，因为两者的判断次序出自同一条理由：**开关先判**——它与
 * 密钥池能不能读、有没有密钥都无关（`PIN-3`），因此它是唯一一条不需要先把池读进来的
 * 回落路径。
 *
 * 三处与搜索**有意的**不同：
 *
 * 1. 没有 `maxResults` 那样的参数折算：`WebFetchRequest` 只有 `url`，`extract_depth` 与
 *    `format` 全部来自设置。
 * 2. 抓取**不做**额度重置探测（`SCHED-10`，搜索里的 `probeQuota`）：那条探测服务于
 *    「月初自动恢复」这个用户期待，而它与抓取无关——抓取没有理由比搜索更早去问一次官方
 *    余额，多问一次只会多占一格 `/usage` 配额。
 * 3. 抓取回落的是官方**本地 HTTP 抓取器**，它不需要凭据，因此没有 `CFG-5` 那两档错误。
 *
 * @param state - 插件运行时状态。
 * @param request - seam 的抓取请求。
 * @param signal - 调用方取消信号。
 * @returns seam 归一化后的抓取结果。
 * @throws {TavilyError} 无法完成抓取时抛出。
 */
async function fetchUrl(state, request, signal) {
  refreshCapabilities(state);
  if (signal?.aborted === true) {
    throw new TavilyError('Tavily fetch aborted by the caller', { code: 'TAVILY_ABORTED' });
  }
  if (state.initError !== undefined) {
    throw new TavilyError(
      `dsh-tavily-pool failed to initialize and has no key pool: ${String(state.initError)}`,
      { code: 'TAVILY_NOT_INITIALIZED', cause: state.initError },
    );
  }
  if (state.pool === undefined || state.health === undefined || state.scheduler === undefined) {
    throw new TavilyError('dsh-tavily-pool has no key pool; the plugin did not finish loading', {
      code: 'TAVILY_NOT_INITIALIZED',
    });
  }

  const settings = readPluginSettings(state.host);
  if (settings.fetchEnabled !== true) {
    return fallbackToOfficialFetch(state, request, signal, `the Tavily fetch toggle is off (${SETTINGS_NAMESPACE})`);
  }

  await ensurePoolLoaded(state);

  // 与搜索同一条线索、同一份去重：坏掉的密钥池文件每次都重读，因此按**消息文本**而不是
  // 错误对象去重；两个开关各自看到它时也只留一条日志。
  if (state.pool.loadError !== undefined) {
    const message = state.pool.loadError.message;
    if (state.reportedPoolLoadError !== message) {
      state.reportedPoolLoadError = message;
      report(
        state.host,
        'warn',
        `dsh-tavily-pool: ${message}; falling back to the official fetch provider `
        + `and starting from an empty pool. Fix or remove ${state.pool.filePath} to use Tavily again.`,
      );
    }
    return fallbackToOfficialFetch(state, request, signal, `the key pool could not be read: ${message}`);
  }

  const startedAt = Date.now();
  // 抓取用**它自己的**预算，且同样先问宿主（`host-contract-2`）：宿主给 web_fetch 的默认
  // 是 30 秒、给 web_search 的默认是 30 秒但 `dsh-base` 把它抬到 60——两个值都可能被
  // 部署或 preset 覆盖，因此「哪个工具对应哪条预算」只能按工具名问，不能按常量猜。
  const deadlineMs = startedAt + budgetFor(state, 'fetch').budgetMs;
  let outcome;
  try {
    outcome = await runWithFailover({
      scheduler: state.scheduler,
      health: state.health,
      signal,
      deadlineMs,
      endpoint: 'extract',
      // 计费档位由深度决定，而深度只有设置里知道——因此把它交下去，由持有累计计数的那一层
      // 算出这次该记多少积分（`USAGE-6` 的「每 5 个成功 URL」是跨请求累计的）。
      extractDepth: settings.fetchDepth,
      onAttempt: (attempt) => recordCall(state, 'extract', attempt),
      invoke: ({ key }) => extractTavily({
        apiKey: key,
        url: request.url,
        // `WebFetchRequest` 只有 `url`，因此这两个值只能来自设置——模型无法按次控制
        // `extract_depth`，而它直接决定计费档位（`FETCH-1`、`USAGE-6`）。
        depth: settings.fetchDepth,
        format: settings.fetchFormat,
        signal,
        fetchImpl: globalThis.fetch,
        timeoutMs: attemptTimeoutMs(deadlineMs),
      }),
    });
  } catch (error) {
    if (error?.blocked === 'all-unusable' || error?.blocked === 'no-keys') {
      return fallbackToOfficialFetch(state, request, signal, `no Tavily key is usable: ${error.message}`);
    }
    throw error;
  }

  reportWriteErrors(state);
  return outcome.result;
}

/**
 * 本次调用该按多久的**总**预算排布（`host-contract-2`）。
 *
 * 宿主把每个工具的 `timeoutMs` 绑在工具定义上，`timeout-policy` 读它武装成硬 deadline；
 * 因此正确的预算是**那个值减去余量**，而不是我们自己的常量。读不到时才退回常量，并由
 * `source` 如实说出走的是哪一档——面板据它显示，用户与维护者因此不必猜。
 *
 * 每次调用都现读一次：`tools` 服务可能在插件加载之后才就位（注入回调的时序见
 * `lib/dsh/host-services.js`），而宿主也可能在运行期重建工具注册表。
 *
 * `state.hostBudget` 只留**最近一次**读数，供面板展示；它不是调度依据——调度依据就是
 * 本次返回值。
 *
 * @param state - 插件运行时状态。
 * @param kind - `'search'` 或 `'fetch'`。
 * @returns `{ budgetMs, source }`：本次可用的总预算与它的来源。
 */
function budgetFor(state, kind) {
  const host = readHostToolBudgetMs(state.host, kind === 'search' ? 'web_search' : 'web_fetch');
  const budget = effectiveBudgetMs({
    hostMs: host.timeoutMs,
    fallbackMs: kind === 'search' ? SEARCH_TOTAL_BUDGET_MS : FETCH_TOTAL_BUDGET_MS,
    marginMs: HOST_BUDGET_MARGIN_MS,
  });
  const reading = { budgetMs: budget.budgetMs, source: budget.source, hostSource: host.source };
  state.hostBudget = { ...state.hostBudget, [kind]: reading };
  return reading;
}

/**
 * 把一次尝试记进调用历史（`14`）。
 *
 * **不等待、不抛错。** 历史是记录而不是正确性前提：写不进去只让面板少一段曲线，绝不该让一次
 * 搜索失败；而 `await` 它会把「换下一把再试」这条路径拖在一次磁盘写入后面，那正是故障切换最
 * 不该慢的时刻。落盘因此排队进行，失败记在 `history.lastWriteError` 上，由
 * {@link reportWriteErrors} 在上报统计写失败时一并说出。
 *
 * 密钥的脱敏形式**当场算一份存进去**，而不是展示时回密钥池里查：密钥被删掉之后这条记录仍然
 * 要能读——「上个月那把已经删掉的 key 花了多少」正是历史存在的意义之一。
 *
 * @param state - 插件运行时状态。
 * @param endpoint - `search` 或 `extract`。
 * @param attempt - {@link runWithFailover} 给出的那次尝试。
 */
function recordCall(state, endpoint, attempt) {
  if (state.history === undefined || state.pool === undefined) return;
  const record = state.pool.keysInOrder().find((entry) => entry.id === attempt.keyId);
  void state.history.append({
    endpoint,
    keyId: attempt.keyId,
    keyMasked: record === undefined ? '' : maskKey(record.key),
    outcome: attempt.outcome,
    durationMs: attempt.durationMs,
    successfulUrls: attempt.successfulUrls,
    status: attempt.status,
    code: attempt.code,
    requestId: attempt.requestId,
  });
}

/**
 * 回落到官方本地 HTTP 抓取器（`PIN-4`、ticket `10` 的回落契约）。
 *
 * 与搜索回落相比它简单得多，且**这个简单是刻意的**：官方抓取器不需要凭据，因此没有
 * 「未配置 / 已失效」那一对错误码，也没有任何需要改写的失败。这里只做两件事——把请求转交
 * 过去，以及为**每个不同的原因**记一条日志。
 *
 * 日志与搜索那边同样必要：抓取回落是**完全静默**的（用户看到的是正常抓到的页面内容，
 * 没有任何迹象说明 Tavily 没被用上），而「我明明配了密钥却没走 Tavily」正是最需要一条
 * 线索的时刻。
 *
 * @param state - 插件运行时状态。
 * @param request - seam 的抓取请求。
 * @param signal - 调用方取消信号。
 * @param reason - 为什么回落。
 * @returns seam 归一化后的抓取结果。
 */
async function fallbackToOfficialFetch(state, request, signal, reason) {
  if (state.reportedFetchFallbackReason !== reason) {
    state.reportedFetchFallbackReason = reason;
    report(
      state.host,
      'warn',
      'dsh-tavily-pool: serving this fetch through the official local HTTP fetcher instead of Tavily — '
      + `${reason}.`,
    );
  }
  return officialFetchProvider().fetch(request, signal);
}

/**
 * 回落到官方搜索提供方，并把「为什么回落」带进失败文案（`PIN-3`、`SCHED-5`、`CFG-5`）。
 *
 * 原因是必要的上下文而不只是日志：回落目标自己的凭据可能也没配，那时用户看到的会是一条
 * 关于 **DeepSeek** 凭据的错误，而真正要修的东西两回事——他刚被从 Tavily 那条路踢出来。
 * 把起点写进消息，用户才知道该看哪边。
 *
 * **原因只拼一次。** 它被交给 `searchWithOfficialProvider`，由后者织进错误文案；这里不再
 * 往前面补一遍，否则同一条消息会把「为什么离开 Tavily」说两遍。
 *
 * **回落成功时也记一条日志，每个不同的原因只记一次。** 这一条不是可有可无的：本机通常
 * 配着 `DEEPSEEK_API_KEY`，于是密钥池为空的用户会**静默地**用上官方搜索——面板上两个开关
 * 都是开的、搜索也正常工作，没有任何迹象说明 Tavily 根本没被用上。同一个原因反复刷屏同样
 * 没有价值，因此按原因去重；原因变了（例如从「开关关了」变成「池子空了」）会重新记一次。
 *
 * @param state - 插件运行时状态。
 * @param request - seam 的搜索请求。
 * @param signal - 调用方取消信号。
 * @param reason - 为什么回落。
 * @returns seam 归一化后的结果。
 */
async function fallbackToOfficial(state, request, signal, reason) {
  try {
    const result = await searchWithOfficialProvider({ ctx: state.host, request, signal, reason });
    // **成功即撤销上一次失败留下的凭据结论。** 「凭据已失效」这个判断的全部依据是
    // 「官方拒了它」，而刚刚这一次官方接受了它——留下旧结论会让面板持续指引用户去换
    // 一把其实可用的凭据，把真正的问题（网络、代理、WAF 的 403）盖住。
    state.lastFallbackFailure = undefined;
    if (state.reportedFallbackReason !== reason) {
      state.reportedFallbackReason = reason;
      report(
        state.host,
        'warn',
        `dsh-tavily-pool: serving this search through the DeepSeek official provider instead of Tavily — `
        + `${reason}.`,
      );
    }
    return result;
  } catch (error) {
    // 只换外壳，不改动 code 与文案：`searchWithOfficialProvider` 已经把原因与凭据状态都
    // 织进了消息，这里再做一次改写只会让同一句话说两遍。
    if (error?.code === 'TAVILY_FALLBACK_CREDENTIAL_MISSING' || error?.code === 'TAVILY_FALLBACK_CREDENTIAL_INVALID') {
      // 记下这次失败。面板要区分「未配置」与「已失效」（`CFG-5`），而那个区别只有一次
      // **真实发生**的回落才能提供——`available()` 只会说「有值」，不会说「值还能用」。
      //
      // 只有「已失效」值得留痕：`describeOfficialCredential` 对 `MISSING` **不做保留**
      // （用户配好凭据之后，当场探测立刻会说 `configured`），留一条只会让面板的
      // `lastFailureAt` 指着一件已经不存在的事。因此这一档按「清掉」处理，与探测那侧的
      // 语义一致。
      state.lastFallbackFailure = error.code === 'TAVILY_FALLBACK_CREDENTIAL_INVALID'
        ? { code: error.code, at: new Date().toISOString() }
        : undefined;
      throw new TavilyError(error.message, { code: error.code, cause: error });
    }
    if (error?.code === 'WEB_ABORTED') {
      throw new TavilyError('Tavily search aborted by the caller', { code: 'TAVILY_ABORTED', cause: error });
    }
    throw error;
  }
}

/**
 * 对池内**该探测**的额度耗尽密钥各问一次官方余额（`SCHED-10`）。
 *
 * 「该探测」由密钥统计决定：标记之后跨过了月起始、且在 48 小时窗口内、距上次探测已满
 * 6 小时。因此这一趟在正常情况下是空转，在最坏情况下也只发出个位数的请求——远低于
 * `/usage` 的「10 次 / 10 分钟」配额，后者还由 {@link UsageQuota} 独立把关。
 *
 * **先记探测时刻、再发请求。** 顺序反过来时，一次失败的探测不会留下任何痕迹，下一次
 * 搜索会立刻再探测一次，10 分钟内就能把官方配额打满——而被消耗的配额正好是恢复所
 * 需要的那份。
 *
 * @param state - 插件运行时状态。
 * @param signal - 调用方取消信号。
 * @returns 探测之后至少有一把密钥重新可用时返回 true。
 */
async function probeQuotaForReset(state, signal) {
  if (state.usageRefresher === undefined) return false;

  const records = state.pool.keysInOrder().filter((record) => record.disabled !== true);
  const due = state.health.quotaProbeDue(records.map((record) => record.id));
  if (due.length === 0) return false;

  const byId = new Map(records.map((record) => [record.id, record]));
  let recovered = false;
  for (const id of due) {
    if (signal?.aborted === true) break;
    await state.health.recordQuotaProbe(id);
    const outcome = await state.usageRefresher.refresh(id, byId.get(id).key, { signal, reason: 'probe' });
    if (outcome.recovered === true) recovered = true;
    else if (outcome.ok === false && outcome.skipped !== 'quota') {
      // 探测失败要说出来：它意味着「自动恢复」这条路径此刻是坏的，而用户对它的期待
      // 正是「不用管，月初会自己好」。
      report(
        state.host,
        'warn',
        `dsh-tavily-pool: could not probe the balance of a quota-exhausted key: ${String(outcome.error)}`,
      );
    }
  }
  return recovered;
}

/**
 * 把「状态没写进磁盘」与「密钥池在进程外被改过」各上报一次，然后清掉标记。
 *
 * 统计落盘失败不影响本次结果——它不是正确性前提——但绝不能是静默的：用户下次打开
 * 面板时会看到一份「这把密钥从没被用过」的记录，而没有任何线索说明为什么。
 *
 * 调用历史（`14`）走同一条路：它也是记录，也是「写不进去不影响本次调用」，而它的失败同样
 * 会让面板上少一段曲线而没有任何解释。两者一起上报，是因为它们对用户说的是同一件事——
 * 「这次调用没有被记住」。
 *
 * **外部改动（ticket `22` C1）是第三件事，但说的是同一类话。** 真源语义允许用户在进程运行
 * 期间手工编辑 `keys.json`，而这条语义此前不存在：磁盘上的改动会被下一次落盘整份覆盖，
 * 无声无息。现在它算数了，于是「你刚补的那把已经被读进来了」必须有地方说出来——否则用户
 * 只能靠数面板上的行数去猜自己那次编辑到底生效没有。上报之后同样清掉：这条日志描述的是
 * **一次**外部改动，留着它会让此后每一次搜索都重复同一句话。
 *
 * 报告后即清除：留着它会让一次瞬时故障在此后每一次搜索上都重复告警，而那条日志
 * 早已完成使命。下一次真的又失败时，它会再次被设上。
 *
 * @param state - 插件运行时状态。
 */
function reportWriteErrors(state) {
  if (state.pool.lastWriteError !== undefined) {
    report(
      state.host,
      'warn',
      `dsh-tavily-pool: could not record key stats in ${state.pool.filePath}: `
      + `${String(state.pool.lastWriteError)}`,
    );
    state.pool.lastWriteError = undefined;
  }
  if (state.history?.lastWriteError !== undefined) {
    report(
      state.host,
      'warn',
      `dsh-tavily-pool: could not record this call in ${state.history.filePath}: `
      + `${String(state.history.lastWriteError)}`,
    );
    state.history.lastWriteError = undefined;
  }
  if (state.pool.lastExternalChange !== undefined) {
    const change = state.pool.lastExternalChange;
    report(
      state.host,
      'warn',
      `dsh-tavily-pool: ${state.pool.filePath} was changed outside this process `
      + `(${String(change.added)} key(s) added, ${String(change.removed)} removed, `
      + `${String(change.changed)} edited); the pool now follows the file.`,
    );
    state.pool.lastExternalChange = undefined;
  }
}

/**
 * 一次尝试的超时：单次超时与本次搜索剩余预算中的较小者。
 *
 * 不折算的话，池中每多一把密钥就多出一次完整超时的可能，总耗时随池子大小线性增长，
 * 而宿主给整次调用的预算是固定的。
 *
 * @param deadlineMs - 本次搜索的截止时刻。
 * @returns 超时毫秒数。
 */
function attemptTimeoutMs(deadlineMs) {
  return Math.max(MIN_ATTEMPT_TIMEOUT_MS, Math.min(TAVILY_TIMEOUT_MS, deadlineMs - Date.now()));
}

/**
 * 加载密钥池；失败与「读到一份不可信的文件」两种情况都会在下次调用时重试。
 *
 * 实现在 `lib/dsh/pool-load.js`，因为**面板路径也要用它**：面板此前从不触发加载，于是进程
 * 重启后只要还没搜索过，面板读到的就是空的内存池，而它写的时候用的也是那份空池——一次
 * 「添加密钥」会把磁盘上原有的密钥全部抹掉（ticket `21`）。
 */

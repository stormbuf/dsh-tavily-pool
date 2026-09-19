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
  KEYS_FILE_NAME,
  MIN_ATTEMPT_TIMEOUT_MS,
  SEARCH_TIMEOUT_MS,
  SEARCH_TOTAL_BUDGET_MS,
  SETTINGS_NAMESPACE,
} from './lib/constants.js';
import { KeyHealth } from './lib/health.js';
import { PoolStore } from './lib/pool.js';
import { Scheduler } from './lib/scheduler.js';
import { TavilyError, searchTavily } from './lib/tavily.js';
import { probeCapabilities, describeMissingCapabilities } from './lib/dsh/capabilities.js';
import { resolveStateDir } from './lib/dsh/home-path.js';
import { registerSearchProvider } from './lib/dsh/register.js';
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
 * @property {import('./lib/dsh/capabilities.js').CapabilityReport|undefined} capabilityReport
 * @property {PoolStore|undefined} pool
 * @property {KeyHealth|undefined} health
 * @property {Scheduler|undefined} scheduler
 * @property {Promise<void>|undefined} poolLoad
 * @property {Error|undefined} initError
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
    capabilityReport: undefined,
    pool: undefined,
    health: undefined,
    scheduler: undefined,
    poolLoad: undefined,
    initError: undefined,
  };

  // 刻意作为第一条效果语句（硬约束 5）：profile patch 把 searchProvider pin 到本插件，
  // 因此一个加载了却没注册的插件会让每次搜索都抛
  // WEB_PROVIDER_CONFIGURED_MISSING。上面的 provider 构造与状态字面量都不会失败；
  // 一切可能失败的事都在下面。
  registerSearchProvider(ctx, new TavilySearchProvider((request, signal) => search(state, request, signal)));

  // 以下全部非关键：即便抛错，搜索仍能用现存状态工作，失败会被记录下来供面板读取。
  //
  // 探测刻意放在这个 `try` 之外：它不会抛（它经 `ctx.get` 读取，缺失时返回
  // `undefined` 而不报错），把它卷进来会让一个无关的初始化故障伪装成能力探测结果。
  // 这里只守护真正的初始化。
  state.capabilityReport = probeCapabilities({ ctx });
  try {
    // 命名空间不可重复注册，而重复注册会抛错。让那个错误落进下面的 catch，而不是把
    // 已经完成的能力探测一并作废——提供方早已注册，搜索是可用的。
    registerSettings(ctx);
    state.pool = new PoolStore({ dir: resolveStateDir(ctx), fileName: KEYS_FILE_NAME });
    state.health = new KeyHealth({ pool: state.pool });
    state.scheduler = new Scheduler({ pool: state.pool, health: state.health });
  } catch (error) {
    state.initError = error;
    report(ctx, 'warn', `dsh-tavily-pool: initialization failed, continuing with search registered: ${String(error)}`);
  }

  // 只要缺了任何东西就上报，而不只在缺必需能力时上报：可选能力的丧失恰恰是那种会
  // 被拖延很久、最后从症状才发现的静默退化。放在密钥池构造之后发出，于是一行日志
  // 就能报告完整状态。
  report(ctx, 'warn', describeMissingCapabilities(state.capabilityReport));
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
 * @param state - 插件运行时状态。
 * @param request - seam 的搜索请求。
 * @param signal - 调用方取消信号。
 * @returns seam 归一化后的结果。
 * @throws {TavilyError} 无法完成搜索时抛出。
 */
async function search(state, request, signal) {
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

  // 开关先判：它与密钥池能不能读、有没有密钥都无关，关闭时**回落**（`PIN-3`）。
  // 回落目标属于 `05`，因此这里先给出一个说明清楚的错误，而不是静默地继续用 Tavily
  // 搜索——后者会让面板上的开关看起来生效了，实际却没生效。
  const settings = readPluginSettings(state.ctx);
  if (settings.searchEnabled !== true) {
    throw new TavilyError(
      `Tavily search is turned off in Settings → Plugins → ${SETTINGS_NAMESPACE}, and the fallback to `
      + 'the built-in DeepSeek search provider is not wired up yet',
      { code: 'TAVILY_SEARCH_DISABLED' },
    );
  }

  await ensureLoaded(state);

  // 密钥池文件存在但不可信（`POOL-7`）时按路径上报，而不是报成「一把密钥都没配」：
  // 前者要用户去修文件，后者要用户去加密钥，是两件事。
  if (state.pool.loadError !== undefined) {
    throw new TavilyError(
      `the key pool could not be read (${state.pool.loadError.message}); fix or remove `
      + `${state.pool.filePath} and add a key in Settings → Plugins → ${SETTINGS_NAMESPACE}`,
      { code: 'TAVILY_NO_USABLE_KEY', cause: state.pool.loadError },
    );
  }

  const startedAt = Date.now();
  const deadlineMs = startedAt + SEARCH_TOTAL_BUDGET_MS;
  const { result } = await runWithFailover({
    scheduler: state.scheduler,
    health: state.health,
    signal,
    // 总预算交给编排层：有界等待（`SCHED-9`）与单次尝试的超时都从它里面分。
    deadlineMs,
    invoke: ({ key }) => searchTavily({
      apiKey: key,
      query: request.query,
      maxResults: request.maxResults,
      params: searchParams(state.ctx),
      signal,
      fetchImpl: globalThis.fetch,
      timeoutMs: attemptTimeoutMs(deadlineMs),
    }),
  });

  // 统计落盘失败不影响本次结果——它不是正确性前提——但绝不能是静默的：用户下次打开
  // 面板时会看到一份「这把密钥从没被用过」的记录，而没有任何线索说明为什么。
  //
  // 报告后即清除：留着它会让一次瞬时故障在此后每一次搜索上都重复告警，而那条日志
  // 早已完成使命。下一次真的又失败时，它会再次被设上。
  if (state.pool.lastWriteError !== undefined) {
    report(
      state.ctx,
      'warn',
      `dsh-tavily-pool: could not record key stats in ${state.pool.filePath}: `
      + `${String(state.pool.lastWriteError)}`,
    );
    state.pool.lastWriteError = undefined;
  }
  return result;
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
  return Math.max(MIN_ATTEMPT_TIMEOUT_MS, Math.min(SEARCH_TIMEOUT_MS, deadlineMs - Date.now()));
}

/**
 * 搜索参数，由设置决定；`07` 落地。
 *
 * 目前为空，从而保留 Tavily 自己的默认值，而不是在这里臆造一套。
 *
 * @param _ctx - 插件 context。
 * @returns 发给 Tavily 的搜索参数。
 */
function searchParams(_ctx) {
  return {};
}

/**
 * 加载密钥池，且失败后可重试。
 *
 * 记忆化是必要的（每个请求都读一次盘毫无意义），但在拒绝之后必须允许重试：一次
 * 临时性的文件系统故障不该让该进程此后每一次搜索都注定失败。
 *
 * @param state - 插件运行时状态。
 * @returns 加载完成的 promise。
 */
async function ensureLoaded(state) {
  state.poolLoad ??= state.pool.load().catch((error) => {
    // 丢掉失败的 promise，让下一次搜索重新读取。
    state.poolLoad = undefined;
    throw error;
  });
  await state.poolLoad;
}

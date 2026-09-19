/**
 * dsh-tavily-pool —— 用 Tavily 承载 DeepSeek Harness 的 `web_search`。
 *
 * 本文件是 harness 加载的插件入口。它只做三件事，其余全部委派出去：
 *
 * 1. 注册搜索提供方，且放在**最前**，先于任何可能失败的步骤（`PIN-5`，硬约束 5）；
 * 2. 在 `try`/`catch` 内构造面向宿主的协作者（能力探测、状态目录、密钥池），
 *    使注册之后的失败退化为「半坏的插件」而不是一次搜索中断；
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

import { KEYS_FILE_NAME, SEARCH_TIMEOUT_MS, SETTINGS_NAMESPACE } from './lib/constants.js';
import { PoolStore } from './lib/pool.js';
import { TavilyError } from './lib/tavily.js';
import { probeCapabilities, describeMissingCapabilities } from './lib/dsh/capabilities.js';
import { resolveStateDir } from './lib/dsh/home-path.js';
import { registerSearchProvider } from './lib/dsh/register.js';
import { TavilySearchProvider } from './lib/dsh/search-provider.js';

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
 * 与后续 issue 新增的设置面、面板面共享的可变运行时状态。
 *
 * @typedef {object} PluginState
 * @property {import('./lib/dsh/capabilities.js').CapabilityReport|undefined} capabilityReport
 * @property {PoolStore|undefined} pool
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
  const state = { capabilityReport: undefined, pool: undefined, poolLoad: undefined, initError: undefined };

  // 刻意作为第一条效果语句（硬约束 5）：profile patch 把 searchProvider pin 到本插件，
  // 因此一个加载了却没注册的插件会让每次搜索都抛
  // WEB_PROVIDER_CONFIGURED_MISSING。上面的 provider 构造与状态字面量都不会失败；
  // 一切可能失败的事都在下面。
  registerSearchProvider(ctx, new TavilySearchProvider((signal) => resolveSearchOptions(state, signal)));

  // 以下全部非关键：即便抛错，搜索仍能用现存状态工作，失败会被记录下来供面板读取。
  //
  // 探测刻意放在这个 `try` 之外：它不会抛（它经 `ctx.get` 读取，缺失时返回
  // `undefined` 而不报错），把它卷进来会让一个无关的初始化故障伪装成能力探测结果。
  // 这里只守护真正的初始化。
  state.capabilityReport = probeCapabilities({ ctx });
  try {
    state.pool = new PoolStore({ dir: resolveStateDir(ctx), fileName: KEYS_FILE_NAME });
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
 * 在搜索真正运行时解析它所需的一切。
 *
 * 之所以按次解析而非在加载时捕获，有两个独立原因：密钥池会随用户编辑而变化；而
 * thunk 正是让面板的编辑能作用于紧接着的下一次搜索、却无需重新注册提供方的机制。
 *
 * 密钥池加载会被记忆化，但在拒绝之后允许重试，因此一次临时性的文件系统故障不会
 * 让该进程此后每一次搜索都注定失败。
 *
 * @param state - 插件运行时状态。
 * @param signal - 调用方取消信号。
 * @returns `{ apiKey, params, fetchImpl, timeoutMs }`。
 * @throws {TavilyError} 插件完全无法搜索时抛出。
 */
async function resolveSearchOptions(state, signal) {
  if (signal?.aborted === true) {
    throw new TavilyError('Tavily search aborted by the caller', { code: 'TAVILY_ABORTED' });
  }
  if (state.initError !== undefined) {
    throw new TavilyError(
      `dsh-tavily-pool failed to initialize and has no key pool: ${String(state.initError)}`,
      { code: 'TAVILY_NOT_INITIALIZED', cause: state.initError },
    );
  }
  if (state.pool === undefined) {
    throw new TavilyError('dsh-tavily-pool has no key pool; the plugin did not finish loading', {
      code: 'TAVILY_NOT_INITIALIZED',
    });
  }

  state.poolLoad ??= state.pool.load().catch((error) => {
    // 丢掉失败的 promise，让下一次搜索重新读取。
    state.poolLoad = undefined;
    throw error;
  });
  await state.poolLoad;

  const apiKey = state.pool.firstUsableKey();
  if (apiKey === undefined) {
    throw new TavilyError(
      state.pool.loadError === undefined
        ? `no Tavily key is configured; add one in Settings → Plugins → ${SETTINGS_NAMESPACE}`
        : `the key pool could not be read (${state.pool.loadError.message}); fix or remove ${state.pool.filePath} `
          + `and add a key in Settings → Plugins → ${SETTINGS_NAMESPACE}`,
      { code: 'TAVILY_NO_USABLE_KEY' },
    );
  }

  return {
    apiKey,
    // 搜索参数在后续 issue 里配置；此处不发送任何参数，从而保留 Tavily 自己的默认值，
    // 而不是在这里臆造一套。
    params: {},
    fetchImpl: globalThis.fetch,
    timeoutMs: SEARCH_TIMEOUT_MS,
  };
}

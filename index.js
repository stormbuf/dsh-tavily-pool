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
import { searchParamsOf, effectiveMaxResults } from './lib/settings.js';
import { TavilyError, searchTavily } from './lib/tavily.js';
import { UsageQuota, UsageRefresher } from './lib/usage.js';
import { probeCapabilities, describeMissingCapabilities } from './lib/dsh/capabilities.js';
import { searchWithOfficialProvider } from './lib/dsh/fallback.js';
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
 * @property {UsageRefresher|undefined} usageRefresher
 * @property {Promise<void>|undefined} poolLoad
 * @property {Error|undefined} initError
 * @property {string|undefined} reportedPoolLoadError - 已经报告过的那次密钥池读取失败的
 *   消息，用于让一个持续存在的坏文件只产生一条日志，而不是每次搜索各一条。
 * @property {string|undefined} reportedFallbackReason - 已经报告过的那次回落原因，同样
 *   用于去重：一次成功的回落会让请求静默地走上官方提供方，因此它必须留下痕迹，但同一个
 *   原因不该每次搜索都刷一遍。
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
    usageRefresher: undefined,
    poolLoad: undefined,
    initError: undefined,
    reportedPoolLoadError: undefined,
    reportedFallbackReason: undefined,
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
    state.usageRefresher = new UsageRefresher({
      pool: state.pool,
      health: state.health,
      quota: new UsageQuota(),
      // 与搜索共用 `globalThis.fetch`：两者都是对同一个 API 的出站请求，测试里替换
      // 一次就该同时覆盖它们，而不是留下一条绕开替换的隐藏通道。
      fetchImpl: (...args) => globalThis.fetch(...args),
    });
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

  const settings = readPluginSettings(state.ctx);
  // 开关先判：它与密钥池能不能读、有没有密钥都无关（`PIN-3`）。这也是唯一一条**不**
  // 需要先把池读进来的回落路径，因此它排在最前。
  if (settings.searchEnabled !== true) {
    return fallbackToOfficial(state, request, signal, `the Tavily search toggle is off (${SETTINGS_NAMESPACE})`);
  }

  await ensureLoaded(state);

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
        state.ctx,
        'warn',
        `dsh-tavily-pool: ${message}; falling back to the official search provider `
        + `and starting from an empty pool. Fix or remove ${state.pool.filePath} to use Tavily again.`,
      );
    }
    return fallbackToOfficial(state, request, signal, `the key pool could not be read: ${message}`);
  }

  const startedAt = Date.now();
  const deadlineMs = startedAt + SEARCH_TOTAL_BUDGET_MS;
  let result;
  try {
    ({ result } = await runWithFailover({
      scheduler: state.scheduler,
      health: state.health,
      signal,
      // 总预算交给编排层：有界等待（`SCHED-9`）与单次尝试的超时都从它里面分。
      deadlineMs,
      // `SCHED-5` 的例外：池内只剩额度耗尽的密钥时，先看看有没有哪把已经跨过月起始、
      // 值得问一次官方（`SCHED-10`）。
      probeQuota: () => probeQuotaForReset(state, signal),
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
    const result = await searchWithOfficialProvider({ ctx: state.ctx, request, signal, reason });
    if (state.reportedFallbackReason !== reason) {
      state.reportedFallbackReason = reason;
      report(
        state.ctx,
        'warn',
        `dsh-tavily-pool: serving this search through the DeepSeek official provider instead of Tavily — `
        + `${reason}.`,
      );
    }
    return result;
  } catch (error) {
    // 只换外壳，不改动 code 与文案：`searchWithOfficialProvider` 已经把原因与凭据状态都
    // 织进了消息，这里再做一次改写只会让同一句话说两遍。
    if (error?.code === 'TAVILY_FALLBACK_CREDENTIAL_MISSING') {
      throw new TavilyError(error.message, { code: error.code, cause: error });
    }
    if (error?.code === 'TAVILY_FALLBACK_CREDENTIAL_INVALID') {
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
        state.ctx,
        'warn',
        `dsh-tavily-pool: could not probe the balance of a quota-exhausted key: ${String(outcome.error)}`,
      );
    }
  }
  return recovered;
}

/**
 * 把「状态没写进磁盘」上报一次，然后清掉标记。
 *
 * 统计落盘失败不影响本次结果——它不是正确性前提——但绝不能是静默的：用户下次打开
 * 面板时会看到一份「这把密钥从没被用过」的记录，而没有任何线索说明为什么。
 *
 * 报告后即清除：留着它会让一次瞬时故障在此后每一次搜索上都重复告警，而那条日志
 * 早已完成使命。下一次真的又失败时，它会再次被设上。
 *
 * @param state - 插件运行时状态。
 */
function reportWriteErrors(state) {
  if (state.pool.lastWriteError === undefined) return;
  report(
    state.ctx,
    'warn',
    `dsh-tavily-pool: could not record key stats in ${state.pool.filePath}: `
    + `${String(state.pool.lastWriteError)}`,
  );
  state.pool.lastWriteError = undefined;
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
 * 加载密钥池；失败与「读到一份不可信的文件」两种情况都会在下次搜索时重试。
 *
 * 记忆化是必要的（每个请求都读一次盘毫无意义），但有两种结果**不能**被记住：
 *
 * 1. **拒绝**（读盘本身失败）：一次临时性的文件系统故障不该让该进程此后每一次搜索都
 *    注定失败。
 * 2. **`loadError`**（文件读到了，但内容是坏的）：`load()` 对这种情况**不抛错**——它
 *    按 `POOL-7` 以空池继续，把问题挂在 `loadError` 上。于是「成功兑现」这个事实会
 *    把记忆化钉死，用户手工修好 `keys.json` 之后插件仍会一直用那份空池，直到重启。
 *    提交 `05`/`06` 之前这不成为症状（坏文件每次都抛错，用户看得见），现在它表现为
 *    「我修好了文件，搜索却还是不走 Tavily」，因此必须在这里放开。
 *
 * @param state - 插件运行时状态。
 * @returns 加载完成的 promise。
 */
async function ensureLoaded(state) {
  state.poolLoad ??= state.pool.load().then((pool) => {
    if (pool.loadError !== undefined) state.poolLoad = undefined;
    return pool;
  }, (error) => {
    // 丢掉失败的 promise，让下一次搜索重新读取。
    state.poolLoad = undefined;
    throw error;
  });
  await state.poolLoad;
}

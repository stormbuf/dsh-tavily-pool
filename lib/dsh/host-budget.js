/**
 * 单次调用的**总**预算：先问宿主，问不到才用本插件自己的常量（`SCHED-9`、`REST-10`）。
 *
 * ## 为什么不能只用常量
 *
 * 宿主把「这个工具单次调用最多跑多久」绑在工具定义上：`@deepseek-ai/dsh-tool-web` 的
 * `defineTool({ …, timeoutMs })`，值来自它自己的 `searchTimeoutMs` / `fetchTimeoutMs`，
 * 再由 `@deepseek-ai/dsh-tool-call-timeout-policy` 读出来武装成硬 deadline
 * （`ctx.tools.get(exec.name, exec.agent)?.timeoutMs`）。
 *
 * 本插件原先按写死的 60 秒 / 25 秒排布等待与尝试，从不读那个值。后果不是一个「略微超时」，
 * 而是**失败的原因被换掉**：宿主先到 deadline 时，模型看到的是
 * `tool call timed out after 60000ms`，而上游到底回了什么就此丢失——`REST-10` 要求透穿的
 * 正是那一条。这不是假想的部署：`dsh-base` 的注释自己预告了「products with a stricter
 * network policy override tool-web」，而 preset 更是用户可写的；搜索侧今天就已经是
 * 「我们的预算**等于**宿主 deadline」，靠 `MIN_ATTEMPT_TIMEOUT_MS` 的保底才没有
 * 每次都撞线。审计 `host-contract-2` 记的就是这一条。
 *
 * ## 为什么读的是全局视图
 *
 * `ctx.tools.get(name, scope)` 的 `scope` 是**发起调用的 agent**（`@deepseek-ai/dsh-tools`：
 * `get(name, scope) { return this.view(scope).visible.get(name); }`，省略 `scope` 即全局视图）：
 * 同一个工具名在不同 agent 作用域下可以是不同的定义。本插件的提供方在注册时拿不到 agent
 * ——`search()` / `fetch()` 被调用时才有一条 `exec`，而预算要在**发起请求之前**就定下来
 * ——因此这里按 `get(name)` 取全局视图。
 *
 * 局限是如实的、也是**可观察的**：若某个 preset 把 web 工具注册在 agent 作用域而不是全局，
 * 全局视图读不到它，{@link readHostToolBudgetMs} 报 `unbound`，
 * {@link effectiveBudgetMs} 于是按常量排布——`source: 'constant'` 把这件事说出来，而不是
 * 假装读到了。这里刻意**不去猜** agent：猜错会读到另一个 agent 的预算，比读不到更糟。
 *
 * ## 接线时要在真机上确认的一件事
 *
 * `unavailable` 有两个成因，而它们在结论上一致、在成因上必须分清：宿主真的没有 `tools`
 * 服务，或者该服务在本 fiber 的作用域里**不可见**。`docs/dsh-upgrade.md` 第 4 节记的正是
 * 后者——`ctx.get` 返回的只是「本 fiber 隔离作用域内可见」的服务，`settings` / `connection`
 * / `credentials` 三项实测**必须经 `inject`**；`clientModules` / `launchEnvironment` /
 * `dshHomePath` 三项则对任何 fiber 可见。`tools` 属于哪一档**没有实测过**，因此接线后要在
 * 真机上看一次 `source` 到底是 `host` 还是 `constant`：若是后者，本模块一行都不用改，把
 * 已绑定服务的 context 视图（`lib/dsh/host-services.js` 的 `hostView`）传进来即可——它先看
 * `bindHostServices` 绑到的实例，再看 context 自己的作用域。
 *
 * @module dsh-tavily-pool/dsh/host-budget
 */

import { readService } from './read-service.js';

/**
 * 读宿主为该工具真正绑定的单次调用预算。
 *
 * `tools` 经反射式读取（{@link readService}）：它是可选能力，缺席时退化为「没有宿主预算」，
 * 而不是加载期抛错（`COMPAT-3`）。
 *
 * 三档结果的区别在于**下一步能不能信这个数**：
 *
 * - `host`：读到了宿主定义上的有限正数 `timeoutMs`，可以按它折算预算；
 * - `unbound`：宿主今天**没有**为这个工具绑 deadline（工具定义在但没有 `timeoutMs`，
 *   或该工具在全局视图里根本没有注册——两种情形下 `dsh-tool-call-timeout-policy`
 *   都不会武装 deadline，因为它是 `?.timeoutMs` 后直接 `next()`）；此时唯一的依据就是
 *   常量；
 * - `unavailable`：连 `tools` 服务都读不到。成因有两个——宿主真的没有这个服务，或它在
 *   本 fiber 的作用域里不可见（见模块说明末节）；两者的结论一致，都只能按常量排布。
 *
 * 后两档都会让 {@link effectiveBudgetMs} 落到 `source: 'constant'`，因此调用方不必自己
 * 分辨它们，只需要如实把 `source` 报出去。
 *
 * @param ctx - 插件 context 视图（有 `get(name)`）。
 * @param toolName - 宿主工具名，`'web_search'` 或 `'web_fetch'`。
 * @returns `{ timeoutMs?, source }`；`source` 取 `'host'` / `'unbound'` / `'unavailable'`，
 *   只有 `'host'` 才带 `timeoutMs`。
 */
export function readHostToolBudgetMs(ctx, toolName) {
  const tools = readService(ctx, 'tools');
  if (typeof tools?.get !== 'function') return { source: 'unavailable' };

  // 只传名字、不传 scope：我们手里没有 agent，猜测比读不到更糟（见模块说明）。
  const timeoutMs = tools.get(toolName)?.timeoutMs;
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) return { source: 'unbound' };

  return { timeoutMs, source: 'host' };
}

/**
 * 由宿主预算折算本插件可用的总预算。
 *
 * **余量的理由（`REST-10`）**：总预算必须**早于**宿主掐断我们。只有在本插件自己了断之后，
 * 最后那次尝试的真实上游错误才来得及经 `WebError` 回传给调用方；若让宿主的 deadline 先到，
 * 模型看到的是一条 `tool call timed out after …ms`，上游说了什么则无从得知。余量由
 * `HOST_BUDGET_MARGIN_MS` 给出。
 *
 * 下界 1 毫秒只是为了不产生 0 或负数——那种预算等于取消这次调用，而不是保护它。真到那一步
 * 说明宿主的绑定值已经小到余量都装不下，是部署配置该被看见的时候，而不是这里该悄悄改成
 * 另一个数的时候。
 *
 * @param options - 折算依据，三项都必填。
 * @param options.hostMs - {@link readHostToolBudgetMs} 读到的 `timeoutMs`；没有绑定值时传
 *   `undefined`。
 * @param options.fallbackMs - 宿主没有绑定值时的常量预算
 *   （`SEARCH_TOTAL_BUDGET_MS` 或 `FETCH_TOTAL_BUDGET_MS`）。
 * @param options.marginMs - 留出的余量，取 `HOST_BUDGET_MARGIN_MS`。
 * @returns `{ budgetMs, source }`；`source` 为 `'host'` 表示预算来自宿主绑定值，
 *   `'constant'` 表示来自常量。
 */
export function effectiveBudgetMs({ hostMs, fallbackMs, marginMs }) {
  if (!Number.isFinite(hostMs) || hostMs <= 0) return { budgetMs: fallbackMs, source: 'constant' };

  return { budgetMs: Math.max(1, hostMs - marginMs), source: 'host' };
}

/**
 * 让宿主服务在插件这一侧真正可见（`COMPAT-2`、`PANEL-4`、`CFG-1`、`CFG-5`）。
 *
 * ## 为什么需要这一层
 *
 * Cordis 的类型文档把 `ctx.get(name)` 描述为「不需要 inject 的读取」，但**真实宿主不是
 * 这样**：2026-09-19 在隔离的 `dsh web` 实例里用一个探针插件实测，`ctx.get` 只对
 * **本 fiber 的隔离作用域里可见**的服务返回值。实测结果（同一进程、同一时刻）：
 *
 * | 声明 | `settings` | `connection` | `credentials` | `clientModules` | `launchEnvironment` | `dshHomePath` |
 * |---|---|---|---|---|---|---|
 * | 什么都不声明 | undefined | undefined | undefined | object | object | function |
 * | `inject: ['web']` | undefined | undefined | undefined | object | object | function |
 * | `inject: [...三个]` | object | object | object | object | object | function |
 * | `ctx.inject([...], cb)` | object | object | object | object | object | function |
 *
 * 也就是说：`settings` / `connection` / `credentials` 三项**必须经 `inject` 才能看见**，
 * 而 `clientModules` / `launchEnvironment` / `dshHomePath` 三项对任何 fiber 都可见。
 *
 * ## 为什么不把它们写进插件的 `inject` 列表
 *
 * `inject` 是**全有或全无**的：Cordis 只在声明的服务全部就绪时才加载插件（`Inject` 的
 * 对象形式只是给每项配 intercept，并没有 required/optional 之分）。把三项都写进去，
 * 等于「宿主少了其中任何一个，搜索一并不可用」——那正好违背 `PIN-5` 的半坏仍可用。
 *
 * 正确做法是宿主自己也在用的那个：`ctx.inject([name], cb)`。它给回调一个**子 fiber**，
 * 那个 fiber 里该服务可见，而插件本体照常加载。于是在服务齐备时面板与开关可用，缺一项
 * 时只丢那一项。
 *
 * @module dsh-tavily-pool/dsh/host-services
 */

import { readService } from './read-service.js';

/**
 * 必须经 `inject` 才能看见的服务。
 *
 * 这张表是实测结论而不是猜测：探针脚本与结果见 `docs/dsh-upgrade.md` 的「服务可见性」
 * 一节。它同时也是升级时的检查点——宿主若改变了隔离语义，这里第一个失效。
 */
export const INJECTED_SERVICES = Object.freeze(['settings', 'connection', 'credentials']);

/**
 * 把可见的服务逐个绑进一个普通对象。
 *
 * **回调不是同步的。** 真机实测（毫秒为相对进程启动）：`apply()` 在 `@+817ms` 就结束了，
 * 而 `inject:settings` 到 `@+3385ms` 才跑——它排在**整个 profile 组合完成之后**，比任何
 * 固定延时都晚。因此「服务就绪之后要做的事」（注册面板路由、刷新能力探测、把 settings
 * 服务的就绪反映到探测结果里）只能写在 {@link bindHostServices} 的回调里，不能写在
 * `apply()` 的末尾。
 *
 * @param ctx - 插件 context。
 * @param services - 承载结果的对象；按服务名为键。
 * @param handlers - 每项服务就绪时的回调，按服务名为键；缺席的服务不会被调用。
 * @returns 无。
 */
export function bindHostServices(ctx, services, handlers = {}) {
  for (const name of INJECTED_SERVICES) {
    // 服务缺席时这个子 fiber 永不激活，回调自然不跑——这正是「缺一项只丢一项」的实现。
    ctx.inject([name], (injected) => {
      services[name] = readService(injected, name);
      handlers[name]?.(services[name]);
    });
  }
}

/**
 * 一个把「已绑定的服务」与「插件原有 context」合起来的只读视图。
 *
 * `lib/dsh/` 里的其他模块都经 `readService(ctx, name)` 取服务，因此只要这个视图实现了
 * `get`，它们就一行都不用改。视图让「服务从哪来」这个问题只有一个答案：先看
 * {@link bindHostServices} 绑到的实例，再看 context 自己的作用域。
 *
 * 视图刻意**不缓存**：`ctx.inject` 的回调在服务重建时会再跑一次并覆盖
 * `services[name]`，于是重读就能拿到新实例。
 *
 * @param ctx - 插件 context。
 * @param services - {@link bindHostServices} 填充的对象。
 * @returns 一个有 `get` 的 context 视图。
 */
export function hostView(ctx, services) {
  return {
    get(name) {
      const bound = services[name];
      return bound === undefined ? readService(ctx, name) : bound;
    },
    /** `ctx.logger` 是 context 的自有属性、不是服务，原样透传。 */
    get logger() {
      return ctx.logger;
    },
  };
}

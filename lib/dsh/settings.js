/**
 * 把本插件的设置接到宿主上。
 *
 * DSH 0.1.7 起设置模型换了身份：过去是插件调 `ctx.settings.register(ns, schema)` 自选一个
 * 命名空间，现在是**本插件那条 loader 行自己的配置**——schema 由入口模块的 `Config` 导出
 * 声明，值由 loader 解析后经 `apply(ctx, config)` 递进来。因此本文件只剩两件事：
 * 把已解析的 config 交给宿主无关的 `lib/settings.js` 复校验，以及把面板的写入转成
 * `ctx.settings.update(entryId, patch)`。
 *
 * 写入走宿主而不是自己落盘：校验、落盘、变更通知都由宿主完成——包括 `CFG-4` 的取值校验，
 * 那件事只能有一个来源，而我们导出的 `Config` 就是那个来源。
 *
 * @module dsh-tavily-pool/dsh/settings
 */

import { PANEL_ERROR_CODES } from '../panel.js';
import { PLUGIN_ID } from '../constants.js';
import { readSettings } from '../settings.js';
import { readService } from './read-service.js';

/**
 * 把 loader 交下来的条目配置摊平成纯值。
 *
 * `Config` 里每个字段都带 `.volatile()`，而 volatile 字段解析出来的是一个**活动访问器**
 * （`{ get(), [Symbol(cosmokit.volatile.write)]() }`）而不是纯值——官方包同样写
 * `config.apiKeyEnv.get()`。访问器正是「设置改了立刻生效」的实现方式：面板写下的值经
 * `volatile.write` 落到同一个访问器上，下一次 `.get()` 就是新值，**不需要重载插件**。
 * 本插件每一次决策都重读一遍设置（调度策略是 per-decision 的 thunk，搜索与抓取各自在
 * 入口处读），因此那条语义原样保留。
 *
 * 摊平放在这一层而不是 `lib/settings.js`：访问器是宿主侧的表示，而那个模块按 `COMPAT-1`
 * 不认识任何宿主概念，只该看到一份纯对象。
 *
 * @param config - loader 交下来的条目配置。
 * @returns 纯对象；不是一个对象时返回 `undefined`（每一项各自退回默认值）。
 */
function plainConfig(config) {
  if (config === null || typeof config !== 'object') return undefined;
  return Object.fromEntries(Object.entries(config).map(([key, value]) => [
    key,
    value !== null && typeof value === 'object' && typeof value.get === 'function'
      ? value.get()
      : value,
  ]));
}

/**
 * 读取当前的设置值。
 *
 * 读的是 `apply(ctx, config)` 收下的那份条目配置，每个 volatile 字段取一次 `.get()`。
 * `lib/settings.js` 会再逐项校验一次，因此调用方拿到的一定是九个字段齐全、取值合法的对象。
 *
 * @param state - 插件运行期状态；`config` 是 loader 解析后的条目配置。
 * @returns `{ searchEnabled, fetchEnabled, fetchDepth, fetchFormat, schedulingPolicy,
 *   searchDepth, maxResults, topic, includeAnswer }`。
 */
export function readPluginSettings(state) {
  return readSettings(plainConfig(state.config));
}

/**
 * 把面板提交的设置合并进条目配置（`PANEL-4`、`CFG-3`）。
 *
 * 条目 id 是本插件那条 loader 行的 id（`lib/constants.js` 的 `PLUGIN_ID`），也就是
 * `index.js` 的 `name` 导出——两者与 bundle patch 里 `insert` 的 `id` 必须逐字相同。
 *
 * 校验失败时宿主抛出的错误**原样上抛**（形如 `$.maxResults expected number <= 20 but got 21`），
 * 由 `lib/panel.js` 编成 400：那条消息是用户唯一能据以改正的线索。
 *
 * settings 服务缺席时抛的是带 {@link PANEL_ERROR_CODES.UNAVAILABLE} 码的错误，让面板
 * 能把它与「取值非法」区分开——把「宿主没有这个服务」报成 400 会让用户以为是自己填错。
 *
 * @param state - 插件运行期状态。
 * @param patch - 要合并进条目配置的部分设置。
 * @returns 落盘完成的 promise。
 * @throws {Error} 宿主没有 settings 服务，或它拒绝这次写入时抛出。
 */
export function writePluginSettings(state, patch) {
  // 经 host view 读服务，不是经插件本体的 ctx：`settings` 属于必须 `ctx.inject` 才可见的
  // 那一类（实测表见 `lib/dsh/host-services.js`），在插件 ctx 上 `ctx.get` 会安静地返回
  // `undefined`，于是每一次面板写入都会报成「宿主没有 settings 服务」。
  const settings = readService(state.host, 'settings');
  const update = settings?.update;
  if (typeof update !== 'function') {
    const error = new Error(
      'the host has no settings service, so panel changes cannot be stored '
      + '(ctx.settings.update is not a function)',
    );
    error.code = PANEL_ERROR_CODES.UNAVAILABLE;
    throw error;
  }
  return update.call(settings, PLUGIN_ID, patch);
}

/**
 * 本插件的设置形状，以及运行时怎么把它读出来。
 *
 * 与宿主零耦合（`COMPAT-1`）：schema 由调用方（`lib/dsh/settings.js`）交给宿主的
 * settings 服务，本模块只描述「有哪些设置、默认是什么」。校验交给宿主的 schema 库，
 * 因此这里的形状必须是纯声明。
 *
 * **只有真正被读取的设置才在这里。** `fetchEnabled` 属于抓取接管那个 ticket
 * （`10`），搜索参数属于 `07`；提前放进来会得到一组面板上看得见、实际却不生效的
 * 开关，那比没有更糟。
 *
 * @module dsh-tavily-pool/settings
 */

import { SETTINGS_NAMESPACE } from './constants.js';

/**
 * 搜索接管开关的默认值。
 *
 * 默认开启，因为用户装了插件就是想用它；关闭时按 `PIN-3` 回落到官方提供方。
 */
export const SEARCH_ENABLED_DEFAULT = true;

/**
 * 本插件的设置形状。
 *
 * @param schema - 宿主的 schema 构造器（`@deepseek-ai/schemastery`）。
 * @returns schema 对象。
 */
export function settingsSchema(schema) {
  return schema.object({
    searchEnabled: schema
      .boolean()
      .default(SEARCH_ENABLED_DEFAULT)
      .description('接管 web_search；关闭时转交 DSH 官方搜索提供方'),
  });
}

/**
 * 从 settings 服务读出当前设置。
 *
 * 读取失败一律退到默认值：设置服务坏了不该让搜索也变得不可用，而「按默认值继续
 * 工作」正是 `PIN-5` 的半坏仍可用语义。返回的对象按模块里声明的默认值补齐，因此
 * 调用方不必再判 `undefined`——一个缺失的字段与一个显式写成默认值的字段，对搜索
 * 而言是同一件事。
 *
 * @param source - settings 服务，或它的 `get(namespace)` 结果。
 * @param namespace - 命名空间。
 * @returns `{ searchEnabled }`。
 */
export function readSettings(source, namespace = SETTINGS_NAMESPACE) {
  const raw = readNamespace(source, namespace);
  return {
    searchEnabled: typeof raw?.searchEnabled === 'boolean' ? raw.searchEnabled : SEARCH_ENABLED_DEFAULT,
  };
}

/** 读命名空间，容忍服务缺席或形状改变。 */
function readNamespace(source, namespace) {
  if (source === null || source === undefined) return undefined;
  try {
    const get = source.get;
    if (typeof get === 'function') return get.call(source, namespace);
    return source[namespace];
  } catch {
    return undefined;
  }
}

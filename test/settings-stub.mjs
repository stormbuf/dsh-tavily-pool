/**
 * 一份照 DSH 0.1.7 契约行事的 settings 替身，供需要真实写入链路的用例共用。
 *
 * 旧模型里这些用例借的是宿主**真实的** `SettingsProvider` 基类。0.1.7 换成 `SettingsForms`，
 * 而它要 `configEditor` 与 `profileContext` 两项服务才构造得起来——硬凑那两份替身只会变成
 * 「我们对自己的复述」。但用例真正要压的两件事都可以忠实复刻：
 *
 * 1. **校验**用**同一份** `settingsSchema()`。宿主拿本插件入口模块的 `Config` 校验用户写下的
 *    值，而那份 `Config` 就是这个函数造出来的。于是「越界取值被拒绝」这条断言仍然在说
 *    「按条目 schema 校验拒绝了这个值」，而不是替身在放水；
 * 2. **`config` 是 volatile 访问器形状**，不是纯对象。loader 交下来的就是这样
 *    （`{ get(), [volatile.write]() }`，官方包写 `config.apiKeyEnv.get()`），而 `update()`
 *    把新值写回**同一个访问器**——这正是「面板改完即时生效、无需重载插件」的实现方式。
 *    替身若给纯对象，那条语义就无从验证。
 *
 * `update()` 的第一参固定断言为条目 id：那是 0.1.7 的新身份，写错名字的症状是「设置页保存
 * 无效」而不是报错。
 *
 * @module dsh-tavily-pool/test/settings-stub
 */

import assert from 'node:assert/strict';

import schemaBuilder from '@deepseek-ai/schemastery';

import { PLUGIN_ID } from '../lib/constants.js';
import { settingsSchema } from '../lib/settings.js';

/**
 * 造一份替身。
 *
 * @param initial - 条目的初始配置（纯值）；缺项由 schema 的默认值补齐。
 * @returns `{ config, service, read }`——`config` 交给 `apply()`，`service` 挂到宿主替身上，
 *   `read()` 读回当前值。
 */
export function strictSettings(initial = {}) {
  const schema = settingsSchema(schemaBuilder);
  /** 按 schema 解析成纯值；非法取值在这里抛，与宿主的行为一致。 */
  const resolve = (values) => Object.fromEntries(
    Object.entries(schema(values)).map(([key, field]) => [key, field.get()]),
  );

  const write = Symbol('cosmokit.volatile.write');
  const config = Object.fromEntries(Object.entries(resolve(initial)).map(([key, value]) => {
    let current = value;
    return [key, { get: () => current, [write]: (next) => { current = next; } }];
  }));
  const read = () => Object.fromEntries(
    Object.entries(config).map(([key, accessor]) => [key, accessor.get()]),
  );

  return {
    config,
    read,
    service: {
      describe: () => [{ ns: PLUGIN_ID, value: read() }],
      async update(ns, patch) {
        assert.equal(ns, PLUGIN_ID, 'settings.update 的第一参必须是条目 id');
        const next = resolve({ ...read(), ...patch });
        for (const [key, value] of Object.entries(next)) config[key][write](value);
      },
    },
  };
}

/**
 * 直接写一个 volatile 字段的值。
 *
 * 模拟 loader 侧把新值交给访问器的那一步。用例要验的「改动即时生效、无需重载插件」正是
 * 这条链路，因此它必须能被单独驱动——否则只能靠 `update()` 顺带覆盖。
 *
 * @param config - 桩件的 `config`。
 * @param key - 字段名。
 * @param value - 新值。
 * @returns 无。
 */
export function writeSetting(config, key, value) {
  const accessor = config[key];
  assert.notEqual(accessor, undefined, `配置里没有字段 ${key}`);
  const write = Object.getOwnPropertySymbols(accessor)
    .find((symbol) => String(symbol).includes('volatile.write'));
  assert.notEqual(write, undefined, `${key} 不是 volatile 字段`);
  accessor[write](value);
}

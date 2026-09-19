/**
 * 设置接入，针对宿主**真实的** settings 服务检验。
 *
 * `lib/settings.js` 是纯数据，`lib/dsh/settings.js` 是它与宿主之间的那层。后者搞错在
 * 打桩的替身里是看不见的：替身按我们**以为**的形状实现，于是「服务上其实没有
 * `get(ns)`」这类错误会被替身一起复制过去，测试照样全绿，而真实宿主上开关静默失效。
 *
 * 因此这里继承宿主**真正的** `SettingsProvider` 基类——命名空间注册、取值解析、
 * 校验、写入串行、变更广播全部由它执行，我们只提供一个内存后端。于是被检验的是本
 * 插件与宿主之间那条真实的接缝，而不是我们对它的复述。
 */

import assert from 'node:assert/strict';
import test, { describe } from 'node:test';

import { Context } from '@deepseek-ai/cordis';
import { SettingsProvider } from '@deepseek-ai/dsh-settings';
import schemaBuilder from '@deepseek-ai/schemastery';

import { SETTINGS_NAMESPACE } from '../lib/constants.js';
import { readPluginSettings, registerSettings } from '../lib/dsh/settings.js';
import { settingsSchema } from '../lib/settings.js';

/**
 * 一个内存后端的真实 settings provider。
 *
 * 存储部分（`load` / `persist`）是宿主自己的扩展点，与本插件的适配无关；基类负责的
 * 那部分——注册、解析、校验、`get(ns)`、`describe`、`update` 的串行与广播——才是本
 * 插件真正耦合的东西，也是这条测试要压的。
 *
 * 文档存在闭包里而不是私有字段：基类在初始化期间会以不同的 `this` 调用 `load()`，
 * 而私有字段的访问在那种情形下会抛 `TypeError`——那会是测试替身的毛病，盖过我们真正
 * 想验证的宿主行为。
 */
function memoryProvider() {
  let document = {};
  class MemorySettingsProvider extends SettingsProvider {
    writable = true;

    async load() {
      return document;
    }

    async persist(ns, section) {
      document = { ...document, [ns]: section };
    }
  }
  return MemorySettingsProvider;
}

/**
 * 一个挂着真实 settings 服务的 Cordis context。
 *
 * @returns 真实的 Cordis context。
 */
function contextWithRealSettings() {
  const ctx = new Context();
  new (memoryProvider())(ctx);
  return ctx;
}

describe('CFG-1：设置命名空间注册进宿主真实的 settings 服务', () => {
  test('注册成功，且服务上的 get(ns) 读回 schema 默认值', async () => {
    const ctx = contextWithRealSettings();

    const scope = registerSettings(ctx);

    assert.notEqual(scope, undefined, '真实 settings 服务在场时必须注册成功');
    assert.deepEqual(
      ctx.settings.get(SETTINGS_NAMESPACE),
      {
        searchEnabled: true,
        searchDepth: 'basic',
        maxResults: 10,
        topic: 'general',
        includeAnswer: false,
      },
      '默认值必须由宿主按 schema 解析出来，而不是靠我们自己填',
    );
  });

  test('命名空间以 live 生效，与实际行为一致', async () => {
    const ctx = contextWithRealSettings();
    registerSettings(ctx);

    const [descriptor] = ctx.settings.describe({ redactSecrets: true });

    assert.equal(descriptor.ns, SETTINGS_NAMESPACE);
    assert.equal(
      descriptor.applies,
      'live',
      '开关改动即时生效，因此对配置界面声明的也必须是 live；声明成 restart 会让面板提示重启',
    );
  });

  test('重复注册同一个命名空间会抛错', async () => {
    const ctx = contextWithRealSettings();
    registerSettings(ctx);

    // 这不是「顺手测一下」：插件若为了携带新设置而重新注册，宿主会在此抛错，而那会
    // 让整个设置面失效。`apply()` 因此只注册一次。
    assert.throws(() => registerSettings(ctx), /already registered/u);
  });

  test('用户改动后读取立刻反映新值', async () => {
    const ctx = contextWithRealSettings();
    registerSettings(ctx);

    assert.equal(readPluginSettings(ctx).searchEnabled, true);

    await ctx.settings.update(SETTINGS_NAMESPACE, { searchEnabled: false });

    assert.equal(readPluginSettings(ctx).searchEnabled, false, '面板改完开关，下一次搜索就该看到');
  });

  test('非法取值被宿主的 schema 校验拒绝', async () => {
    const ctx = contextWithRealSettings();
    registerSettings(ctx);

    await assert.rejects(
      () => ctx.settings.update(SETTINGS_NAMESPACE, { searchEnabled: 'not a boolean' }),
      /expected boolean/u,
    );
  });

  test('settings 服务缺席时注册退化为 undefined，而不是抛错', () => {
    // 可选能力缺席不能让插件加载失败：搜索仍要可用，只是开关按默认值走。
    const ctx = { get: () => undefined };

    assert.equal(registerSettings(ctx), undefined);
    assert.deepEqual(
      readPluginSettings(ctx),
      {
        searchEnabled: true,
        searchDepth: 'basic',
        maxResults: 10,
        topic: 'general',
        includeAnswer: false,
      },
      '缺席时用默认值',
    );
  });

  test('读取路径认得 schema 里的每一个字段', () => {
    // 一条防呆断言：schema 里有什么字段，`readSettings` 就得认什么字段。两处分开写是
    // 有意的（一处给宿主渲染，一处给运行时读取），代价是它们可能漂移——例如给 schema
    // 加了开关却忘了在读侧接上，那会得到一个面板上看得见、实际不生效的开关。
    //
    // 字段名取自**真实的** schema 对象：先前这里手搓了一个只认 `boolean` / `object`
    // 的替身，于是 schema 一用到 `union` / `number` 它就先炸，报的是替身的毛病而不是
    // 我们要防的漂移。
    const shape = settingsSchema(schemaBuilder);

    assert.deepEqual(Object.keys(readPluginSettings({ get: () => ({}) })), Object.keys(shape.dict));
  });

  test('用户文档里的越界取值被退回默认值，而不是原样发给 Tavily', async () => {
    // settings.yaml 是一份可以直接编辑的文件，因此解析结果里完全可能出现一个 schema
    // 永远不会写入的值。把它转发给 Tavily 会换回 400，而 400 按 REST-8 既不重试也不
    // 切换密钥——那等于每一次搜索都注定失败。
    const ctx = contextWithRealSettings();
    registerSettings(ctx);

    const settings = readPluginSettings({
      get: () => ({
        searchEnabled: true,
        searchDepth: 'deep',
        maxResults: 99,
        topic: 'sports',
        includeAnswer: 'yes',
      }),
    });

    assert.deepEqual(settings, {
      searchEnabled: true,
      searchDepth: 'basic',
      maxResults: 10,
      topic: 'general',
      includeAnswer: false,
    });
  });

  test('maxResults 的下界是 1，因为 0 会被上游以 400 拒绝', async () => {
    const ctx = contextWithRealSettings();
    registerSettings(ctx);

    await ctx.settings.update(SETTINGS_NAMESPACE, { maxResults: 1 });
    assert.equal(readPluginSettings(ctx).maxResults, 1, '1 是合法取值');

    await assert.rejects(
      () => ctx.settings.update(SETTINGS_NAMESPACE, { maxResults: 0 }),
      /expected number >= 1/u,
      '0 必须被 schema 拒绝：实测上游对 max_results: 0 返回 400 Invalid max results.',
    );
  });

  test('搜索参数的非法取值被 schema 逐一拒绝', async () => {
    const ctx = contextWithRealSettings();
    registerSettings(ctx);

    for (const patch of [
      { searchDepth: 'deep' },
      { topic: 'sports' },
      { maxResults: 21 },
      { maxResults: 2.5 },
      { includeAnswer: 'yes' },
    ]) {
      await assert.rejects(
        () => ctx.settings.update(SETTINGS_NAMESPACE, patch),
        TypeError,
        `${JSON.stringify(patch)} 必须被拒绝`,
      );
    }
  });
});

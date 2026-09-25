/**
 * 设置接入，针对 DSH 0.1.7 的新契约检验。
 *
 * 旧模型里本文件继承宿主**真实的** `SettingsProvider` 基类，压的是「注册 / 解析 / 校验 /
 * `get(ns)` / 写入广播」那条接缝。0.1.7 把那条接缝整个换掉了：设置就是本插件那条 loader
 * 行的配置，schema 由入口模块的 `Config` 导出，值由 loader 解析后经 `apply(ctx, config)`
 * 递进来。于是这里分两层压：
 *
 * 1. **schema 层**——直接拿 `settingsSchema()` 的产物当校验器用。宿主就是拿它校验用户写下的
 *    值，因此「`maxResults: 0` / `21` / `2.5` 必须被拒」这类断言现在的归属是 schema；
 * 2. **适配层**——`lib/dsh/settings.js` 只剩「读 config」与「按条目 id 写」两件事，用一份
 *    **比真实宿主更严格**的替身压它的形状：服务只在 host view 上可见（插件本体的 ctx 上
 *    永远读不到，实测表见 `lib/dsh/host-services.js`），因此写错的实现会在这里炸，而不是
 *    在真机上表现为「面板保存无效」。
 *
 * 与真实宿主的端到端验证不在这里：`SettingsForms` 需要 `configEditor` 与 `profileContext`
 * 两项服务才能构造，硬凑一份替身只会变成「我们对自己的复述」，而它真正要压的那条路径已由
 * `test/live/panel-and-toggles.mjs` 在真实 harness 上跑。
 */

import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import test, { describe } from 'node:test';
import { fileURLToPath } from 'node:url';

import schemaBuilder from '@deepseek-ai/schemastery';

import { PLUGIN_ID } from '../lib/constants.js';
import { PANEL_ERROR_CODES } from '../lib/panel.js';
import { readPluginSettings, writePluginSettings } from '../lib/dsh/settings.js';
import { settingsSchema } from '../lib/settings.js';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');

/** 与其他用例里那份「全部默认值」保持同一份字面量，避免两处各自漂移。 */
const DEFAULTS = Object.freeze({
  searchEnabled: true,
  // 抓取默认关闭（2026-09-20 决定）：抓取走另一条上游路径、额度口径独立，
  // 默认跟随接管等于替用户做了一个他没要求的额度消耗决定。
  fetchEnabled: false,
  fetchDepth: 'basic',
  fetchFormat: 'markdown',
  schedulingPolicy: 'balance',
  searchDepth: 'basic',
  maxResults: 10,
  topic: 'general',
  includeAnswer: false,
});

/**
 * 一份 volatile 访问器形状的配置。
 *
 * **必须长这样**：`.volatile()` 字段经 loader 解析出来的是 `{ get(), [volatile.write]() }`
 * 而不是纯值（官方包同样写 `config.apiKeyEnv.get()`）。用它而不是纯对象，是为了让「有没有
 * 摊平访问器」这件事真的被压到——递一个纯对象的话，少了摊平那一步也照样绿。
 *
 * @param values - 用户层写下的取值。
 * @returns 形如 loader 产物的配置对象。
 */
function volatileConfig(values = {}) {
  const write = Symbol('cosmokit.volatile.write');
  const resolved = { ...DEFAULTS, ...values };
  return Object.fromEntries(Object.entries(resolved).map(([key, value]) => {
    let current = value;
    const accessor = {
      get: () => current,
      [write]: (next) => { current = next; },
    };
    return [key, accessor];
  }));
}

/**
 * 一个插件运行期状态的替身。
 *
 * `ctx` 刻意**读不到任何服务**：真实宿主上 `settings` 不在插件本体的作用域里，只有经
 * `ctx.inject` 绑出来的 host view 才有。把这条差别保留在替身里，是为了让「实现误用
 * `state.ctx`」在这里就失败——那正是过去面板写入报「宿主没有 settings 服务」的形状。
 *
 * @param options - `config` 与 `settings` 服务。
 * @returns 状态替身。
 */
function stateWith({ config = volatileConfig(), settings } = {}) {
  return {
    config,
    ctx: { get: () => undefined },
    host: { get: (name) => (name === 'settings' ? settings : undefined), logger: undefined },
  };
}

describe('CFG-4：schema 是写侧唯一的把关点', () => {
  const schema = settingsSchema(schemaBuilder);

  test('空配置解析出全部默认值', () => {
    const resolved = schema({});
    assert.deepEqual(
      Object.fromEntries(Object.entries(resolved).map(([key, field]) => [key, field.get()])),
      DEFAULTS,
    );
  });

  test('maxResults 的下界是 1，因为 0 会被上游以 400 拒绝', () => {
    // 实测上游对 `max_results: 0` 返回 `400 Invalid max results.`，而 400 按 REST-8
    // 既不重试也不切换密钥——放行 0 等于放出一个每次搜索都必然失败的取值。
    assert.equal(schema({ maxResults: 1 }).maxResults.get(), 1);
    assert.throws(() => schema({ maxResults: 0 }), /\$\.maxResults expected number >= 1/u);
  });

  test('搜索参数的非法取值被逐一拒绝', () => {
    for (const [patch, expected] of [
      [{ searchDepth: 'deep' }, /\$\.searchDepth expected/u],
      [{ topic: 'sports' }, /\$\.topic expected/u],
      [{ maxResults: 21 }, /\$\.maxResults expected number <= 20/u],
      [{ maxResults: 2.5 }, /\$\.maxResults expected number multiple of 1/u],
      [{ includeAnswer: 'yes' }, /\$\.includeAnswer expected boolean/u],
      [{ searchEnabled: 'not a boolean' }, /\$\.searchEnabled expected boolean/u],
    ]) {
      assert.throws(() => schema(patch), expected, `${JSON.stringify(patch)} 必须被拒绝`);
    }
  });

  test('抓取参数与调度策略的非法取值同样被拒（CFG-2、SCHED-7）', () => {
    // 两项抓取参数直接进 `/extract` 的请求体，「面板能存下一个上游必然拒绝的值」与
    // `maxResults` 的 0 是同一类问题：唯一的把关点是这份 schema。
    assert.throws(() => schema({ fetchDepth: 'deep' }), /\$\.fetchDepth expected/u);
    assert.throws(() => schema({ fetchFormat: 'pdf' }), /\$\.fetchFormat expected/u);
    assert.throws(() => schema({ fetchEnabled: 'yes' }), /\$\.fetchEnabled expected boolean/u);
    assert.throws(() => schema({ schedulingPolicy: 'random' }), /\$\.schedulingPolicy expected/u);
  });

  test('每个字段都带 volatile，且字段集与默认值表一致', () => {
    // `volatileForm()` 只保留带 `.volatile()` 的字段，一个都没有的条目**不进
    // `describe()`**，也就没有可编辑的设置页——这正是旧的空 schema 必须配一张自绘卡片
    // 的原因。少标一个字段的症状是「那一项在设置页上消失」，不会报错。
    const fields = Object.entries(schema.dict ?? {});

    assert.deepEqual(
      fields.map(([name]) => name).sort(),
      Object.keys(DEFAULTS).sort(),
      'schema 的字段集与默认值表必须逐项对应',
    );
    for (const [name, node] of fields) {
      assert.equal(node.meta.volatile, true, `${name} 没有标 volatile，它不会出现在设置页上`);
    }
  });
});

describe('CFG-1：读取走 loader 交下来的条目配置', () => {
  test('默认值：什么都没配时逐项退回默认', () => {
    assert.deepEqual(readPluginSettings(stateWith({ config: undefined })), DEFAULTS);
  });

  test('用户取值被原样读出——证明访问器真的被摊平了', () => {
    const settings = readPluginSettings(stateWith({
      config: volatileConfig({
        searchEnabled: false,
        searchDepth: 'advanced',
        maxResults: 3,
        topic: 'news',
        includeAnswer: true,
        fetchEnabled: true,
        fetchDepth: 'advanced',
        fetchFormat: 'text',
        schedulingPolicy: 'manual',
      }),
    }));

    assert.deepEqual(settings, {
      searchEnabled: false,
      fetchEnabled: true,
      fetchDepth: 'advanced',
      fetchFormat: 'text',
      schedulingPolicy: 'manual',
      searchDepth: 'advanced',
      maxResults: 3,
      topic: 'news',
      includeAnswer: true,
    });
  });

  test('设置改动无需重载插件：下一次读取就看到新值', () => {
    // 这是 0.1.7 保留「面板改完即时生效」的方式：accessor 是活的，`volatile.write` 落在
    // 同一个对象上。本插件每次决策都重读一遍，因此这条链路不依赖任何重载。
    const config = volatileConfig({ searchEnabled: true });
    const state = stateWith({ config });
    const write = Object.getOwnPropertySymbols(config.searchEnabled)
      .find((symbol) => String(symbol).includes('volatile.write'));

    assert.equal(readPluginSettings(state).searchEnabled, true);
    config.searchEnabled[write](false);
    assert.equal(readPluginSettings(state).searchEnabled, false, '面板改完开关，下一次搜索就该看到');
  });

  test('越界取值退回默认值，而不是原样发给 Tavily', () => {
    // profile patch 是一份可以直接编辑的文件，因此解析结果里完全可能出现 schema 永远不会
    // 写入的值。把它转发给 Tavily 会换回 400，而 400 按 REST-8 既不重试也不切换密钥——
    // 那等于每一次搜索都注定失败。
    const settings = readPluginSettings(stateWith({
      config: volatileConfig({
        searchEnabled: true,
        searchDepth: 'deep',
        maxResults: 99,
        topic: 'sports',
        includeAnswer: 'yes',
        fetchEnabled: 'yes',
        fetchDepth: 'deep',
        fetchFormat: 'pdf',
      }),
    }));

    assert.deepEqual(settings, { ...DEFAULTS, searchEnabled: true });
  });

  test('读取路径认得 schema 里的每一个字段', () => {
    // 一条防呆断言：schema 里有什么字段，读侧就得认什么字段。两处分开写是有意的（一处给
    // 宿主渲染表单，一处给运行时读取），代价是它们可能漂移——例如给 schema 加了开关却忘了
    // 在读侧接上，那会得到一个设置页上看得见、实际不生效的开关。
    const shape = settingsSchema(schemaBuilder);

    assert.deepEqual(Object.keys(readPluginSettings(stateWith({}))), Object.keys(shape.dict));
  });
});

describe('CFG-3：写入按条目 id 交给宿主', () => {
  test('写入用条目 id，且经 host view 取服务', async () => {
    const calls = [];
    const settings = {
      update: (...args) => {
        calls.push(args);
        return Promise.resolve();
      },
    };

    await writePluginSettings(stateWith({ settings }), { searchEnabled: false });

    assert.deepEqual(
      calls,
      [[PLUGIN_ID, { searchEnabled: false }]],
      '入参必须是条目 id 与 patch；经 state.ctx 读服务会在这里变成 UNAVAILABLE',
    );
  });

  test('宿主的拒绝原样上抛，供面板编成 400', () => {
    const schemaError = new TypeError('$.maxResults expected number <= 20 but got 21');
    const settings = { update: () => Promise.reject(schemaError) };

    assert.rejects(
      () => writePluginSettings(stateWith({ settings }), { maxResults: 21 }),
      (error) => error === schemaError,
    );
  });

  test('settings 服务缺席时报 UNAVAILABLE，而不是 400', () => {
    // 把「宿主没有这个服务」报成 400 会让用户以为是自己填错了值。
    assert.throws(
      () => writePluginSettings(stateWith({}), { searchEnabled: false }),
      (error) => error.code === PANEL_ERROR_CODES.UNAVAILABLE,
    );
  });
});

describe('条目 id 现在是三处共用的身份，必须是同一个字符串', () => {
  test('PLUGIN_ID 与 name 导出、bundle patch 的行 id 一致', async () => {
    // 0.1.7 起宿主以 profile **条目 id** 作为设置的身份：`settings.update(entryId, …)` 用它，
    // 卡片挂 `plugins.row.config` 时用它，`describe()` 返回的 `ns` 也是它。三处里任何一处
    // 漂移，症状都是「设置页保存无效」或「卡片挂不上去」这类不报错的失败。
    const entry = await import('../index.js');
    const patch = await readFile(join(repoRoot, 'cordis.patch.yml'), 'utf8');

    assert.equal(entry.name, PLUGIN_ID, 'index.js 的 name 必须等于 PLUGIN_ID');
    assert.match(
      patch,
      new RegExp(`^\\s*- id: ${PLUGIN_ID}$`, 'mu'),
      'bundle patch 里必须有一行的 id 等于 PLUGIN_ID',
    );
  });
});

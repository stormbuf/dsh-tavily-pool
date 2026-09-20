/**
 * 宿主服务的可见性（`COMPAT-2`、`CFG-1`、`CFG-5`、`PANEL-4`）。
 *
 * 这组用例压的是一个**在真机上才暴露出来**的缺陷：Cordis 的类型文档把 `ctx.get(name)`
 * 描述为「不需要 inject 的读取」，但 2026-09-19 在隔离的 `dsh web` 实例里用探针插件实测，
 * `settings` / `connection` / `credentials` 三项**必须经 `inject` 才能看见**——只声明
 * `inject: ['web']` 时 `ctx.get('settings')` 返回 `undefined`，于是命名空间根本没注册、
 * 面板路由根本没挂上。
 *
 * 因此这里的替身**刻意比真实宿主更严格**：`get` 只返回「本 fiber 注入过」的服务，与实测
 * 行为一致。先前那些用宽松替身（`get` 有求必应）的用例全绿，而真机上插件是坏的——这正是
 * 本文件存在的理由。
 */

import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { describe } from 'node:test';

import { Context } from '@deepseek-ai/cordis';
import { SettingsProvider } from '@deepseek-ai/dsh-settings';
import schemaBuilder from '@deepseek-ai/schemastery';

import { apply } from '../index.js';
import { KEYS_FILE_NAME, SETTINGS_NAMESPACE, STATE_DIR_NAME } from '../lib/constants.js';
import { bindHostServices, hostView, INJECTED_SERVICES } from '../lib/dsh/host-services.js';
import { readPluginSettings } from '../lib/dsh/settings.js';
import { settingsSchema } from '../lib/settings.js';

/**
 * 需要经 `inject` 才能看见的服务——实测结论，与 `INJECTED_SERVICES` 同源。
 *
 * 单独抄一份到这里是有意的：`INJECTED_SERVICES` 若被误删一项，下面那条「三项都真的需要
 * inject」的用例会跟着一起失去判据。
 */
const ISOLATED_SERVICES = Object.freeze(['settings', 'connection', 'credentials']);

/**
 * 一个内存后端的真实 settings provider（与 `dsh-settings.test.js` 同一手法）。
 *
 * **刻意不预注册命名空间**：本文件的每一条用例都走 `apply()`，而命名空间正是要靠插件自己
 * 注册上去的那个东西。预注册会让「插件到底有没有注册」这件事无从判断——重名注册会抛错，
 * 而抛错又被插件收成一条告警，于是测试看起来仍然全绿。
 */
function realSettingsProvider() {
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
  return new (MemorySettingsProvider)(new Context());
}

/**
 * 一个照抄真实宿主可见性规则的 context。
 *
 * 三条规则都来自实测：`get` 只对**注入过**的服务返回值；`ctx.<name>` 对未注入的服务抛
 * `cannot get property "x" without inject`；`ctx.inject` 的回调**不在同步栈上**——真机上
 * `apply()` 在 `@+817ms` 就结束，而 `inject:settings` 到 `@+3385ms` 才跑（它排在**整个
 * profile 组合完成之后**，见 `lib/dsh/host-services.js` 的实测表）。
 *
 * 第三条是 ticket `22` 的 `test-blindspots-1` 补上的。它此前是同步的，于是「在注入回调里
 * 才成立的前置条件」这类缺陷在 555 条用例里没有任何判据——bug #1 与 bug #4 都是这么来的。
 * 要断言注入回调的后果，用 {@link settleInjections} 等一个宏任务。
 *
 * @param services - 该宿主提供的服务。
 * @param options - 覆盖项。
 * @param options.alwaysVisible - 无论是否注入都可见的服务名（实测：
 *   `clientModules` / `launchEnvironment` / `dshHomePath`）。
 * @param options.declaredInject - 插件自己在 `inject` 里声明的服务名。宿主在加载插件时
 *   就按它把这些服务注入进该 fiber——`web` 正是这样可见的。
 * @returns 一个 context 替身。
 */
function strictHost(services, {
  alwaysVisible = ['clientModules', 'launchEnvironment', 'dshHomePath'],
  declaredInject = [],
} = {}) {
  const injected = new Set(declaredInject);
  const ctx = {
    get(name) {
      if (injected.has(name) || alwaysVisible.includes(name)) return services[name];
      return undefined;
    },
    inject(deps, callback) {
      if (!deps.every((name) => services[name] !== undefined)) return { dispose: () => undefined };
      for (const name of deps) injected.add(name);
      // 服务早已就绪，但回调**仍然不在同步栈上**——真实宿主就是这样（探针实测：即便依赖
      // 从一开始就在，`callsImmediatelyAfterInjectReturn` 也是 0）。
      setTimeout(() => {
        callback(ctx);
      }, 0);
      return { dispose: () => undefined };
    },
    logger: { warn: () => undefined },
  };
  // 真实宿主上未注入的服务经属性访问会抛，这里照抄，免得插件无意中依赖属性访问。
  for (const name of Object.keys(services)) {
    Object.defineProperty(ctx, name, {
      get() {
        if (!injected.has(name) && !alwaysVisible.includes(name)) {
          throw new Error(`cannot get property "${name}" without inject`);
        }
        return services[name];
      },
    });
  }
  return ctx;
}

/**
 * 等注入回调跑完。
 *
 * `strictHost.inject` 用 `setTimeout` 推迟回调，而本函数用的是**排在它之后**的另一个宏任务
 * （定时器按到期时刻与入队顺序兑现），因此 `await` 一次就足以看到回调的全部后果。
 *
 * @returns 无。
 */
function settleInjections() {
  return new Promise((resolve) => {
    setTimeout(resolve, 0);
  });
}

describe('实测结论：三项服务必须经 inject 才可见', () => {
  test('INJECTED_SERVICES 与实测的三项一致', () => {
    assert.deepEqual([...INJECTED_SERVICES].sort(), [...ISOLATED_SERVICES].sort());
  });

  test('未注入时 get 读不到，注入后读得到——替身自己先证明它压得住这个缺陷', async () => {
    const host = strictHost({ settings: 'a-settings-service' });

    assert.equal(host.get('settings'), undefined, '未注入时必须读不到，否则这组用例是空转');

    // 用插件真正会走的那条路绑一次。回调**不在同步栈上**，因此要等一个宏任务才能读到。
    const services = {};
    bindHostServices(host, services);
    assert.equal(services.settings, undefined, '注入回调还没跑，服务不该已经绑上');
    await settleInjections();

    assert.equal(services.settings, 'a-settings-service');
    assert.equal(hostView(host, services).get('settings'), 'a-settings-service');
  });

  test('服务缺席时回调永不触发，也不会抛', async () => {
    const host = strictHost({});
    const services = {};
    let called = false;

    assert.doesNotThrow(() => bindHostServices(host, services, { connection: () => { called = true; } }));
    await settleInjections();

    assert.equal(called, false);
    assert.deepEqual(services, {});
    assert.equal(hostView(host, services).get('connection'), undefined);
  });

  test('hostView 在服务缺席时退到 context 自身的作用域', () => {
    // 三条 always-visible 的服务不经 bindHostServices 也能读到，视图必须如实反映。
    const host = strictHost({ clientModules: { marker: true } });
    assert.deepEqual(hostView(host, {}).get('clientModules'), { marker: true });
  });

  test('hostView 透传 logger 这个自有属性', () => {
    const host = strictHost({});
    const logger = { warn: () => undefined };
    host.logger = logger;

    assert.equal(hostView(host, {}).logger, logger);
  });
});

describe('插件在真实可见性规则下仍然接得上（本组用例就是缺陷的回归守卫）', () => {
  /**
   * 在严格宿主上加载插件。
   *
   * @returns `{ ctx, routes, settings, warnings }`。
   */
  async function loadPlugin() {
    const routes = new Map();
    const warnings = [];
    const settings = realSettingsProvider();
    const connection = {
      fetch: {
        register(route) {
          if (routes.has(route.path)) throw new Error(`duplicate route ${route.path}`);
          routes.set(route.path, route);
          return async () => {
            routes.delete(route.path);
          };
        },
      },
    };
    const home = await mkdtemp(join(tmpdir(), 'dsh-tavily-host-services-'));
    const services = {
      web: { registerSearchProvider: () => () => undefined, registerFetchProvider: () => () => undefined },
      settings,
      connection,
      credentials: { resolve: async () => ({ value: 'sk-from-credentials' }) },
      clientModules: {},
      launchEnvironment: { get: () => undefined },
      dshHomePath: (...segments) => join(home, ...segments),
    };
    // `web` 由插件自己的 `inject: ['web']` 注入，因此替身也照此预先标记。
    const ctx = strictHost(services, { declaredInject: ['web'] });
    ctx.logger = { warn: (message) => warnings.push(String(message)) };
    apply(ctx, {});
    // 注入回调不在同步栈上（见 `strictHost` 的注释），因此加载完不等于接好了。
    await settleInjections();
    return { ctx, services, routes, settings, warnings, home };
  }

  test('settings 命名空间真的注册上了（CFG-1）', async () => {
    // 缺陷版本里 `registerSettings` 拿到 undefined 服务就静默返回，于是命名空间从未注册，
    // 宿主也就永远不会派发这张卡片。
    const { settings } = await loadPlugin();

    assert.notEqual(settings.get(SETTINGS_NAMESPACE), undefined, '命名空间必须已注册');
    assert.equal(settings.get(SETTINGS_NAMESPACE).searchEnabled, true, '默认值由宿主按 schema 解析');
  });

  test('面板路由真的挂上了（PANEL-4）', async () => {
    const { routes } = await loadPlugin();

    assert.deepEqual([...routes.keys()].sort(), [
      '/api/tavily-pool.keys',
      '/api/tavily-pool.refresh',
      '/api/tavily-pool.settings',
      '/api/tavily-pool.state',
      '/api/tavily-pool.test',
    ].sort());
  });

  test('经路由写设置落到真实命名空间上（CFG-3）', async () => {
    const { routes, ctx } = await loadPlugin();

    const response = await routes.get('/api/tavily-pool.settings').fetch(new Request('http://x/api/tavily-pool.settings', {
      method: 'POST',
      body: JSON.stringify({ patch: { searchDepth: 'advanced' } }),
    }));

    assert.equal(response.status, 200);
    // 从**插件本体**的 context 读：它看不见 settings 服务，因此只能走 hostView —— 而这里
    // 要证明的正是「面板写进去的值能被搜索路径读到」。
    assert.equal(readPluginSettings(ctx).searchDepth, 'advanced');
  });

  test('越界取值仍被宿主 schema 拒绝（CFG-4）', async () => {
    const { routes } = await loadPlugin();

    const response = await routes.get('/api/tavily-pool.settings').fetch(new Request('http://x/api/tavily-pool.settings', {
      method: 'POST',
      body: JSON.stringify({ patch: { maxResults: 21 } }),
    }));

    assert.equal(response.status, 400);
  });

  test('能力探测如实报告：三项服务不再是 missing（COMPAT-2）', async () => {
    const { routes } = await loadPlugin();
    // 探测推迟一轮宏任务（三项服务只能经异步的 `ctx.inject` 回调取得），因此这里也要等。
    await new Promise((resolve) => {
      setTimeout(resolve, 0);
    });

    const state = await (await routes.get('/api/tavily-pool.state').fetch(
      new Request('http://x/api/tavily-pool.state'),
    )).json();

    assert.equal(state.capabilities.ok, true, '接入之后不再有缺失的必需能力');
    assert.deepEqual(state.capabilities.missingRequired, []);
    assert.deepEqual(state.capabilities.missingOptional, [], 'connection 也不再是缺失的可选能力');
  });

  test('回落凭据经 credentials 服务解析（CFG-5）', async () => {
    const { routes } = await loadPlugin();

    const state = await (await routes.get('/api/tavily-pool.state').fetch(
      new Request('http://x/api/tavily-pool.state'),
    )).json();

    assert.equal(state.fallback.credential, 'configured', '凭据存在时探测必须走 credentials 服务');
    assert.equal(state.fallback.credentialSource, 'probe');
  });

  test('搜索开关经真实 settings 服务生效（CFG-2）', async () => {
    const { settings, ctx } = await loadPlugin();

    await settings.update(SETTINGS_NAMESPACE, { searchEnabled: false });

    assert.equal(readPluginSettings(ctx).searchEnabled, false, '关掉开关之后搜索路径必须读到 false');
  });

  test('宿主缺少 connection 时面板缺席，但设置与搜索照常（PIN-5）', async () => {
    // **这条用例名承诺两件事，此前一件都没断言**（ticket `22` 的 `test-blindspots-7`）：
    // 正文只有 `assert.doesNotThrow` 与「命名空间注册上了」——把面板注册那一段改坏
    // （例如忽略 `registerPanelRoutes` 的 `false` 返回值、或在缺 connection 时半注册），
    // 这条用例照样全绿。因此这里把承诺的两件事都真的断言出来：面板**缺席**，且搜索
    // **照常**（跑一次真的 `search`，而不是只看 `apply()` 不抛）。
    const settings = realSettingsProvider();
    const home = await mkdtemp(join(tmpdir(), 'dsh-tavily-host-services-'));
    const registered = [];
    const warnings = [];
    const services = {
      web: {
        registerSearchProvider(provider) {
          registered.push(provider);
          return () => undefined;
        },
        registerFetchProvider: () => () => undefined,
      },
      settings,
      clientModules: {},
      launchEnvironment: { get: () => undefined },
      dshHomePath: (...segments) => join(home, ...segments),
    };
    const ctx = strictHost(services, { declaredInject: ['web'] });
    ctx.logger = { warn: (message) => warnings.push(String(message)) };
    assert.doesNotThrow(() => apply(ctx, {}), '缺一项可选能力不该让插件加载失败');
    await settleInjections();

    assert.notEqual(settings.get(SETTINGS_NAMESPACE), undefined, '设置照常接上');
    assert.equal(warnings.some((message) => message.includes('settings namespace')), false);
    // 面板**缺席**：缺的正是它唯一依赖的那个服务，因此必须留下那条点名的告警，且不能有
    // 任何路由挂上（这里没有 connection 可挂，判据是「没有把它当成注册成功」）。
    assert.equal(
      warnings.some((message) => message.includes('ctx.connection.fetch.register')),
      true,
      '面板缺席必须留下一条点名缺了什么 capability 的告警',
    );

    // 搜索**照常**：走的是真实提供方 —— 池里没有密钥，且本替身没有 credentials 服务，
    // 因此它必须落到官方回落、并因凭据未配置而失败。**失败的形状本身**就是判据：拿到的是
    // 回落那条路径上的错误码，说明搜索没有被 connection 的缺席拖下水。
    const provider = registered[0];
    assert.notEqual(provider, undefined, '搜索提供方必须已经注册');
    await assert.rejects(
      () => provider.search({ query: 'connection 缺席时搜索照常' }, undefined),
      (error) => {
        assert.equal(error.code, 'TAVILY_FALLBACK_CREDENTIAL_MISSING');
        return true;
      },
    );
  });

  test('密钥池落在宿主 home 解析器给出的目录里（POOL-1）', async () => {
    const { routes, home } = await loadPlugin();

    await routes.get('/api/tavily-pool.keys').fetch(new Request('http://x/api/tavily-pool.keys', {
      method: 'POST',
      body: JSON.stringify({ action: 'add', key: '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' }),
    }));

    const { readFile } = await import('node:fs/promises');
    const written = await readFile(join(home, STATE_DIR_NAME, KEYS_FILE_NAME), 'utf8');
    assert.equal(written.includes('tvly-dev-3sJB25'), true);
  });
});

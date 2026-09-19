/**
 * 面板 HTTP 接口的适配层（`PANEL-4`、`CFG-5`、`COMPAT-3`）。
 *
 * 三件事只有在这里才检验得到，而它们恰恰是最容易做错的三件：
 *
 * 1. **路由真的挂上了**——路径、方法、以及「同一路径不能注册两次」这条宿主约束；
 * 2. **设置的校验是宿主做的**——因此这里用宿主**真实的** `SettingsProvider`，不是替身。
 *    用替身的话，`CFG-4` 的越界取值会被替身一起放过，测试全绿而面板上照样能存下 21；
 * 3. **凭据两态是从真实凭据平面解析出来的**——`CFG-5` 的「未配置」与「已失效」必须
 *    经 `credentials` / 启动环境走一遍才作数。
 *
 * 鉴权那条验收（未通过鉴权的请求被拒）**不在这里**：fence 由宿主在把请求交给精确路由
 * 之前实施，本插件的代码里没有一行鉴权逻辑可测。它属于真机验证（ticket `16`），那里
 * 用真实进程发一次不带 cookie 的请求来证明。
 */

import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { describe } from 'node:test';

import { Context } from '@deepseek-ai/cordis';
import { SettingsProvider } from '@deepseek-ai/dsh-settings';
import schemaBuilder from '@deepseek-ai/schemastery';

import { apply } from '../index.js';
import { KEYS_FILE_NAME, SETTINGS_NAMESPACE, STATE_DIR_NAME } from '../lib/constants.js';
import { PANEL_ROUTE_PATHS, registerPanelRoutes } from '../lib/dsh/panel-routes.js';
import { readPluginSettings } from '../lib/dsh/settings.js';
import { PoolStore } from '../lib/pool.js';
import { settingsSchema } from '../lib/settings.js';

/** 用例里用到的那把明文密钥。任何响应里出现它，都是 `POOL-3` 的失败。 */
const SECRET = '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';

/**
 * 一个内存后端的**真实** settings provider。
 *
 * 与 `dsh-settings.test.js` 同一手法：注册、解析、校验、写入串行全部由宿主基类执行，
 * 我们只提供存储。于是「面板提交的越界取值被拒绝」是在检验真正的接缝。
 *
 * @param options - 覆盖项。
 * @param options.preRegistered - 是否在返回前就注册好命名空间。走 `apply()` 的用例必须
 *   传 `false`：命名空间不可重复注册，预注册会让 `apply()` 里的注册抛错，于是插件被判成
 *   「初始化失败」，而失败的其实是测试桩件。
 * @returns 真实的 settings provider。
 */
function realSettingsProvider({ preRegistered = true } = {}) {
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
  const ctx = new Context();
  const provider = new (MemorySettingsProvider)(ctx);
  if (preRegistered) provider.register(SETTINGS_NAMESPACE, settingsSchema(schemaBuilder));
  return provider;
}

/**
 * 一个照抄宿主行为的 connection 服务。
 *
 * 重复路径会抛错、注册返回 disposer——这两点是宿主的真实语义，也是 ticket `09` 点名要
 * 注意的那条约束，因此替身必须照抄，否则「只注册一次」这件事就测不出来。
 *
 * @returns `{ service, routes }`。
 */
function fakeConnection() {
  const routes = new Map();
  return {
    routes,
    service: {
      fetch: {
        register(route) {
          if (routes.has(route.path)) {
            throw new Error(`connection: exact Fetch route ${JSON.stringify(route.path)} is already registered`);
          }
          routes.set(route.path, route);
          return async () => {
            routes.delete(route.path);
          };
        },
      },
    },
  };
}

/**
 * 一个只提供指定服务的替身 context；`launchEnvironment` 默认是空快照。
 *
 * `inject` 与真实宿主同形：依赖齐全时同步跑回调。插件经它取 `settings` / `connection` /
 * `credentials`，因此替身必须实现它——少了它，走 `apply()` 的用例会在这里抛，而在真实宿主
 * 上却一切正常。
 */
function fakeContext(services) {
  const table = {
    launchEnvironment: { get: () => undefined },
    ...services,
  };
  const ctx = { get: (name) => table[name] };
  ctx.inject = (deps, callback) => {
    if (deps.every((name) => table[name] !== undefined)) callback(ctx);
    return { dispose: () => undefined };
  };
  return ctx;
}

/** 向一条已注册的路由发一次请求。 */
async function call(connection, path, { method = 'GET', body } = {}) {
  const route = connection.routes.get(path);
  assert.notEqual(route, undefined, `${path} 应当已注册`);
  assert.equal(route.methods.includes(method), true, `${path} 应当声明 ${method}`);
  return route.fetch(new Request(`http://127.0.0.1:3080${path}`, {
    method,
    ...body === undefined ? {} : { body: typeof body === 'string' ? body : JSON.stringify(body) },
  }));
}

/** 读一条路由的 JSON 响应。 */
async function callJson(connection, path, options) {
  const response = await call(connection, path, options);
  return { response, body: await response.json() };
}

/** 一个落在临时目录上的状态对象，形状与 `index.js` 里的 `state` 一致。 */
async function panelState({ pool, usageRefresher, lastFallbackFailure } = {}) {
  return {
    pool,
    usageRefresher,
    capabilityReport: undefined,
    reportedFallbackReason: undefined,
    lastFallbackFailure,
  };
}

/** 一个落在全新临时目录上的真实密钥池。 */
async function temporaryPool() {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-tavily-pool-panel-'));
  return new PoolStore({ dir, fileName: KEYS_FILE_NAME }).load();
}

describe('PANEL-4：面板接口挂在 /api 之下', () => {
  test('五条精确路由，方法与用途各自对应', () => {
    const connection = fakeConnection();
    const ctx = fakeContext({ connection: connection.service, settings: realSettingsProvider() });

    assert.equal(registerPanelRoutes(ctx, {}), true);

    assert.deepEqual([...connection.routes.keys()].sort(), [
      '/api/tavily-pool.keys',
      '/api/tavily-pool.refresh',
      '/api/tavily-pool.settings',
      '/api/tavily-pool.state',
      '/api/tavily-pool.test',
    ].sort());
    assert.deepEqual(connection.routes.get(PANEL_ROUTE_PATHS.state).methods, ['GET']);
    for (const path of [PANEL_ROUTE_PATHS.keys, PANEL_ROUTE_PATHS.settings, PANEL_ROUTE_PATHS.refresh, PANEL_ROUTE_PATHS.test]) {
      assert.deepEqual(connection.routes.get(path).methods, ['POST'], `${path} 是写操作，只应接受 POST`);
    }
  });

  test('每条路由都用 buffered 请求体：面板的载荷都是小 JSON', () => {
    const connection = fakeConnection();
    registerPanelRoutes(fakeContext({ connection: connection.service }), {});
    for (const route of connection.routes.values()) {
      assert.equal(route.requestBody, 'buffered');
    }
  });

  test('宿主没有 connection.fetch.register 时返回 false，而不是抛错（PIN-5）', () => {
    // 面板是一项可选能力：宿主形状变了的时候搜索必须照常可用。
    assert.equal(registerPanelRoutes(fakeContext({}), {}), false);
    assert.equal(registerPanelRoutes(fakeContext({ connection: {} }), {}), false);
    assert.equal(registerPanelRoutes(fakeContext({ connection: { fetch: {} } }), {}), false);
  });

  test('同一路径重复注册会抛错，因此 apply() 里只注册一次', () => {
    const connection = fakeConnection();
    const ctx = fakeContext({ connection: connection.service });
    registerPanelRoutes(ctx, {});

    // 这不是「顺手测一下」：宿主对精确路由没有幂等语义，重复注册会抛错。若 apply()
    // 被同一 fiber 执行两次，失败会发生在注册处而不是某次请求上——那时最难定位。
    assert.throws(() => registerPanelRoutes(ctx, {}), /already registered/u);
  });

  test('路径被摘除之后可以重新注册——本文件不留任何「已注册」的本地状态', async () => {
    // 这条压的是**本文件**的性质，不是宿主的：注册一次之后我们不留任何本地记忆，因此路由
    // 被摘掉之后同一个 context 再注册一遍仍然成功。
    //
    // 「插件卸载时路由会被摘掉」本身是**宿主**的保证（`HostConnectionService.registerFetchRoute`
    // 内部就是 `owner.effect(...)`，`owner` 是读取该服务的 fiber），本文件证明不了它——那属于
    // ADR-0003 第 11 个耦合点的升级复核项。
    const connection = fakeConnection();
    const second = fakeConnection();
    const disposers = [];
    const ctx = fakeContext({
      connection: {
        fetch: {
          register(route) {
            disposers.push(connection.service.fetch.register(route));
            return disposers.at(-1);
          },
        },
      },
    });
    registerPanelRoutes(ctx, {});
    await Promise.all(disposers.map((dispose) => dispose()));

    assert.equal(registerPanelRoutes(fakeContext({ connection: second.service }), {}), true);
    assert.equal(connection.routes.size, 0, '旧的注册必须真的被摘掉');
  });
});

describe('响应约定', () => {
  test('响应带 no-store：缓存它会让用户点完「刷新余额」仍看到旧值', async () => {
    const connection = fakeConnection();
    registerPanelRoutes(fakeContext({ connection: connection.service, settings: realSettingsProvider() }), {});

    const { response } = await callJson(connection, PANEL_ROUTE_PATHS.state);

    assert.equal(response.headers.get('cache-control'), 'no-store');
    assert.match(response.headers.get('content-type'), /application\/json/u);
  });

  test('请求体不是 JSON 时是 400，并说明是 JSON 的问题', async () => {
    const connection = fakeConnection();
    registerPanelRoutes(fakeContext({ connection: connection.service }), {});

    const { response, body } = await callJson(connection, PANEL_ROUTE_PATHS.keys, { method: 'POST', body: '{ not json' });

    assert.equal(response.status, 400);
    assert.equal(body.error.code, 'PANEL_BAD_REQUEST');
    assert.match(body.error.message, /not valid JSON/u);
  });

  test('空请求体是合法的：refresh 不带 id 就是「刷新全部」', async () => {
    const connection = fakeConnection();
    registerPanelRoutes(fakeContext({ connection: connection.service }), await panelState({
      pool: await temporaryPool(),
      usageRefresher: { refresh: async () => ({ ok: true }) },
    }));

    const { response, body } = await callJson(connection, PANEL_ROUTE_PATHS.refresh, { method: 'POST' });

    assert.equal(response.status, 200);
    assert.deepEqual(body, { results: [] });
  });

  test('未知动作是 404，并带上机器码', async () => {
    const connection = fakeConnection();
    registerPanelRoutes(fakeContext({ connection: connection.service }), await panelState({
      pool: await temporaryPool(),
      usageRefresher: { refresh: async () => ({ ok: true }) },
    }));

    const { response, body } = await callJson(connection, PANEL_ROUTE_PATHS.keys, {
      method: 'POST',
      body: { action: 'explode' },
    });

    assert.equal(response.status, 404);
    assert.equal(body.error.code, 'PANEL_UNKNOWN_COMMAND');
  });
});

describe('CFG-5：面板上的回落目标状态', () => {
  test('没有任何官方凭据时报「未配置」', async () => {
    const connection = fakeConnection();
    registerPanelRoutes(fakeContext({
      connection: connection.service,
      settings: realSettingsProvider(),
      launchEnvironment: { get: () => undefined },
    }), await panelState({}));

    const { body } = await callJson(connection, PANEL_ROUTE_PATHS.state);

    assert.equal(body.fallback.target, 'deepseek-official');
    assert.equal(body.fallback.credential, 'missing');
    assert.equal(body.fallback.credentialSource, 'probe');
    assert.equal(body.fallback.apiKeyEnv, 'DEEPSEEK_API_KEY', '要指名缺的是哪个凭据');
  });

  test('上一回落被官方拒绝时报「已失效」，而不是「已配置」', async () => {
    // 探测只能说「有值」，而「有值」并不反驳「上次被官方拒了」。因此这一档只能由一次
    // 真实发生过的失败提供——这正是 CFG-5 要求区分的两态。
    const connection = fakeConnection();
    registerPanelRoutes(fakeContext({
      connection: connection.service,
      settings: realSettingsProvider(),
      credentials: { resolve: async () => ({ value: 'sk-present' }) },
    }), await panelState({
      lastFallbackFailure: { code: 'TAVILY_FALLBACK_CREDENTIAL_INVALID', at: '2026-09-19T08:00:00.000Z' },
    }));

    const { body } = await callJson(connection, PANEL_ROUTE_PATHS.state);

    assert.equal(body.fallback.credential, 'invalid');
    assert.equal(body.fallback.credentialSource, 'last-failure');
    assert.equal(body.fallback.lastFailureAt, '2026-09-19T08:00:00.000Z');
  });

  test('凭据配好且没失败过时报「已配置」', async () => {
    const connection = fakeConnection();
    registerPanelRoutes(fakeContext({
      connection: connection.service,
      settings: realSettingsProvider(),
      launchEnvironment: { get: (name) => (name === 'DEEPSEEK_API_KEY' ? { value: 'sk-from-env' } : undefined) },
    }), await panelState({}));

    const { body } = await callJson(connection, PANEL_ROUTE_PATHS.state);

    assert.equal(body.fallback.credential, 'configured');
    assert.equal(body.fallback.credentialSource, 'probe');
  });
});

describe('COMPAT-3、POOL-7：诊断信息出现在面板状态里', () => {
  test('能力探测结果是当场做出来的，不是读加载期缓存', async () => {
    // 这条断言的是一个真实缺陷的修法：三项注入服务要到 profile 组合完成之后才可见，加载期
    // 缓存下来的那份报告会在插件刚起来的那几秒里谎报缺失。因此面板每次读状态都重新探一遍。
    const connection = fakeConnection();
    const ctx = fakeContext({ connection: connection.service, settings: realSettingsProvider() });
    // 有意让宿主缺一项必需能力：seam 上没有注册函数。
    ctx.get = ((original) => (name) => (name === 'web' ? {} : original(name)))(ctx.get);
    registerPanelRoutes(ctx, await panelState({}));

    const { body } = await callJson(connection, PANEL_ROUTE_PATHS.state);

    assert.equal(body.capabilities.ok, false);
    assert.equal(body.capabilities.missingRequired.includes('web.registerSearchProvider'), true);
    assert.match(body.capabilities.findings.find((finding) => finding.id === 'web.registerSearchProvider').remedy, /registerSearchProvider/u);
  });

  test('密钥池文件坏掉时，面板能说出是哪个文件坏了', async () => {
    const home = await mkdtemp(join(tmpdir(), 'dsh-tavily-pool-panel-'));
    const { PoolStore } = await import('../lib/pool.js');
    const dir = join(home, STATE_DIR_NAME);
    await import('node:fs/promises').then(({ mkdir }) => mkdir(dir, { recursive: true }));
    await writeFile(join(dir, KEYS_FILE_NAME), '{ broken', 'utf8');
    const pool = await new PoolStore({ dir, fileName: KEYS_FILE_NAME }).load();

    const connection = fakeConnection();
    registerPanelRoutes(fakeContext({ connection: connection.service, settings: realSettingsProvider() }), await panelState({ pool }));

    const { body } = await callJson(connection, PANEL_ROUTE_PATHS.state);

    assert.deepEqual(body.keys, [], '坏文件按空池继续（POOL-7）');
    assert.equal(body.poolError.reason, 'malformed');
    assert.equal(body.poolError.path, pool.filePath, '要告诉用户该去修哪个文件');
  });
});

describe('密钥池与设置经路由工作', () => {
  /** 一个带着空池与可用刷新器的状态。 */
  async function wired() {
    const home = await mkdtemp(join(tmpdir(), 'dsh-tavily-pool-panel-'));
    const { PoolStore } = await import('../lib/pool.js');
    const pool = await new PoolStore({ dir: home, fileName: KEYS_FILE_NAME }).load();
    const refreshes = [];
    const connection = fakeConnection();
    const settings = realSettingsProvider();
    const state = await panelState({
      pool,
      usageRefresher: {
        refresh: async (id, key, options) => {
          refreshes.push({ id, key, options });
          return { ok: true, recovered: false };
        },
      },
    });
    registerPanelRoutes(fakeContext({ connection: connection.service, settings }), state);
    return { connection, pool, refreshes, settings, home };
  }

  test('添加密钥：响应脱敏，文件里存明文，重启后仍在（POOL-2、POOL-3）', async () => {
    const { connection, home } = await wired();

    const { response, body } = await callJson(connection, PANEL_ROUTE_PATHS.keys, {
      method: 'POST',
      body: { action: 'add', key: SECRET, label: 'primary' },
    });

    assert.equal(response.status, 200);
    assert.equal(body.keys.length, 1);
    assert.equal(body.keys[0].masked, 'tvly-dev-…iJWq');
    assert.equal(body.keys[0].label, 'primary');
    assert.equal(JSON.stringify(body).includes(SECRET), false, '响应里绝不能出现明文');
    assert.equal(
      (await readFile(join(home, KEYS_FILE_NAME), 'utf8')).includes(SECRET),
      true,
      '本地文件里存明文（POOL-2 允许，POOL-3 只约束出口）',
    );
  });

  test('启停与重排即时落盘，无需重启（POOL-4）', async () => {
    const { connection, home } = await wired();
    await callJson(connection, PANEL_ROUTE_PATHS.keys, { method: 'POST', body: { action: 'add', key: SECRET } });
    const { body: first } = await callJson(connection, PANEL_ROUTE_PATHS.state);
    const id = first.keys[0].id;

    const { body } = await callJson(connection, PANEL_ROUTE_PATHS.keys, {
      method: 'POST',
      body: { action: 'setDisabled', id, disabled: true },
    });

    assert.equal(body.keys[0].disabled, true);
    const onDisk = JSON.parse(await readFile(join(home, KEYS_FILE_NAME), 'utf8'));
    assert.equal(onDisk.keys[0].disabled, true, '变更必须已经落盘，而不是只存在于内存里');
  });

  test('刷新余额经真实入口驱动刷新器，并带上 manual 原因（USAGE-1）', async () => {
    const { connection, refreshes } = await wired();
    await callJson(connection, PANEL_ROUTE_PATHS.keys, { method: 'POST', body: { action: 'add', key: SECRET } });

    const { body } = await callJson(connection, PANEL_ROUTE_PATHS.refresh, { method: 'POST', body: {} });

    assert.equal(refreshes.length, 1);
    assert.equal(refreshes[0].options.reason, 'manual', '手动刷新与 SCHED-10 的自动探测要分得开');
    assert.equal(refreshes[0].key, SECRET, '刷新器需要明文去问 /usage——它只在本进程内流转');
    assert.equal(body.results[0].ok, true);
  });

  test('配额跳过如实回到面板上（USAGE-2）', async () => {
    const home = await mkdtemp(join(tmpdir(), 'dsh-tavily-pool-panel-'));
    const { PoolStore } = await import('../lib/pool.js');
    const pool = await new PoolStore({ dir: home, fileName: KEYS_FILE_NAME }).load();
    await pool.addKey({ key: SECRET });
    const connection = fakeConnection();
    registerPanelRoutes(fakeContext({ connection: connection.service, settings: realSettingsProvider() }), await panelState({
      pool,
      usageRefresher: { refresh: async () => ({ ok: false, skipped: 'quota' }) },
    }));

    const { body } = await callJson(connection, PANEL_ROUTE_PATHS.refresh, { method: 'POST', body: {} });

    assert.equal(body.results[0].skipped, 'quota');
    assert.equal(body.results[0].ok, false, '假装刷新成功会让用户以为余额是新鲜的');
  });

  test('连通性测试走 /usage 而不是 /search（12）', async () => {
    const { connection, refreshes } = await wired();
    await callJson(connection, PANEL_ROUTE_PATHS.keys, { method: 'POST', body: { action: 'add', key: SECRET } });
    const { body: state } = await callJson(connection, PANEL_ROUTE_PATHS.state);

    const { body } = await callJson(connection, PANEL_ROUTE_PATHS.test, {
      method: 'POST',
      body: { id: state.keys[0].id },
    });

    assert.equal(body.classification, 'ok');
    assert.equal(refreshes.length, 1, '只探测这一把');
    assert.match(refreshes[0].options.reason, /manual/u);
  });

  test('设置的合法改动立刻被读取路径看到（CFG-3）', async () => {
    const { connection, settings } = await wired();

    const { response, body } = await callJson(connection, PANEL_ROUTE_PATHS.settings, {
      method: 'POST',
      body: { patch: { searchDepth: 'advanced', maxResults: 5 } },
    });

    assert.equal(response.status, 200);
    assert.equal(body.settings.searchDepth, 'advanced');
    assert.equal(body.settings.maxResults, 5);
    assert.equal(
      settings.get(SETTINGS_NAMESPACE).searchDepth,
      'advanced',
      '写入必须落到宿主 settings 服务上，下一次搜索才会立刻看到',
    );
  });

  test('越界取值被宿主的 schema 拒绝，错误文案原样透出（CFG-4）', async () => {
    // 这条是本文件用**真实** SettingsProvider 的理由：替身会把 21 一起放过。
    const { connection, settings } = await wired();

    const { response, body } = await callJson(connection, PANEL_ROUTE_PATHS.settings, {
      method: 'POST',
      body: { patch: { maxResults: 21 } },
    });

    assert.equal(response.status, 400);
    assert.equal(body.error.code, 'PANEL_INVALID_SETTINGS');
    assert.match(body.error.message, /maxResults/u, '文案要指名是哪个字段');
    assert.match(body.error.message, /21/u, '也要带上被拒的值，用户才改得动');
    assert.equal(settings.get(SETTINGS_NAMESPACE).maxResults, 10, '被拒的写入不得留下任何痕迹');
  });

  test('maxResults 的下界同样是 1（CFG-4）', async () => {
    const { connection } = await wired();

    const zero = await callJson(connection, PANEL_ROUTE_PATHS.settings, { method: 'POST', body: { patch: { maxResults: 0 } } });
    assert.equal(zero.response.status, 400, '0 会被上游以 400 拒绝，面板不该放它过去');

    const one = await callJson(connection, PANEL_ROUTE_PATHS.settings, { method: 'POST', body: { patch: { maxResults: 1 } } });
    assert.equal(one.response.status, 200);
  });
});

describe('index.js 真的把接口接上了', () => {
  /**
   * 一个把路由存下来供驱动的宿主替身。
   *
   * 与 `entry.test.js` 的同名桩件同一形状，差别只在两处：`connection.fetch.register` 会把
   * 路由记下来——本组用例要检验的正是「apply() 之后它们存在」；`dshHomePath` 指向一个
   * **真的临时目录**，因为密钥池的写入是真实的 `mkdir` + `rename`，指向一个不存在的根路径
   * 只会让每次编辑都以 EACCES 失败。
   */
  async function hostWithRoutes() {
    const connection = fakeConnection();
    // 不预注册：命名空间由 `apply()` 自己注册，否则这里会以「重复注册」失败，而那失败
    // 属于桩件而不是被测代码。
    const settings = realSettingsProvider({ preRegistered: false });
    const home = await mkdtemp(join(tmpdir(), 'dsh-tavily-pool-apply-'));
    const warnings = [];
    const services = {
      web: { registerSearchProvider: () => () => undefined, registerFetchProvider: () => () => undefined },
      settings,
      clientModules: {},
      connection: connection.service,
      dshHomePath: (...segments) => join(home, ...segments),
      launchEnvironment: { get: () => undefined },
    };
    const ctx = {
      get: (name) => services[name],
      logger: { warn: (message) => warnings.push(String(message)) },
    };
    // 与真实宿主同形：依赖齐全时同步跑回调。
    ctx.inject = (deps, callback) => {
      if (deps.every((name) => services[name] !== undefined)) callback(ctx);
      return { dispose: () => undefined };
    };
    return { connection, settings, warnings, home, ctx };
  }

  test('apply() 注册面板路由，且能经它们读到状态', async () => {
    const host = await hostWithRoutes();

    apply(host.ctx, {});

    assert.equal(host.connection.routes.size, 5, '五条路由都该在 apply() 之后存在');
    const { response, body } = await callJson(host.connection, PANEL_ROUTE_PATHS.state);
    assert.equal(response.status, 200);
    assert.deepEqual(body.keys, []);
    assert.equal(body.settings.searchEnabled, true, '设置由宿主按 schema 解析出默认值');
    assert.equal(body.settings.fetchEnabled, true, '第二个开关同样经宿主 schema 解析（CFG-2）');
    assert.equal(body.settings.fetchDepth, 'basic');
    assert.equal(body.settings.fetchFormat, 'markdown');
  });

  test('apply() 注册的路由能真的添加密钥', async () => {
    const host = await hostWithRoutes();
    apply(host.ctx, {});

    const { body } = await callJson(host.connection, PANEL_ROUTE_PATHS.keys, {
      method: 'POST',
      body: { action: 'add', key: SECRET },
    });

    assert.equal(body.keys.length, 1);
    assert.equal(JSON.stringify(body).includes(SECRET), false);
  });

  test('apply() 注册的面板设置写入落到宿主的命名空间上（CFG-1）', async () => {
    const host = await hostWithRoutes();
    apply(host.ctx, {});

    await callJson(host.connection, PANEL_ROUTE_PATHS.settings, { method: 'POST', body: { patch: { searchEnabled: false } } });

    assert.equal(readPluginSettings(host.ctx).searchEnabled, false);
  });

  test('apply() 二次执行只记一条告警，不把插件判死', async () => {
    const host = await hostWithRoutes();
    apply(host.ctx, {});

    // 宿主对精确路由没有幂等语义，第二次注册会抛错；而那条抛出被 `apply()` 收在面板自己的
    // `try` 里（面板是可选能力，不该因为它把搜索一起关掉），因此这里表现为一条告警。
    // 记成行为而不是加一层「已存在就跳过」的包装：那会把一次真实的重复注册伪装成成功。
    assert.doesNotThrow(() => apply(host.ctx, {}));
    assert.equal(
      host.warnings.some((message) => /could not register the panel HTTP API/u.test(message)),
      true,
      '重复注册必须留下痕迹',
    );
    assert.equal(host.connection.routes.size, 5, '先注册的那一份仍然有效');
  });
});

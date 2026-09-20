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

/** 第二把，用于「磁盘上本来就有多把」的用例。 */
const OTHER_SECRET = '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';

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
 * 一个**注册动作也排在宏任务里**的 settings 服务。
 *
 * 真实 `SettingsProvider.register` 是同步的，于是「注入回调不在同步栈上」这条时序在走
 * `apply()` 的用例里会被它自己抹掉：只要回调跑了，命名空间与路由就同时到位，`apply()`
 * 返回时的那一瞬间看不出区别。这个桩件让 `settings` 服务在注入回调里直接就位、而面板路由
 * 要等注册完才挂上，于是那条时序判据不再被替身自己抹掉——真机上 `inject:settings` 正是排在
 * 整个 profile 组合完成之后（`@+3385ms`）。
 *
 * 它只做 `register`，不做 `get` / `update`：那条用例碰不到后两者，而假装实现它们只会
 * 多出一份会在别处漂移的替身。
 *
 * @returns 一个只有 `register` 的 settings 服务桩件。
 */
function deferredSettingsService() {
  return {
    register() {
      return { get: () => undefined, update: async () => undefined };
    },
  };
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
 * `inject` 与真实宿主同形：依赖齐全时**回调照跑，但不在同步栈上**（真机实测见
 * `lib/dsh/host-services.js`；这条语义是 ticket `22` 的 `test-blindspots-1` 补上的，
 * 同步替身会让「在注入回调里才成立的前置条件」这类缺陷永远隐形）。插件经它取
 * `settings` / `connection` / `credentials`，因此替身必须实现它——少了它，走 `apply()`
 * 的用例会在这里抛，而在真实宿主上却一切正常。
 *
 * 直接调它的用例（不经 `apply()`）只需知道**回调最终会跑**；要断言回调的后果，用
 * {@link settleInjections} 等一个宏任务。
 */
function fakeContext(services) {
  const table = {
    launchEnvironment: { get: () => undefined },
    ...services,
  };
  const ctx = { get: (name) => table[name] };
  ctx.inject = (deps, callback) => {
    if (deps.every((name) => table[name] !== undefined)) {
      setTimeout(() => {
        callback(ctx);
      }, 0);
    }
    return { dispose: () => undefined };
  };
  return ctx;
}

/**
 * 等注入回调跑完。
 *
 * `ctx.inject` 用 `setTimeout` 推迟回调，而本函数用的是**排在它之后**的另一个宏任务
 * （定时器按到期时刻与入队顺序兑现），因此 `await` 一次就足以看到回调的全部后果。
 *
 * @returns 无。
 */
function settleInjections() {
  return new Promise((resolve) => {
    setTimeout(resolve, 0);
  });
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
async function panelState({ pool, usageRefresher, lastFallbackFailure, hostBudget } = {}) {
  return {
    pool,
    usageRefresher,
    capabilityReport: undefined,
    reportedFallbackReason: undefined,
    lastFallbackFailure,
    hostBudget,
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
  async function hostWithRoutes({ settings = realSettingsProvider({ preRegistered: false }) } = {}) {
    const connection = fakeConnection();
    // 不预注册：命名空间由 `apply()` 自己注册，否则这里会以「重复注册」失败，而那失败
    // 属于桩件而不是被测代码。
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
    // 与真实宿主同形：回调不在同步栈上（见 `fakeContext` 的注释）。因此要断言注入回调的
    // 后果（五条路由挂上、命名空间注册好），先 `await host.injections()`——这一条正是
    // ticket `22` 的 `test-blindspots-1` 要压住的时序。
    ctx.inject = (deps, callback) => {
      if (deps.every((name) => services[name] !== undefined)) {
        setTimeout(() => {
          callback(ctx);
        }, 0);
      }
      return { dispose: () => undefined };
    };
    return {
      connection,
      settings,
      warnings,
      home,
      ctx,
      injections: () => new Promise((resolve) => {
        setTimeout(resolve, 0);
      }),
    };
  }

  test('apply() 返回时一条路由都还没挂上——注入回调不在同步栈上', async () => {
    // 这条用例守的是**替身本身**：同步替身下 `apply()` 返回时 `routes.size` 就是 5，而真机
    // 上同一时刻是 0（实测 `apply:end @+817ms`、`inject:settings @+3385ms`）。没有这一条，
    // 「在注入回调里才成立的前置条件」这类缺陷在单测里就没有判据。
    //
    // ⚠️ 判据只有在**没有任何一步同步注册**时才成立：`settings.register` 本身是同步的，
    // 而 `realSettingsProvider` 一调它就注册好了——那 5 条路由因此会在 `apply()` 返回之前
    // 出现，与真实宿主无关，纯粹是替身自己的时序。因此这里把 settings 服务换成一个
    // **注册动作也排在宏任务里**的桩件，让整条链路的时序与真机一致。
    const host = await hostWithRoutes({ settings: deferredSettingsService() });

    apply(host.ctx, {});

    assert.equal(host.connection.routes.size, 0, '注入回调还没跑，路由不该已经在');
    await host.injections();
    assert.equal(host.connection.routes.size, 5, '一个宏任务之后五条都在');
  });

  test('apply() 注册面板路由，且能经它们读到状态', async () => {
    const host = await hostWithRoutes();

    apply(host.ctx, {});
    await host.injections();

    assert.equal(host.connection.routes.size, 5, '五条路由都该在注入回调跑完之后存在');
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
    await host.injections();

    const { body } = await callJson(host.connection, PANEL_ROUTE_PATHS.keys, {
      method: 'POST',
      body: { action: 'add', key: SECRET },
    });

    assert.equal(body.keys.length, 1);
    assert.equal(JSON.stringify(body).includes(SECRET), false);
  });

  test('重启之后先开面板也读得到密钥（ticket 21）', async () => {
    // 「重启 dsh 后密钥不见了」：加载是惰性的、且只有搜索与抓取路径会触发它，于是进程重启后
    // 只要还没搜索过，面板读到的就是空的内存池——而数据一直在文件里。
    //
    // 这条用例之所以此前不存在，是因为 `hostWithRoutes()` 每次都从**空 home** 开始：池本来就是
    // 空的，读不读得到都看不出区别。要抓住它，必须先在磁盘上放一份**非空**的池。
    const host = await hostWithRoutes();
    const stateDir = join(host.home, STATE_DIR_NAME);
    const seeded = await new PoolStore({ dir: stateDir, fileName: KEYS_FILE_NAME }).load();
    await seeded.addKey({ key: SECRET, label: 'on-disk' });
    await seeded.addKey({ key: OTHER_SECRET });

    apply(host.ctx, {});
    await host.injections();

    const { body } = await callJson(host.connection, PANEL_ROUTE_PATHS.state);
    assert.equal(body.keys.length, 2, '面板必须看到磁盘上已有的密钥');
    assert.equal(body.keys[0].label, 'on-disk');
  });

  test('重启之后第一次写入不会抹掉磁盘上已有的密钥（ticket 21）', async () => {
    // 同一个根因的另一半，而且是会造成**数据丢失**的那一半：内存池为空时写盘，写出去的是
    // 「空池 + 这次加的那把」。在隔离实例上实测过：磁盘 3 把 → 面板加一把之后只剩 1 把。
    const host = await hostWithRoutes();
    const stateDir = join(host.home, STATE_DIR_NAME);
    const seeded = await new PoolStore({ dir: stateDir, fileName: KEYS_FILE_NAME }).load();
    await seeded.addKey({ key: SECRET });
    await seeded.addKey({ key: OTHER_SECRET });

    apply(host.ctx, {});
    await host.injections();

    const third = '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';
    const { body } = await callJson(host.connection, PANEL_ROUTE_PATHS.keys, {
      method: 'POST',
      body: { action: 'add', key: third },
    });

    assert.equal(body.keys.length, 3, '面板上应当是 2 + 1');
    const onDisk = JSON.parse(await readFile(join(stateDir, KEYS_FILE_NAME), 'utf8'));
    assert.equal(onDisk.keys.length, 3, '磁盘上原有的两把不得被抹掉');
    assert.deepEqual(
      onDisk.keys.map((entry) => entry.key).slice(0, 2),
      [SECRET, OTHER_SECRET],
      '原有的两把还要保持原来的顺序',
    );
  });

  test('一次请求就能批量添加，行解析与去重都在服务端（POOL-8）', async () => {
    const second = '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';
    const host = await hostWithRoutes();
    apply(host.ctx, {});
    await host.injections();

    const { response, body } = await callJson(host.connection, PANEL_ROUTE_PATHS.keys, {
      method: 'POST',
      body: { action: 'addBatch', text: `\n${SECRET}\n  ${second}  \n${SECRET}\n` },
    });

    assert.equal(response.status, 200);
    assert.equal(body.keys.length, 2, '两把密钥经一次请求加进去');
    assert.deepEqual(body.summary, { received: 3, added: 2, duplicates: 1 });
    assert.equal(JSON.stringify(body).includes(SECRET), false, '出口仍然只有脱敏形式');
    assert.equal(JSON.stringify(body).includes(second), false);
  });

  test('批量添加的入参非法时回一个 400，而不是把异常漏给宿主（POOL-8）', async () => {
    const host = await hostWithRoutes();
    apply(host.ctx, {});
    await host.injections();

    const { response, body } = await callJson(host.connection, PANEL_ROUTE_PATHS.keys, {
      method: 'POST',
      body: { action: 'addBatch', text: '   \n\n' },
    });

    assert.equal(response.status, 400);
    assert.equal(body.error.code, 'PANEL_BAD_REQUEST');
  });

  test('apply() 注册的面板设置写入落到宿主的命名空间上（CFG-1）', async () => {
    const host = await hostWithRoutes();
    apply(host.ctx, {});
    await host.injections();

    await callJson(host.connection, PANEL_ROUTE_PATHS.settings, { method: 'POST', body: { patch: { searchEnabled: false } } });

    assert.equal(readPluginSettings(host.ctx).searchEnabled, false);
  });

  test('apply() 二次执行只记一条告警，不把插件判死', async () => {
    const host = await hostWithRoutes();
    apply(host.ctx, {});
    await host.injections();

    // 宿主对精确路由没有幂等语义，第二次注册会抛错；而那条抛出被 `apply()` 收在面板自己的
    // `try` 里（面板是可选能力，不该因为它把搜索一起关掉），因此这里表现为一条告警。
    // 记成行为而不是加一层「已存在就跳过」的包装：那会把一次真实的重复注册伪装成成功。
    //
    // 第二次 `apply()` 同样要等它的注入回调跑完才能看到那次重复注册——两次 `apply()` 之间
    // 隔着真实的注入时序，与真机上「组件重建导致插件重新加载」的形状一致。
    assert.doesNotThrow(() => apply(host.ctx, {}));
    await host.injections();
    assert.equal(
      host.warnings.some((message) => /could not register the panel HTTP API/u.test(message)),
      true,
      '重复注册必须留下痕迹',
    );
    assert.equal(host.connection.routes.size, 5, '先注册的那一份仍然有效');
  });

  test('进程运行期间外部改动的密钥池，面板下一次读取就能看到（ticket 22 C1）', async () => {
    // 加载只做一次（它是基线），但对账每次都做：面板读到的必须是磁盘实况，而不是第一次
    // 加载时的快照。看不到外部删掉的密钥，用户会以为它还在；看不到外部补上的，会以为丢了。
    const host = await hostWithRoutes();
    const stateDir = join(host.home, STATE_DIR_NAME);
    const seeded = await new PoolStore({ dir: stateDir, fileName: KEYS_FILE_NAME }).load();
    const doomed = await seeded.addKey({ key: SECRET, label: 'on-disk' });
    await seeded.addKey({ key: OTHER_SECRET });

    apply(host.ctx, {});
    await host.injections();
    const before = await callJson(host.connection, PANEL_ROUTE_PATHS.state);
    assert.equal(before.body.keys.length, 2, '先是磁盘上那两把');

    // 外部（另一个进程，或用户手工编辑）删掉一把、又补上一把。
    const third = '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';
    await seeded.removeKey(doomed.id);
    await seeded.addKey({ key: third });

    const after = await callJson(host.connection, PANEL_ROUTE_PATHS.state);
    assert.deepEqual(
      after.body.keys.map((entry) => entry.masked),
      seeded.maskedList().map((entry) => entry.masked),
      '面板上必须是磁盘实况：外部删掉的不见了，外部补上的看得见',
    );
  });

  test('进程运行期间外部补的密钥不会被面板的下一次写入抹掉（ticket 22 C1）', async () => {
    // 落盘前先重读磁盘：面板这次写入带的是「本进程加载之后看到的池」，而磁盘上已经有外部
    // 补进来的那一把了——它必须活下来。
    const host = await hostWithRoutes();
    const stateDir = join(host.home, STATE_DIR_NAME);
    const seeded = await new PoolStore({ dir: stateDir, fileName: KEYS_FILE_NAME }).load();
    await seeded.addKey({ key: SECRET });

    apply(host.ctx, {});
    await host.injections();
    await callJson(host.connection, PANEL_ROUTE_PATHS.state);

    await seeded.addKey({ key: OTHER_SECRET });

    const third = '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';
    const { body } = await callJson(host.connection, PANEL_ROUTE_PATHS.keys, {
      method: 'POST',
      body: { action: 'add', key: third },
    });

    assert.equal(body.keys.length, 3, '面板上应当是「磁盘上那两把 + 这次加的」');
    const onDisk = JSON.parse(await readFile(join(stateDir, KEYS_FILE_NAME), 'utf8'));
    assert.equal(onDisk.keys.length, 3, '外部补的那把不得被抹掉');
  });
});

describe('panel-http-6：写失败的响应体按白名单构造', () => {
  test('500 响应里没有 pid、没有 .tmp、没有绝对路径，但仍有 errno 与文件名', async () => {
    // 让 `keys.json` 的位置是一个**目录**：真实文件系统上「临时文件 + rename 覆盖目标」的
    // 最后一步必然失败，而失败原文里同时带着运行账户的绝对状态目录、进程 pid 与形如
    // `keys.json.<pid>.<uuid>.tmp` 的内部临时文件名。原文由卡片直接渲染给用户看，因此响应体
    // 必须按白名单重新构造：保住 errno、哪一步、哪个文件与下一步，剥掉环境信息。
    //
    // 这里刻意用**真实 fs**（而不是注入的 fs 替身）与真实 `PoolStore`：要守住的正是真实错误
    // 对象上的字段（`code` / `syscall` / 那句带路径的 message），替身会把它们换成我以为的形状。
    const { mkdir } = await import('node:fs/promises');
    const { homedir } = await import('node:os');
    const home = await mkdtemp(join(tmpdir(), 'dsh-tavily-pool-panel-'));
    await mkdir(join(home, KEYS_FILE_NAME));
    const pool = await new PoolStore({ dir: home, fileName: KEYS_FILE_NAME }).load();

    const connection = fakeConnection();
    registerPanelRoutes(
      fakeContext({ connection: connection.service, settings: realSettingsProvider() }),
      await panelState({ pool }),
    );

    const { response, body } = await callJson(connection, PANEL_ROUTE_PATHS.keys, {
      method: 'POST',
      body: { action: 'add', key: SECRET },
    });

    assert.equal(response.status, 500);
    assert.equal(body.error.code, 'PANEL_KEY_EDIT_FAILED');
    const serialized = JSON.stringify(body);
    assert.equal(serialized.includes(String(process.pid)), false, 'pid 是运行账户的内部信息');
    assert.equal(serialized.includes('.tmp'), false, '内部临时文件名不该出现在界面上');
    assert.equal(serialized.includes(home), false, '绝对状态目录同样不该出现');
    assert.equal(serialized.includes(homedir()), false);
    assert.equal(serialized.includes(SECRET), false, '错误出口也不能泄漏明文');
    assert.match(body.error.message, /EISDIR/u, '但排障线索必须保住：errno');
    assert.match(body.error.message, /keys\.json/u, '以及是哪个文件写不进去');
  });
});

describe('panel-http-4：批量删除经 keys 命令出去', () => {
  test('removeBatch 是 keys 的一个动作，一次请求删多把并如实计数', async () => {
    // 批量删除**不需要新路由**：路由表是「每条命令一条 POST 路由」，而它是 `keys` 命令的
    // 一个新动作。前端因此只需要在既有的 keys 端点上换一个 action。
    const home = await mkdtemp(join(tmpdir(), 'dsh-tavily-pool-panel-'));
    const pool = await new PoolStore({ dir: home, fileName: KEYS_FILE_NAME }).load();
    const connection = fakeConnection();
    registerPanelRoutes(
      fakeContext({ connection: connection.service, settings: realSettingsProvider() }),
      await panelState({ pool }),
    );
    const third = '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';
    await callJson(connection, PANEL_ROUTE_PATHS.keys, {
      method: 'POST',
      body: { action: 'addBatch', text: `${SECRET}\n${OTHER_SECRET}\n${third}` },
    });
    const ids = pool.keysInOrder().map((record) => record.id);

    const { response, body } = await callJson(connection, PANEL_ROUTE_PATHS.keys, {
      method: 'POST',
      body: { action: 'removeBatch', ids: [ids[0], ids[2]] },
    });

    assert.equal(response.status, 200);
    assert.deepEqual(body.summary, { received: 2, removed: 2 });
    assert.deepEqual(body.keys.map((entry) => entry.id), [ids[1]]);
    assert.equal(JSON.stringify(body).includes(SECRET), false, '出口仍然只有脱敏形式（POOL-3）');
    const onDisk = JSON.parse(await readFile(join(home, KEYS_FILE_NAME), 'utf8'));
    assert.deepEqual(onDisk.keys.map((entry) => entry.id), [ids[1]], '删除必须已经落盘');
  });
});

describe('host-contract-2：预算来源经 /state 如实投影', () => {
  test('最近一次读数的来源与数值原样出现，一次都没搜过时是 null', async () => {
    // 这条判据是**面板**那一侧的：`state.hostBudget` 由搜索/抓取路径在每次调用时写下，
    // 而它是「宿主收紧 timeout 之后我们有没有跟着收」这个问题唯一的用户可见面。投影里漏掉
    // 这个字段不会报错，只会让那条线索永远看不见——因此这里对着响应体断言。
    const connection = fakeConnection();
    const budget = {
      search: { budgetMs: 58_000, source: 'host', hostSource: 'host' },
      fetch: { budgetMs: 23_000, source: 'host', hostSource: 'host' },
    };
    registerPanelRoutes(
      fakeContext({ connection: connection.service, settings: realSettingsProvider() }),
      await panelState({ pool: await temporaryPool(), hostBudget: budget }),
    );

    const withReading = await callJson(connection, PANEL_ROUTE_PATHS.state);
    assert.deepEqual(withReading.body.hostBudget, budget);

    const fresh = fakeConnection();
    registerPanelRoutes(
      fakeContext({ connection: fresh.service, settings: realSettingsProvider() }),
      await panelState({ pool: await temporaryPool() }),
    );
    const withoutReading = await callJson(fresh, PANEL_ROUTE_PATHS.state);
    assert.equal(withoutReading.body.hostBudget, null, '还没搜过时如实给 null，而不是编一个来源');
  });
});

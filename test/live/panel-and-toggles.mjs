/**
 * 真机验证：开关即时生效、回落、半坏仍可用（ticket `16` 的第 1、6、7、8 项），
 * 外加抓取接管（`10`）与调度策略（`18`）。
 *
 * 单测打的是桩件，而这里打的是**真实宿主服务**：真实的 `WebRuntime`（pin 到本插件）、
 * 真实的 `SettingsProvider`（宿主的基类，不是替身）、真实的 Tavily API 与真实网络。它能
 * 证明而单测证明不了的五件事：
 *
 * 1. **开关即时生效**（第 7 项）：改设置之后**不重新加载插件**，下一次搜索立刻换路径；
 * 2. **回落路径**（第 8 项）：关掉开关后请求转交官方提供方，并记下官方凭据在本机的**真实**
 *    错误码——这一条只有在真机上才有答案；
 * 3. **半坏仍可用**（第 6 项）：密钥池文件损坏时搜索不中断，而是走回落；
 * 4. **patch 的接管真正落到 seam 上**（第 1 项的服务侧一半）：`searchProvider: tavily`
 *    解析到本插件，而不是靠 id 相同碰巧对上；
 * 5. **抓取接管同样落到 seam 上**（第 10 项）：`fetchProvider: tavily` 解析到本插件的抓取
 *    提供方、请求真的抵达 `/extract`，且两个开关互不影响；
 * 6. **调度策略改动即时生效**（第 18 项）：`schedulingPolicy` 切成 `manual` 之后，下一次
 *    搜索立刻改用顺序最前的那把密钥，而不是余额最高的那把。
 *
 * 它需要一把真实密钥，因此不属于 `npm test`：
 *
 *   node test/live/panel-and-toggles.mjs
 *   node test/live/panel-and-toggles.mjs --keys-dir ~/.dsh/dsh-tavily-pool
 *   TAVILY_API_KEY=tvly-... node test/live/panel-and-toggles.mjs
 *
 * 任一项检查失败即以非零码退出。密钥只在本进程内流转，绝不打印。
 */

import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { Context } from '@deepseek-ai/cordis';
import { SettingsProvider } from '@deepseek-ai/dsh-settings';
import { WebRuntime } from '@deepseek-ai/dsh-web';
import schemaBuilder from '@deepseek-ai/schemastery';

import { apply } from '../../index.js';
import { KEYS_FILE_NAME, PROVIDER_ID, SETTINGS_NAMESPACE, STATE_DIR_NAME } from '../../lib/constants.js';
import { PANEL_ROUTE_PATHS } from '../../lib/dsh/panel-routes.js';
import { settingsSchema } from '../../lib/settings.js';

/** 解析 `--flag value` 形式的参数，不引入参数解析库。 */
function flag(name, fallback) {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 && process.argv[index + 1] !== undefined ? process.argv[index + 1] : fallback;
}

/** 输出一条带固定前缀的检查结果，便于用 grep 筛查。 */
function check(label, detail) {
  process.stdout.write(`  ok   ${label}${detail === undefined ? '' : ` — ${detail}`}\n`);
}

/** 一条被观测到的事实（不是断言，而是「本机就是这样」）。 */
function note(label, detail) {
  process.stdout.write(`  note ${label}${detail === undefined ? '' : ` — ${detail}`}\n`);
}

/**
 * 一个内存后端的**真实** settings provider。
 *
 * 与 `test/dsh-settings.test.js` 同一手法：注册、解析、校验、写入串行、变更广播全部由宿主
 * 基类执行。于是「开关即时生效」检验的是真实的设置链路，而不是我们对它的复述。
 */
function memorySettings(ctx) {
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
  return new (MemorySettingsProvider)(ctx);
}

/**
 * 准备一个放着真实密钥的 harness home。
 *
 * @returns harness home 路径。
 */
async function prepareHarnessHome() {
  const configured = flag('keys-dir');
  if (configured !== undefined) {
    const pool = JSON.parse(await readFile(join(configured, KEYS_FILE_NAME), 'utf8'));
    assert.ok(pool.keys.length > 0, `${configured} 里没有密钥`);

    // **复制**到临时 harness home，而不是把真实 home 当工作目录：本脚本会写这把密钥的统计
    // （第 11 项的验收就是它落盘），而用户的密钥池不该被一次验证改写。
    const home = await mkdtemp(join(tmpdir(), 'dsh-tavily-live-'));
    const { PoolStore } = await import('../../lib/pool.js');
    const store = new PoolStore({ dir: join(home, STATE_DIR_NAME), fileName: KEYS_FILE_NAME });
    await store.load();
    for (const record of pool.keys) await store.addKey({ key: record.key, label: record.label ?? 'live' });
    check('已把本机密钥复制进临时 harness home', `${String(pool.keys.length)} 把（明文不打印）`);
    return home;
  }

  const apiKey = process.env.TAVILY_API_KEY;
  if (apiKey === undefined || apiKey.length === 0) {
    process.stderr.write(
      'panel-and-toggles: 没有可用的密钥。设置 TAVILY_API_KEY=tvly-... 或传 '
      + '--keys-dir <含 keys.json 的目录>。\n',
    );
    process.exit(2);
  }
  const home = await mkdtemp(join(tmpdir(), 'dsh-tavily-live-'));
  const { PoolStore } = await import('../../lib/pool.js');
  const store = new PoolStore({ dir: join(home, STATE_DIR_NAME), fileName: KEYS_FILE_NAME });
  await store.load();
  await store.addKey({ key: apiKey, label: 'live' });
  check('已准备临时 harness home', home);
  return home;
}

/**
 * 起一个真实的宿主组合：真实 seam + 真实 settings + 真实插件。
 *
 * @param harnessHome - harness home。
 * @returns `{ ctx, settings }`。
 */
function bootHost(harnessHome, { connection } = {}) {
  process.env.DSH_HOME = harnessHome;
  const ctx = new Context();
  // profile patch 的等价物：`web` 行被 pin 到本插件，**两个提供方字段都写全**——patch 的
  // `config` 是整包替换而不是合并，少写一个的后果正是 ticket `16` 第 2 项要防的那件事。
  new WebRuntime(ctx, { searchProvider: PROVIDER_ID, fetchProvider: PROVIDER_ID });
  if (connection !== undefined) ctx.provide('connection', connection);
  const settings = memorySettings(ctx);
  apply(ctx, {});
  return { ctx, settings };
}

/**
 * 等面板路由挂上。
 *
 * 与设置命名空间同理：插件的 `connection` 注入回调要等组合完成才跑，因此这里轮询。
 *
 * @param routes - 承载路由的 Map。
 * @returns 等待完成的 promise。
 */
async function waitForRoutes(routes) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (routes.size > 0) return;
    await new Promise((resolve) => {
      setTimeout(resolve, 50);
    });
  }
  throw new Error('面板路由迟迟没有注册：connection 的注入回调没有就绪');
}

/**
 * 等到插件的注入回调就绪（命名空间被注册）。
 *
 * 真机上注入回调要等到 profile 组合完成之后才跑（实测约在加载后 2.5 秒），因此这里轮询而
 * 不是假设它已经好了。
 *
 * @param settings - 真实 settings provider。
 * @returns 等待完成的 promise。
 */
async function waitForSettings(settings) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (settings.get(SETTINGS_NAMESPACE) !== undefined) return;
    await new Promise((resolve) => {
      setTimeout(resolve, 50);
    });
  }
  throw new Error('settings 命名空间迟迟没有注册：注入回调没有就绪');
}

/** 一次真实搜索，返回结果或抛出的错误。 */
async function trySearch(ctx, query) {
  try {
    return { ok: true, result: await ctx.web.search({ query, maxResults: 3 }) };
  } catch (error) {
    return { ok: false, error };
  }
}

/** 一次真实抓取，返回结果或抛出的错误。 */
async function tryFetch(ctx, url) {
  try {
    return { ok: true, result: await ctx.web.fetch({ url }) };
  } catch (error) {
    return { ok: false, error };
  }
}

const harnessHome = await prepareHarnessHome();
const { ctx, settings } = bootHost(harnessHome);
await waitForSettings(settings);
check('插件已加载且设置命名空间已注册', `ns=${SETTINGS_NAMESPACE}`);

// ── 第 1、7 项：开关为开时走 Tavily ────────────────────────────────────────────
const first = await trySearch(ctx, 'DeepSeek Harness plugin architecture');
assert.equal(first.ok, true, `开关为开时搜索必须成功：${first.ok ? '' : String(first.error)}`);
assert.ok(first.result.sources.length > 0, '真实搜索应至少返回一条来源');
check('第 1 项：pin 解析到本插件，请求真的抵达 api.tavily.com', `${String(first.result.sources.length)} 条来源`);
check('首条来源', first.result.sources[0].url);

// ── 第 8 项：关掉开关 → 回落官方，并记录官方凭据在本机的真实结论 ──────────────
await settings.update(SETTINGS_NAMESPACE, { searchEnabled: false });
assert.equal(settings.get(SETTINGS_NAMESPACE).searchEnabled, false, '写入必须落到真实 settings 上');

const second = await trySearch(ctx, 'DeepSeek Harness release notes');
if (second.ok) {
  // 本机配了可用的官方凭据：回落真的成功了，这是更强的一条证据。
  check('第 8 项：关掉开关后回落官方成功', `${String(second.result.sources.length)} 条来源`);
} else {
  const code = second.error?.code ?? '(无 code)';
  note('第 8 项：关掉开关后回落到官方，官方路径以本机真实状态失败', `code=${String(code)}`);
  assert.match(
    String(code),
    /^TAVILY_FALLBACK_CREDENTIAL_(MISSING|INVALID)$/u,
    '回落失败必须是「官方凭据未配置」或「官方凭据已失效」二者之一——'
    + '这正是 CFG-5 要求面板区分的那两态；其它错误说明回落的分类不对',
  );
  assert.match(String(second.error.message), /fell back to the DeepSeek official provider/u, '文案必须说清起点');
  assert.match(
    String(second.error.message),
    /the Tavily search toggle is off/u,
    '文案必须说清为什么离开 Tavily——先前写死成「开关关了」，会让密钥池坏掉的用户去翻一个本来就开着的开关',
  );
}

// ── 第 7 项：改回开 → 不重新加载插件，下一次搜索立刻回到 Tavily ────────────────
await settings.update(SETTINGS_NAMESPACE, { searchEnabled: true });
const third = await trySearch(ctx, 'Tavily API pricing');
assert.equal(third.ok, true, `开关改回开之后必须立刻走 Tavily：${third.ok ? '' : String(third.error)}`);
assert.ok(third.result.sources.length > 0);
check('第 7 项：开关改动即时生效，无需重启、无需重新注册提供方');

// ── 第 11 项：一次真实搜索之后，统计真的落在密钥池文件里 ──────────────────────
{
  const { PoolStore } = await import('../../lib/pool.js');
  const poolPath = join(harnessHome, STATE_DIR_NAME, KEYS_FILE_NAME);

  // 统计是**排队落盘**的（写入串行经过同一条 promise 链），因此这里要等它真的到文件里，
  // 而不是假设搜索一返回磁盘就更新了——那正是本条用例要证明的事（「随密钥池持久化」）。
  let store;
  for (let attempt = 0; attempt < 40; attempt += 1) {
    store = await new PoolStore({ dir: join(harnessHome, STATE_DIR_NAME), fileName: KEYS_FILE_NAME }).load();
    if (store.statsOf(store.keysInOrder()[0]?.id)?.calls >= 1) break;
    await new Promise((resolve) => {
      setTimeout(resolve, 50);
    });
  }
  const [record] = store.keysInOrder();
  const stats = store.statsOf(record.id);

  assert.ok(stats?.calls >= 1, `一次真实搜索之后 calls 必须落盘，实际 ${String(stats?.calls)}（${poolPath}）`);
  assert.ok(stats.successes >= 1, '成功次数必须记上');
  assert.ok(
    typeof stats.credits === 'number' || typeof stats.creditsUnknown === 'number',
    '积分消耗要么记成数字、要么记成「未知」，绝不能什么都不记（REST-3）',
  );
  check(
    '第 11 项：调用数/成功数/积分落在 keys.json 的 stats 里',
    `calls=${String(stats.calls)} successes=${String(stats.successes)} credits=${String(stats.credits ?? '未知')}`,
  );
}

// ── 第 10 项：抓取接管与它的独立开关（ticket 10） ──────────────────────────────
{
  // 抓取开关为开：请求必须走 Tavily `/extract`，且返回纯文本。
  //
  // 出站请求在这里被**换掉**而不是真的发出去：本脚本要证明的是「接管的接线对不对」——
  // 请求有没有抵达 Tavily 的抽取端点、参数对不对、返回值是不是被标成 `text`——而
  // `example.com` 在真机上解析到什么地址取决于本机 DNS，那属于另一件事（官方抓取器的
  // 策略），把它混进来只会让这条检查时红时绿。真实密钥的真实搜索已经由前面几项证明。
  const extractCalls = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = (input, init) => {
    const url = typeof input === 'string' ? input : String(input?.url);
    extractCalls.push({ url, body: JSON.parse(init?.body ?? '{}'), authorization: init?.headers?.authorization });
    return Promise.resolve(new Response(JSON.stringify({
      results: [{ url: 'https://example.com', title: 'Example Domain', raw_content: '# Example Domain\n\n正文' }],
      failed_results: [],
      usage: { credits: 0 },
      request_id: 'req-live-extract',
    }), { status: 200 }));
  };

  try {
    const fetched = await tryFetch(ctx, 'https://example.com');
    assert.equal(fetched.ok, true, `抓取开关为开时必须走 Tavily：${fetched.ok ? '' : String(fetched.error)}`);
    assert.equal(extractCalls.length, 1, '一次抓取只该发一个出站请求');
    assert.match(extractCalls[0].url, /api\.tavily\.com\/extract$/u, '必须打到 /extract，而不是 /search');
    assert.match(String(extractCalls[0].authorization), /^Bearer tvly-/u, '抽取请求同样用池中的密钥认证');
    assert.deepEqual(extractCalls[0].body.urls, ['https://example.com']);

    // 硬约束：Tavily 给的已是 markdown，标成 `html` 会被 turndown 二次转换。
    assert.equal(fetched.result.body.kind, 'text');
    assert.equal(fetched.result.body.content, '# Example Domain\n\n正文');
    assert.equal(fetched.result.statusCode, 200);
    check('第 10 项：抓取开关为开时走 /extract，且返回 body.kind = text', extractCalls[0].url);
  } finally {
    globalThis.fetch = realFetch;
  }

  // 抓取开关独立于搜索开关：关掉抓取，抓取换路径，而搜索不受影响。
  //
  // 回落目标在这里被换成一个记录调用的桩件，理由与上面相同（真实的官方抓取器会去做
  // DNS 解析）。**限值是否逐字段复现官方默认**由 `test/dsh-fetch-provider.test.js` 直接
  // 读官方 schema 断言，两者合起来才是完整的回落契约。
  const { officialFetchProvider, setOfficialFetchProvider } = await import('../../lib/dsh/fallback.js');
  const previousTarget = officialFetchProvider();
  const fallbackCalls = [];
  setOfficialFetchProvider({
    id: 'http',
    available: () => true,
    fetch: async (request) => {
      fallbackCalls.push(request.url);
      return { url: request.url, statusCode: 200, body: { kind: 'text', content: 'official fetcher' }, truncated: false };
    },
  });

  try {
    await settings.update(SETTINGS_NAMESPACE, { fetchEnabled: false });
    assert.equal(settings.get(SETTINGS_NAMESPACE).fetchEnabled, false, '写入必须落到真实 settings 上');

    const afterOff = await tryFetch(ctx, 'https://example.com');
    assert.equal(afterOff.ok, true, `关掉抓取开关后必须回落而不是抛错：${afterOff.ok ? '' : String(afterOff.error)}`);
    assert.deepEqual(fallbackCalls, ['https://example.com'], '回落目标收到的就是 seam 的原始请求');
    assert.equal(afterOff.result.body.content, 'official fetcher');

    // 搜索开关没被动过，因此搜索照旧走 Tavily——这正是「两个开关彼此独立」（`CFG-2`）。
    const stillTavily = await trySearch(ctx, 'Tavily extract endpoint');
    assert.equal(stillTavily.ok, true, '关掉抓取不得影响搜索');
    check('第 10 项：关掉抓取开关后抓取转交官方抓取器，搜索仍然走 Tavily');

    await settings.update(SETTINGS_NAMESPACE, { fetchEnabled: true });
    assert.equal(settings.get(SETTINGS_NAMESPACE).fetchEnabled, true);
  } finally {
    setOfficialFetchProvider(previousTarget);
  }
}

// ── 第 12、13 项：走面板接口的真实入口做一次连通性测试与余额刷新 ────────────────
{
  const { PANEL_ROUTE_PATHS } = await import('../../lib/dsh/panel-routes.js');

  // 把 `connection` 在 `apply()` **之后**提供给插件：它的 `ctx.inject(['connection'])` 回调
  // 因此要等到这一刻才跑。这顺带也是那条注入路径的真机证据。
  const routes = new Map();
  ctx.provide('connection', {
    fetch: {
      register(route) {
        routes.set(route.path, route);
        return async () => undefined;
      },
    },
  });
  await waitForRoutes(routes);
  check('面板路由经插件自己的注入回调挂上', `${String(routes.size)} 条`);

  /** 调一条已注册的路由。 */
  const call = async (path, body) => {
    const response = await routes.get(path).fetch(new Request(`http://127.0.0.1${path}`, {
      method: body === undefined ? 'GET' : 'POST',
      ...body === undefined ? {} : { body: JSON.stringify(body) },
    }));
    return response.json();
  };

  // 记录出站请求，用来证明「默认路径不消耗搜索积分」（第 12 项的验收之一）。
  const calls = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = (input, init) => {
    calls.push(typeof input === 'string' ? input : String(input?.url));
    return realFetch(input, init);
  };
  try {
    // ── 第 13 项：刷新余额之后缓存里真的有官方读数，进度条才有东西可画 ──
    const refreshed = await call(PANEL_ROUTE_PATHS.refresh, {});
    assert.equal(refreshed.results.length, 1, '池里此刻只有一把密钥');
    assert.equal(refreshed.results[0].ok, true, `真实 /usage 必须成功：${JSON.stringify(refreshed.results[0])}`);

    const afterRefresh = await call(PANEL_ROUTE_PATHS.state);
    const real = afterRefresh.keys[0];
    assert.equal(typeof real.usage, 'object', '刷新成功后缓存里必须有读数');
    assert.equal(typeof real.usage.key, 'object', '/usage 的 key 段必须被整体覆盖进缓存');
    assert.equal(real.usage.stale, false, '刚刷新出来的读数不是陈旧的');
    check(
      '第 13 项：刷新成功后缓存里是官方读数（进度条据此绘制）',
      `limit=${String(real.usage.key.limit)} usage=${String(real.usage.key.usage)}`,
    );

    // ── 第 12 项：无效密钥返回明确的鉴权失败，且默认路径不碰 /search ──
    calls.length = 0;
    const added = await call(PANEL_ROUTE_PATHS.keys, {
      action: 'add',
      key: 'tvly-dev-invalid0000000000000000000000000000000000000000',
      label: 'live-invalid',
    });
    const invalid = added.keys.find((entry) => entry.label === 'live-invalid');
    assert.notEqual(invalid, undefined, '无效密钥也应当能存进池子——格式校验不是本插件的职责');

    const tested = await call(PANEL_ROUTE_PATHS.test, { id: invalid.id });
    assert.equal(tested.ok, false, '无效密钥不可能通过连通性测试');
    assert.equal(
      tested.classification,
      'auth',
      `无效密钥必须归入「鉴权失败」，实际 ${String(tested.classification)}（${String(tested.error?.code)}）`,
    );
    check(
      '第 12 项：无效密钥返回明确的鉴权失败',
      `classification=${String(tested.classification)} code=${String(tested.error?.code)} status=${String(tested.error?.status)}`,
    );

    assert.ok(calls.length > 0, '连通性测试必须真的发出了一次请求');
    assert.equal(
      calls.every((url) => url.includes('/usage')),
      true,
      `默认路径只该打 /usage，实际 ${calls.join(', ')}`,
    );
    check('第 12 项：默认路径打的是 /usage，不消耗搜索积分', `${String(calls.length)} 次请求，全部为 /usage`);

    // ── 第 10 项：面板状态里同时投影两个开关与两项抓取参数 ──
    //
    // 卡片据这份投影渲染两张开关，因此「两个独立开关」这件事在服务端这一侧的证据就是它们
    // 同时出现在同一次 `/state` 里，且各自是自己的字段。
    const projected = await call(PANEL_ROUTE_PATHS.state);
    assert.equal(typeof projected.settings.searchEnabled, 'boolean');
    assert.equal(typeof projected.settings.fetchEnabled, 'boolean');
    assert.equal(projected.settings.fetchDepth, 'basic');
    assert.equal(projected.settings.fetchFormat, 'markdown');
    check('第 10 项：/state 同时投影两个开关与两项抓取参数');

    // 测试完把这把无效密钥删掉，免得它影响后面的断言。
    await call(PANEL_ROUTE_PATHS.keys, { action: 'remove', id: invalid.id });

    // ── 第 18 项：调度策略改动经真实 settings 即时影响下一次搜索（SCHED-7） ──
    //
    // 池里只有一把真密钥，而「选了哪一把」在单密钥池上无话可说。这里经**面板接口**再加一把
    // 假密钥并把它排到第一位——走面板而不是直接改文件，是因为插件的内存密钥池只在首次使用时
    // 读一次盘（`ensureLoaded` 的记忆化），文件改了它也不会重读，那样测的就不是插件的行为。
    //
    // 假密钥的明文带一个可辨认的前缀，于是「这次用的是哪一把」可以直接从 Authorization 头读出
    // 来；真密钥的明文不打印，也不能打印。
    const FAKE_KEY = 'tvly-dev-manual-first-000000000000000000000000';
    const beforeAdd = (await call(PANEL_ROUTE_PATHS.keys, { action: 'reorder', ids: [] })).keys.map((entry) => entry.id);
    const withFake = await call(PANEL_ROUTE_PATHS.keys, { action: 'add', key: FAKE_KEY });
    // 用**新增的那个 id** 指认假密钥，而不是从脱敏串上猜：真密钥与假密钥的脱敏形式都以
    // `tvly-dev-` 开头（`maskKey` 保留前 9 个字符），按前缀挑会挑中真密钥——第一版就是这么
    // 错的，症状是「重排了，选的还是真密钥」。
    const [fakeId] = withFake.keys.map((entry) => entry.id).filter((id) => !beforeAdd.includes(id));
    assert.notEqual(fakeId, undefined, '假密钥应当被面板接受');
    await call(PANEL_ROUTE_PATHS.keys, {
      action: 'reorder',
      ids: [fakeId, ...withFake.keys.filter((entry) => entry.id !== fakeId).map((entry) => entry.id)],
    });

    // 真密钥的余额刚刚由「刷新余额」写入缓存，因此它是「余额已知」的那把；假密钥从未刷新过，
    // 余额未知——`balance` 策略下垫底，`manual` 下排在最前。
    const keyUsed = async () => {
      const seen = [];
      const original = globalThis.fetch;
      globalThis.fetch = (input, init) => {
        seen.push(init?.headers?.authorization);
        return original(input, init);
      };
      try {
        await trySearch(ctx, 'DeepSeek Harness scheduling');
      } finally {
        globalThis.fetch = original;
      }
      return seen[0];
    };

    assert.equal(
      String(await keyUsed()).includes('manual-first'),
      false,
      'balance：余额已知的真密钥先被选中（假密钥余额未知，垫底）',
    );

    await settings.update(SETTINGS_NAMESPACE, { schedulingPolicy: 'manual' });
    assert.equal(settings.get(SETTINGS_NAMESPACE).schedulingPolicy, 'manual', '写入必须落到真实 settings 上');

    assert.equal(
      String(await keyUsed()).includes('manual-first'),
      true,
      'manual：必须改用排在最前的那把，即使它余额未知、即使另一把余额充足',
    );
    check('第 18 项：schedulingPolicy 改动经真实 settings 即时改变下一次搜索选中的密钥');

    // 收尾：把假密钥删掉、策略改回默认，免得影响后面的检查。
    await call(PANEL_ROUTE_PATHS.keys, { action: 'remove', id: fakeId });
    await settings.update(SETTINGS_NAMESPACE, { schedulingPolicy: 'balance' });
  } finally {
    globalThis.fetch = realFetch;
  }
}

// ── 第 6 项：密钥池文件损坏 → 搜索不中断，回落官方；面板报出该文件 ────────────
const brokenHome = await mkdtemp(join(tmpdir(), 'dsh-tavily-live-broken-'));
const brokenDir = join(brokenHome, STATE_DIR_NAME);
const { mkdir } = await import('node:fs/promises');
await mkdir(brokenDir, { recursive: true });
await writeFile(join(brokenDir, KEYS_FILE_NAME), '{ this is not json', 'utf8');

// 这一台的宿主**带 connection**：于是面板路由会经插件的注入回调真实挂上，而不是由脚本
// 手工注册——那正是要检验的那条路径。
const routes = new Map();
const connection = {
  fetch: {
    register(route) {
      routes.set(route.path, route);
      return async () => {
        routes.delete(route.path);
      };
    },
  },
};
const broken = bootHost(brokenHome, { connection });
await waitForRoutes(routes);
check('面板路由已由插件自己挂上', `${String(routes.size)} 条`);

const fourth = await trySearch(broken.ctx, 'DeepSeek Harness');
assert.equal(
  fourth.ok,
  false,
  '本机没有官方凭据，因此回落必然失败——这里要验证的是它**走的是回落**，而不是抛出密钥池错误',
);
assert.equal(
  String(fourth.error?.code ?? '').startsWith('TAVILY_FALLBACK_CREDENTIAL_'),
  true,
  `坏文件必须走回落路径，实际 code=${String(fourth.error?.code)}`,
);
assert.match(String(fourth.error.message), /the key pool could not be read/u, '文案必须点明起点是密钥池');
check('第 6 项：密钥池文件损坏时搜索走回落而不是中断', `code=${String(fourth.error.code)}`);

// 面板状态必须报出这个坏文件——这是「半坏仍可用」的另一半：用户得知道该去修哪个文件。
const stateResponse = await routes.get(PANEL_ROUTE_PATHS.state).fetch(
  new Request(`http://127.0.0.1${PANEL_ROUTE_PATHS.state}`),
);
assert.equal(stateResponse.status, 200);
const panel = await stateResponse.json();
assert.equal(panel.keys.length, 0, '坏文件按空池继续（POOL-7）');
assert.equal(panel.poolError?.reason, 'malformed');
assert.match(String(panel.poolError?.message), /not valid JSON/u);
check('第 6 项：面板报出坏文件与它的路径', panel.poolError.path);

process.stdout.write('panel-and-toggles: 全部真机检查通过\n');
process.exit(0);

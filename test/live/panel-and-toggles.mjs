/**
 * 真机验证：开关即时生效、回落、半坏仍可用（ticket `16` 的第 1、6、7、8 项）。
 *
 * 单测打的是桩件，而这里打的是**真实宿主服务**：真实的 `WebRuntime`（pin 到本插件）、
 * 真实的 `SettingsProvider`（宿主的基类，不是替身）、真实的 Tavily API 与真实网络。它能
 * 证明而单测证明不了的四件事：
 *
 * 1. **开关即时生效**（第 7 项）：改设置之后**不重新加载插件**，下一次搜索立刻换路径；
 * 2. **回落路径**（第 8 项）：关掉开关后请求转交官方提供方，并记下官方凭据在本机的**真实**
 *    错误码——这一条只有在真机上才有答案；
 * 3. **半坏仍可用**（第 6 项）：密钥池文件损坏时搜索不中断，而是走回落；
 * 4. **patch 的接管真正落到 seam 上**（第 1 项的服务侧一半）：`searchProvider: tavily`
 *    解析到本插件，而不是靠 id 相同碰巧对上。
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
    const dir = configured.replace(/\/dsh-tavily-pool$/u, '');
    const pool = JSON.parse(await readFile(join(configured, KEYS_FILE_NAME), 'utf8'));
    assert.ok(pool.keys.length > 0, `${configured} 里没有密钥`);
    check('复用本机密钥池', `${String(pool.keys.length)} 把（明文不打印）`);
    return dir;
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
  // profile patch 的等价物：`web` 行被 pin 到本插件，两个提供方字段都写全。
  new WebRuntime(ctx, { searchProvider: PROVIDER_ID, fetchProvider: 'http' });
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

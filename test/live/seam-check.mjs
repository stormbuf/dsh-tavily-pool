/**
 * 真机 seam 检查：真实宿主服务、真实插件、真实 Tavily API。
 *
 * 这是单测无法替代的、issue-16 式的验证。它从 `@deepseek-ai/dsh-web` 构造一个真正的
 * `ctx.web` 服务，把本插件的 `apply()` 挂进一个真实 Cordis context，并像
 * `dsh-tool-web` 那样驱动一次搜索。它证明的是任何桩件都证明不了的事：
 *
 * - seam 把 `searchProvider: 'tavily'` 解析到本插件的提供方；
 * - `available()` 不会触发 `WEB_PROVIDER_CONFIGURED_UNAVAILABLE`；
 * - 请求真的抵达 `api.tavily.com`，且响应能正确映射回来；
 * - seam 自己对 `maxResults` 的执行作用在本次结果上。
 *
 * 它需要一把密钥，因此不属于 `npm test`。用下面任一方式提供：
 *
 *   TAVILY_API_KEY=tvly-... node test/live/seam-check.mjs
 *   node test/live/seam-check.mjs --keys-dir ~/.dsh/dsh-tavily-pool
 *
 * 任一项检查失败即以非零码退出。
 */

import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdtemp, readFile, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { Context } from '@deepseek-ai/cordis';
import { WebRuntime } from '@deepseek-ai/dsh-web';

import { apply, inject } from '../../index.js';
import { PROVIDER_ID, STATE_DIR_NAME } from '../../lib/constants.js';
import { PoolStore } from '../../lib/pool.js';

/** 解析 `--flag value` 形式的参数，不引入参数解析库。 */
function flag(name, fallback) {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 && process.argv[index + 1] !== undefined ? process.argv[index + 1] : fallback;
}

/** 输出一条带固定前缀的检查结果，便于用 grep 筛查。 */
function check(label, detail) {
  process.stdout.write(`  ok   ${label}${detail === undefined ? '' : ` — ${detail}`}\n`);
}

/**
 * 把 `DSH_HOME` 指向一个放着密钥的目录。
 *
 * 插件经 `ctx.dshHomePath` 解析密钥池，而它在调用时读取 `$DSH_HOME`，所以在这里设置
 * 它就等同于换了一个 harness home——插件里没有任何仅供测试的钩子。
 *
 * @returns harness home；此时密钥已就位。
 */
async function prepareHarnessHome() {
  const configured = flag('keys-dir');
  if (configured !== undefined) return configured.replace(/\/dsh-tavily-pool$/u, '');

  const apiKey = process.env.TAVILY_API_KEY;
  if (apiKey === undefined || apiKey.length === 0) {
    process.stderr.write(
      'seam-check: no key available. Set TAVILY_API_KEY=tvly-... or pass '
      + '--keys-dir <dir containing keys.json>.\n',
    );
    process.exit(2);
  }
  const home = await mkdtemp(join(tmpdir(), 'dsh-tavily-seam-'));
  const store = new PoolStore({ dir: join(home, STATE_DIR_NAME), fileName: 'keys.json' });
  await store.load();
  await store.addKey({ key: apiKey, label: 'seam-check' });
  check('已准备临时 harness home', home);
  return home;
}

const harnessHome = await prepareHarnessHome();
process.env.DSH_HOME = harnessHome;

// 一个真实的 Cordis context，以及一个完全按 profile patch 的方式 pin 住的真实 seam 服务。
const ctx = new Context();
new WebRuntime(ctx, { searchProvider: PROVIDER_ID, fetchProvider: PROVIDER_ID });

assert.deepEqual(inject, ['web'], '插件必须声明 web 依赖');
apply(ctx, {});
check('插件已加载', `registered searchProvider=${PROVIDER_ID}`);

const result = await ctx.web.search({ query: 'DeepSeek Harness plugin architecture', maxResults: 3 });

assert.ok(Array.isArray(result.sources), 'sources 必须是数组');
assert.ok(result.sources.length > 0, '真实搜索应至少返回一条来源');
assert.ok(result.sources.length <= 3, 'seam 必须对本次结果执行 maxResults');
for (const source of result.sources) {
  assert.match(source.url, /^https?:\/\//u, `来源 url 必须是绝对地址：${String(source.url)}`);
}
check('搜索返回了来源', `${String(result.sources.length)} 条（maxResults=3 已执行）`);
check('首条来源', result.sources[0].url);
if (result.content !== undefined) check('提供方答案存在', `${String(result.content.length)} 字符`);

// `available()` 是唯一「违反即硬抛而非回落」的契约，因此必须在**不读注册表**的前提下
// 验证它——注册表是本插件被禁止触碰的宿主私有状态（COMPAT-6）。重复注册同一个 id 是
// 证明我们已在其中的公开面：seam 拒绝重复。`registerSearchProvider` 是同步抛出。
const probeCtx = new Context();
new WebRuntime(probeCtx, { searchProvider: PROVIDER_ID });
apply(probeCtx, {});
assert.throws(
  () => probeCtx.web.registerSearchProvider({ id: PROVIDER_ID, available: () => true, search: async () => ({}) }),
  (error) => error.code === 'WEB_DUPLICATE_PROVIDER',
  '重复注册同一 id 必须失败，这证明我们的提供方已注册',
);
check('提供方 id 已注册（重复注册被拒）');

// pin 会经 `available()` 解析到我们的提供方，因此第二次真实搜索能完成，即证明它在
// 真实使用之后仍是 `true`。
const second = await ctx.web.search({ query: 'DeepSeek Harness release notes', maxResults: 1 });
assert.ok(second.sources.length >= 1, '经 pin 的第二次搜索仍必须解析成功');
check('第二次真实调用时 available() 仍为 true');

// 再证明：若 pin 指向一个并不存在的 id，seam 会抛错——上面几项检查因此不是空转。
const unpinned = new Context();
new WebRuntime(unpinned, { searchProvider: 'definitely-not-registered' });
await assert.rejects(
  () => unpinned.web.search({ query: 'x' }),
  (error) => error.code === 'WEB_PROVIDER_CONFIGURED_MISSING',
  '未注册的 pin 必须抛 WEB_PROVIDER_CONFIGURED_MISSING',
);
check('对照项：未注册的 pin 抛 WEB_PROVIDER_CONFIGURED_MISSING');

// ── ticket 22 C2：调用历史在一个**全新的**状态目录上也要写得进去 ──────────────
//
// 这条是 2026-09-20 真机实测抓到的：抢锁发生在建目录之前，于是全新状态目录上的第一次追加
// 以 `ENOENT` 失败，而那次 `mkdir` 从来没机会跑到。真机症状是「一次真实搜索之后历史是空的」
// ——面板上少一段曲线，且没有任何解释。它只在**目录还不存在**时现形，因此这里刻意用一个
// 没建过的目录，而不是 `harnessHome` 里那个已经被密钥池建好的。
{
  const { CallHistory } = await import('../../lib/history.js');
  const { HISTORY_FILE_NAME } = await import('../../lib/constants.js');
  const freshDir = join(harnessHome, 'history-only', STATE_DIR_NAME);
  const history = new CallHistory({ dir: freshDir, fileName: HISTORY_FILE_NAME });

  const appended = await history.append({
    endpoint: 'search',
    keyId: 'seam-check-key',
    keyMasked: 'tvly-dev-…seam',
    outcome: 'ok',
    durationMs: 42,
    credits: 1,
    requestId: 'seam-check-request',
  });
  assert.equal(appended, true, `全新目录上的第一次追加必须成功：${String(history.lastWriteError)}`);

  const written = JSON.parse(await readFile(join(freshDir, HISTORY_FILE_NAME), 'utf8'));
  assert.equal(written.entries.length, 1, '历史必须真的落盘');
  assert.equal(written.entries[0].requestId, 'seam-check-request', 'request_id 必须被留下');

  const leftovers = (await readdir(freshDir)).filter((name) => name.endsWith('.lock'));
  assert.deepEqual(leftovers, [], '写完之后不得残留锁文件');
  check('第 22 项 C2：全新状态目录上第一次追加成功，且锁文件已释放', join(freshDir, HISTORY_FILE_NAME));
}

// ── ticket 22 F2：宿主平面的服务，另一个插件的 fiber 在**请求时**读得到 ──────────
//
// 真机复验 F2 需要一个带模型凭据的实例（要真的让 agent 跑一次 `web_search`），而本机没有
// 可用的官方 key。这条因此压的是**语义**而不是那台实例：用同一份 cordis 复现「宿主平面的
// 服务 vs 另一个插件」这一对角色，确认请求时读得到——这正是本插件读 `tools` 的时机
// （`budgetFor` 在每次调用开头读，不在加载期读）。
//
// 顺带钉住一条容易踩的时序：`inject` 回调跑的那一刻，宿主平面的服务**可能还没挂上**
// （实测两种挂载顺序下都为 `undefined`），因此「加载期读一次并缓存」的写法在真机上会静默
// 退回常量。本插件的读法不受影响，但这条语义值得留个判据。
{
  const root = new Context();
  root.provide('web', {});
  let consumerCtx;
  root.plugin({ name: 'seam-check-consumer', inject: ['web'], apply(ctx) { consumerCtx = ctx; } }, {});
  await new Promise((resolve) => { setTimeout(resolve, 20); });

  const atApplyTime = consumerCtx.get('tools');
  root.plugin({ name: 'seam-check-host-plane', apply(ctx) { ctx.provide('tools', { marker: 'host-plane' }); } }, {});
  await new Promise((resolve) => { setTimeout(resolve, 20); });
  const atRequestTime = consumerCtx.get('tools');

  assert.equal(atApplyTime, undefined, '注入回调那一刻还没挂上的服务，读不到是预期的');
  assert.equal(atRequestTime?.marker, 'host-plane', '宿主平面 provide 的服务，请求时必须读得到');
  check('第 22 项 F2：宿主平面的服务在请求时可读（cordis 语义判据）', 'tools → host-plane');
}

process.stdout.write('seam-check: 全部真机检查通过\n');
process.exit(0);

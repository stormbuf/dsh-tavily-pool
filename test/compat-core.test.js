/**
 * 与宿主零耦合的内核，从外部做检查（`COMPAT-1`）。
 *
 * 这些模块是升级时**绝不该**需要改动的部分，因此最要紧的测试是那条结构性断言：
 * 它们必须能在完全看不到 harness 的情况下导入与测试。
 *
 * `COMPAT-1` 点名的五个模块已全部落地，因此 `CONTRACTED_MODULES` 与
 * `HOST_FREE_MODULES` 现在完全相同；那条「要么已被覆盖、要么尚未写出」的断言随之失效，
 * 换成下面两条覆盖面更宽的检查。
 */

import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import test, { describe } from 'node:test';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');

/**
 * 承载浏览器半边的文件：它是一份**脚本**（读 `window.__ModuleLoader__`），不是模块，
 * 因此既不能 `import`，也不该出现在上面那张表里。分类见下面的「每个 lib/ 模块都要被归类」。
 */
const BROWSER_ONLY_MODULES = ['lib/client.js'];

/**
 * 兼容性契约禁止其了解宿主的模块。
 *
 * 每当新建一个逻辑内核模块，就往这里加一条。
 */
const HOST_FREE_MODULES = [
  'lib/tavily.js',
  'lib/pool.js',
  'lib/scheduler.js',
  'lib/health.js',
  'lib/attempts.js',
  'lib/settings.js',
  'lib/usage.js',
  'lib/constants.js',
  'lib/panel.js',
  'lib/history.js',
  'lib/balance.js',
  'lib/balance-refresh.js',
];

/** 插件源码：入口加全部 lib/ 模块（含 lib/dsh/ 适配层）。 */
async function pluginSources() {
  const libFiles = await readdir(join(repoRoot, 'lib'));
  const dshFiles = await readdir(join(repoRoot, 'lib/dsh'));
  return [
    'index.js',
    ...libFiles.filter((name) => name.endsWith('.js')).map((name) => `lib/${name}`),
    ...dshFiles.filter((name) => name.endsWith('.js')).map((name) => `lib/dsh/${name}`),
  ];
}

/** 一个文件里所有 import / export ... from 的模块说明符。 */
function importSpecifiers(source) {
  return [...source.matchAll(/^\s*(?:import|export)[^'"]*from\s+['"]([^'"]+)['"]/gmu)]
    .map((match) => match[1]);
}

describe('COMPAT-1：逻辑内核不依赖宿主', () => {
  for (const relativePath of HOST_FREE_MODULES) {
    test(`${relativePath} 不 import 任何 @deepseek-ai/* 包`, async () => {
      const source = await readFile(join(repoRoot, relativePath), 'utf8');
      const hostImports = importSpecifiers(source).filter((specifier) => specifier.startsWith('@deepseek-ai/'));
      assert.deepEqual(hostImports, [], `${relativePath} 不得 import 宿主包`);
    });

    test(`${relativePath} 无需 harness 即可导入并工作`, async () => {
      const module = await import(`../${relativePath}`);
      assert.ok(Object.keys(module).length > 0, `${relativePath} 应当有导出`);
    });
  }
});

describe('COMPAT-1：每个 lib/ 模块都要被归类', () => {
  test('新模块要么进 HOST_FREE_MODULES，要么显式声明为浏览器半边', async () => {
    // 升级文档承诺「创建内核模块却忘了加进清单会在测试里失败」，而先前并没有这条断言：
    // 漏加一个模块的后果是它悄悄不受 `COMPAT-1` 保护。这里把承诺兑现——一个既不在
    // 内核清单、也不在浏览器半边清单里的 `lib/*.js` 会让这条用例红。
    const libFiles = (await readdir(join(repoRoot, 'lib')))
      .filter((name) => name.endsWith('.js'))
      .map((name) => `lib/${name}`)
      .sort();

    const classified = [...HOST_FREE_MODULES, ...BROWSER_ONLY_MODULES].sort();
    assert.deepEqual(libFiles, classified, 'lib/ 下每个模块都必须被归类');
  });
});

describe('COMPAT-4：每个被 import 的宿主包都在 package.json 里声明', () => {
  test('未声明的宿主依赖会让插件在严格的包布局下整个加载失败', async () => {
    // 这条压的是一个真实的漏网：`lib/dsh/fallback.js` 新增了 `dsh-credentials` 与
    // `dsh-launch-environment` 两个顶层 import，却只靠 `dsh-web-search-deepseek` 的
    // peerDependencies 经 npm 扁平提升才能在本地解析到。按 AGENTS.md，插件经 **pnpm**
    // 安装，而 pnpm 不提升未声明的传递依赖——届时失败的不是回落，而是**整个插件加载
    // 失败**（`index.js` 顶层 import 该模块），搜索彻底不可用，直接违背 `PIN-5`。
    const manifest = JSON.parse(await readFile(join(repoRoot, 'package.json'), 'utf8'));
    const declared = new Set([
      ...Object.keys(manifest.peerDependencies ?? {}),
      ...Object.keys(manifest.dependencies ?? {}),
    ]);

    const used = new Set();
    for (const relativePath of await pluginSources()) {
      const source = await readFile(join(repoRoot, relativePath), 'utf8');
      for (const specifier of importSpecifiers(source)) {
        if (!specifier.startsWith('@deepseek-ai/')) continue;
        // 取 `@scope/name`，丢掉任何子路径。
        used.add(specifier.split('/').slice(0, 2).join('/'));
      }
    }

    const undeclared = [...used].filter((name) => !declared.has(name)).sort();
    assert.deepEqual(undeclared, [], '这些宿主包被 import 却没在 package.json 里声明');
  });
});

describe('DOC-1：包清单完整，且发布出去的内容是完整的', () => {
  /** 读一次清单；下面每条断言都用它。 */
  async function manifest() {
    return JSON.parse(await readFile(join(repoRoot, 'package.json'), 'utf8'));
  }

  test('name / version / type / main / exports(含 ./client) / dsh 两项都在', async () => {
    const pkg = await manifest();

    assert.equal(pkg.name, 'dsh-tavily-pool');
    assert.match(pkg.version, /^\d+\.\d+\.\d+$/u, 'version 必须是可发布的三段式');
    assert.equal(pkg.type, 'module');
    assert.equal(pkg.main, 'index.js');
    assert.equal(pkg.exports['.'].default, './index.js');
    assert.equal(pkg.exports['./client'].default, './lib/client.js', './client 是宿主加载零构建卡片的那条路径');
    assert.equal(pkg.dsh.bundle.patch, './cordis.patch.yml');
    assert.equal(pkg.dsh.client.platform, 'web');
  });

  test('零运行时依赖', async () => {
    // 宿主包全走 peerDependencies，业务代码只用 node: 内置模块。声明成 dependencies 会让
    // 用户在 profile 目录里多装一份宿主包，那份副本与宿主自己的版本可能不同——而插件在
    // 运行期经 `ctx` 拿到的永远是宿主那一份，于是两份会悄悄分叉。
    const pkg = await manifest();
    assert.deepEqual(pkg.dependencies ?? {}, {});
  });

  test('files 白名单收全了运行期需要的每一个文件', async () => {
    // `files` 是白名单，漏一项的症状是「本地好好的，装完就 404」。这里按**运行期真的会
    // 被读到的路径**逐项核对，而不是照抄一遍清单。
    const pkg = await manifest();
    const published = new Set(pkg.files ?? []);

    for (const required of ['index.js', 'lib', 'cordis.patch.yml', 'LICENSE']) {
      assert.equal(published.has(required), true, `files 白名单缺少 ${required}`);
    }
    // `lib/client.js` 由 lib/ 整目录覆盖；这里守住的是「它确实在那个目录下」。
    assert.equal(published.has('lib'), true);

    // 中英双语文档必须成对发布：用户被告知的可选语言不该只有一半。
    for (const pair of [
      ['README.md', 'README.zh-CN.md'],
      ['docs/usage.md', 'docs/usage.zh-CN.md'],
      ['docs/dsh-upgrade.md', 'docs/dsh-upgrade.zh-CN.md'],
    ]) {
      for (const name of pair) assert.equal(published.has(name), true, `files 白名单缺少 ${name}`);
    }
  });

  test('四份面向用户的文档都写明了两条安装路径，且 pin 的是占位符而不是具体 tag', async () => {
    // 两条安装路径并存：registry 那条要有，GitHub 那条也要有。少了任何一条，读文档的人
    // 都会以为只有一种装法——而 GitHub 那条恰恰是包还没发布、或用户不想注册 registry
    // 账号时唯一能走的路。
    for (const name of ['README.md', 'README.zh-CN.md', 'docs/usage.md', 'docs/usage.zh-CN.md']) {
      const text = await readFile(join(repoRoot, name), 'utf8');

      assert.match(
        text,
        /dsh plugin add dsh-tavily-pool\b/u,
        `${name} 缺少 registry 安装路径`,
      );
      assert.match(
        text,
        /dsh plugin add github:stormbuf\/dsh-tavily-pool/u,
        `${name} 缺少 GitHub 安装路径`,
      );
      // pin 语法仍然要教：`#vX.Y.Z` 这个占位符说明「可以钉版本」，并把人引到 tags 页。
      assert.match(
        text,
        /dsh plugin add github:stormbuf\/dsh-tavily-pool#vX\.Y\.Z/u,
        `${name} 缺少 pin 语法的占位符示例`,
      );
      assert.match(
        text,
        /github\.com\/stormbuf\/dsh-tavily-pool\/tags/u,
        `${name} 没有指向 tags 页——占位符必须配一个「去哪儿挑版本」的落点`,
      );
      // **不许出现具体 tag。** 这条取代了先前「文档 tag 必须等于当前 version」的守卫：
      // 那种写法把「上一次发版时的版本号」写进了文档，而它看起来永远是对的，只是指向一个
      // 更旧的提交；每次发版还要同步改四处。占位符没有这个漂移面。
      //
      // 匹配 `#v` 后跟数字：真正的 semver tag 一定长这样，而占位符 `#vX.Y.Z` 不会命中。
      assert.doesNotMatch(
        text,
        /dsh-tavily-pool#v\d/u,
        `${name} 里出现了具体的版本 tag——它会随发版静默过期，请用 #vX.Y.Z 占位符`,
      );
    }
  });
});

describe('DOC-5：四份用户文档里的两处事实不许再漂移', () => {
  /** 四份面向用户的文档；中英成对，因此每条断言都要在四处成立。 */
  const USER_DOCS = ['README.md', 'README.zh-CN.md', 'docs/usage.md', 'docs/usage.zh-CN.md'];

  test('余额上限的两级回退都写出来了，且没有「limit 为 null 即无限」的旧说法', async () => {
    // 这两条压的是同一类真实漂移：`key.limit === null` 曾被当成「无限额度」，而免费账号的
    // `key.limit` 恰好也是 `null`（ticket 20 修掉的误读）。README 在中英两版里都留着旧写法，
    // 而 docs/usage 早就写对了——单侧漂移没有任何守卫盯着，于是它一直留到 2026-09-21。
    for (const name of USER_DOCS) {
      const text = await readFile(join(repoRoot, name), 'utf8');
      assert.match(text, /plan_limit/u, `${name} 必须写出账号级回退 account.plan_limit`);
      // 判据要宽到认得出实际出现过的写法。真实漂移有两种排版：`` `limit` 为 `null` → 无限 ``
      // 与 `` `limit === null` → unlimited first ``——反引号的位置不同，因此不能把
      // 「反引号包住整个表达式」当成前提（第一版守卫正是这么写，于是对第二种写法失效）。
      assert.doesNotMatch(
        text,
        /limit[`\s]*(?:为|===|==|is)[`\s]*null[`\s]*(?:→|->|即|means)[^\n]{0,24}(?:无限|unlimited)/iu,
        `${name} 又把 key.limit === null 写成无限了——那是 ticket 20 修掉的误读`,
      );
    }
  });

  test('展示口径如实：说明余额含本地前推，而不是声称纯官方', async () => {
    // ADR-0004 的「估算从不展示」与实现不符：前推改写的正是卡片显示的那份缓存。四份文档
    // 先前都写着「两个数字都来自官方」，那会让用户以为屏幕上的数字没有本地成分。
    //
    // 判据是一张**已知错误写法**的清单，而不是「必须出现某句话」：后者会随文案改动产生
    // 假警报（本仓库在 `test/client-card.test.js` 里已经踩过这个坑）。这些短语都是历史上
    // 真的写进过文档的，因此它们回归时这条会红。
    const PURE_OFFICIAL_CLAIMS = [
      /两个数字都来自官方/u,
      /both official numbers/u,
      /不经过任何本地估算/u,
      /不影响余额显示/u,
      /never affects the displayed balance/u,
      /No local estimate is involved/u,
      /always comes from the official reading/u,
      /数字始终来自官方/u,
    ];

    for (const name of USER_DOCS) {
      const text = await readFile(join(repoRoot, name), 'utf8');
      for (const claim of PURE_OFFICIAL_CLAIMS) {
        assert.doesNotMatch(text, claim, `${name} 又声称展示的数字不含本地估算了（命中 ${String(claim)}）`);
      }
    }
  });

  test('条件式刷新的两条边界都写出来了（1 小时阈值 + 闲置零调用）', async () => {
    // `USAGE-8` 的全部价值就在这两条边界上：阈值决定它多新鲜，而「闲置零调用」是用户
    // 明确要求的约束。文档少写任何一条，读的人都会以为它是个后台定时任务。
    for (const name of USER_DOCS) {
      const text = await readFile(join(repoRoot, name), 'utf8');
      assert.match(
        text,
        /(?:1 小时|an hour|one hour)/u,
        `${name} 没写出读数超龄的 1 小时阈值`,
      );
      assert.match(
        text,
        /(?:闲置|后台任务|in the background|background task|No search or fetch|不搜索)/u,
        `${name} 没写出「闲置时零调用」这条边界`,
      );
    }
  });
});

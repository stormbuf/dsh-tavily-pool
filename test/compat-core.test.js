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
});

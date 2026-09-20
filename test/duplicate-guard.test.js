/**
 * 重复定义守卫**自己**的守卫（ticket `22` 的 `client-artifact-4`）。
 *
 * `scripts/check-duplicate-members.mjs` 是仓库唯一的「同一作用域里定义了两次」检查，而它此前
 * 只认类成员与**顶格**函数。`lib/client.js` 是零构建产物、100% 的函数都在工厂体里，于是那道
 * 守卫对它收集到 **0 个名字**：工厂体里复制一份同名函数，守卫退出 0、`node --check` 通过、
 * 后定义静默生效，而 555 条用例只覆盖生效的那一份。仓库里唯一没有别的静态检查机会的那个文件，
 * 恰好是守卫覆盖不到的那个——这正是本文件存在的理由。
 *
 * 判据只能靠人造输入：在真实文件里制造重复会污染仓库，而「守卫看得到工厂体里的函数」这件事
 * 与文件内容无关，只与扫描规则有关。
 */

import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test, { describe } from 'node:test';
import { fileURLToPath } from 'node:url';

import { checkFiles, collect, describeProblem } from '../scripts/check-duplicate-members.mjs';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');

/**
 * 把一段源码写进临时文件并跑一遍守卫。
 *
 * @param source - 文件内容。
 * @returns 守卫报出的问题列表。
 */
async function problemsOf(source) {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-tavily-pool-dup-guard-'));
  const file = join(dir, 'fixture.mjs');
  await writeFile(file, source, 'utf8');
  return checkFiles([file]);
}

/**
 * `npm test` 交给守卫的文件清单。
 *
 * 它是这份测试自己的第二个判据：清单漏掉一个源文件，那个文件就完全不受重复定义检查——而
 * `scripts/` 此前正是漏掉的那一个（守卫脚本自己不在清单里，于是「守卫脚本里复制了一份函数」
 * 这件事没有任何检查）。
 */
const GUARDED_FILES = ['index.js', 'lib/*.js', 'lib/dsh/*.js', 'scripts/*.mjs'];

describe('22 A4：重复定义守卫看得见工厂体里的函数', () => {
  test('类成员重复仍然报得出来（脚本最初的理由）', async () => {
    const problems = await problemsOf([
      'export class A {',
      '  update() { return 1; }',
      '  update() { return 2; }',
      '}',
      '',
    ].join('\n'));

    assert.equal(problems.length, 1);
    assert.equal(problems[0].name, 'update');
    assert.equal(problems[0].scope, 'A@2', '作用域里带上缩进层级');
  });

  test('顶层函数重复仍然报得出来', async () => {
    const problems = await problemsOf('function top() {}\nfunction top() {}\n');

    assert.equal(problems.length, 1);
    assert.deepEqual(problems[0].lines, [1, 2]);
  });

  test('工厂体里复制一份同名函数必须报出来——缺陷版本对它收集到 0 个名字', async () => {
    // 形状照抄 `lib/client.js`：整份产物是一个 `window.__ModuleLoader__.load({ factory })`
    // 调用，工厂是**箭头函数**（因此工厂体本身不构成一个函数作用域），所有函数都在工厂体或
    // 组件体内，缩进 4 格。
    const problems = await problemsOf([
      'window.__ModuleLoader__.load({',
      '  id: "fixture",',
      '  factory: (require) => {',
      '    function keyRow(handlers) { return handlers; }',
      '    function applyCard(ctx) {',
      '      async function load() { return 1; }',
      '      async function load() { return 2; }',
      '      return load;',
      '    }',
      '    function keyRow(handlers) { return "STALE-COPY"; }',
      '    return { apply: applyCard };',
      '  },',
      '});',
      '',
    ].join('\n'));

    assert.equal(problems.length, 2, '工厂体与组件体里的重复定义都必须被抓到');
    const keyRow = problems.find((problem) => problem.name === 'keyRow');
    assert.deepEqual(keyRow.lines, [4, 10]);
    // 工厂是**箭头函数**，它不构成具名作用域，因此工厂体里的函数归模块级；缩进那一维
    // 把「同深度同名」的判据钉住，见 `scripts/check-duplicate-members.mjs` 的注释。
    assert.equal(keyRow.scope, '<module>@4');
    const load = problems.find((problem) => problem.name === 'load');
    assert.deepEqual(load.lines, [6, 7]);
    assert.equal(load.scope, 'applyCard@6', '组件体内的函数归到该组件名下');
    assert.match(describeProblem(load), /作用域 applyCard@6/u);
  });

  test('组件体内的函数归到该组件名下，而不是与工厂体的同名函数混为一谈', async () => {
    // 两种作用域各有一次 `load`：它们是两个合法且互不干扰的闭包，不该报重复。这一条钉住的
    // 是判据的**窄**——放宽到「整个文件里同名就算重复」会立刻在这里误报。
    const problems = await problemsOf([
      'function card() {',
      '  async function load() { return 1; }',
      '  return load;',
      '}',
      'function shell() {',
      '  async function load() { return 2; }',
      '  return load;',
      '}',
      '',
    ].join('\n'));

    assert.deepEqual(problems, []);
  });

  test('两个组件里的同名函数不互相误报——判据带缩进维度', async () => {
    // 这条钉的是判据的**窄**。本脚本按行扫描、认不出箭头函数体，因此 `lib/client.js` 的工厂体
    // 里的函数全都归 `<module>`；少了缩进那一维，「两个组件各有一个 `load`」就会变成一条误报。
    const problems = await problemsOf([
      'function card() {',
      '  async function load() { return 1; }',
      '  return load;',
      '}',
      'function shell() {',
      '  async function load() { return 2; }',
      '  return load;',
      '}',
      '',
    ].join('\n'));

    assert.deepEqual(problems, []);
  });

  test('同一作用域、同一缩进里的嵌套同名仍然报得出来', async () => {
    const problems = await problemsOf([
      'function outer() {',
      '  function inner() {}',
      '  function inner() {}',
      '  return inner;',
      '}',
      '',
    ].join('\n'));

    assert.equal(problems.length, 1);
    assert.equal(problems[0].scope, 'outer@2');
  });

  test('守卫覆盖到 scripts/ 与 lib/dsh/，而不只是 lib/', () => {
    const covered = GUARDED_FILES.join(' ');
    for (const pattern of ['index.js', 'lib/*.js', 'lib/dsh/*.js', 'scripts/*.mjs']) {
      assert.equal(covered.includes(pattern), true, `${pattern} 必须仍在守卫的文件清单里`);
    }
  });

  test('守卫脚本自己也干净（它此前不在清单里）', () => {
    assert.deepEqual(checkFiles([join(repoRoot, 'scripts/check-duplicate-members.mjs')]), []);
  });

  test('真实文件：收集到的名字数不为零，且整套源码干净', async () => {
    // 这一条是缺陷的直接判据：缺陷版本对 `lib/client.js` 收集到 **0 个名字**，于是一份
    // 完全重复的产物在它眼里也是干净的。收集数不为零才说明扫描真的看到了那些函数。
    const source = await readFile(join(repoRoot, 'lib/client.js'), 'utf8');
    const collected = [...collect(source).values()].filter((lines) => lines.length >= 1);

    assert.ok(collected.length > 30, `lib/client.js 里该收集到几十个名字，实际 ${String(collected.length)}`);
    assert.deepEqual(
      checkFiles([join(repoRoot, 'lib/client.js')]),
      [],
      '真实产物本身必须是干净的',
    );
  });
});

/**
 * 与宿主零耦合的内核，从外部做检查（`COMPAT-1`）。
 *
 * 这些模块是升级时**绝不该**需要改动的部分，因此最要紧的测试是那条结构性断言：
 * 它们必须能在完全看不到 harness 的情况下导入与测试。
 *
 * 下面的清单是 COMPAT-1 点名的五个模块中**已实现**的子集。`lib/scheduler.js`、
 * `lib/health.js`、`lib/usage.js` 尚不存在——它们随调度、失败分类、余额刷新三项
 * 工作落地——并且必须在创建它们的同一个提交里加进这里，这条规则才会持续被机械
 * 执行，而不是靠人记得。
 */

import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import test, { describe } from 'node:test';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');

/**
 * 兼容性契约禁止其了解宿主的模块。
 *
 * 每当新建一个逻辑内核模块，就往这里加一条。
 */
const HOST_FREE_MODULES = [
  'lib/tavily.js',
  'lib/pool.js',
];

/** COMPAT-1 点名的完整集合，使缺口显而易见而不是靠推断。 */
const CONTRACTED_MODULES = [
  ...HOST_FREE_MODULES,
  'lib/scheduler.js',
  'lib/health.js',
  'lib/usage.js',
];

describe('COMPAT-1：逻辑内核不依赖宿主', () => {
  for (const relativePath of HOST_FREE_MODULES) {
    test(`${relativePath} 不 import 任何 @deepseek-ai/* 包`, async () => {
      const source = await readFile(join(repoRoot, relativePath), 'utf8');
      const imports = [...source.matchAll(/^\s*(?:import|export)[^'"]*from\s+['"]([^'"]+)['"]/gmu)]
        .map((match) => match[1]);
      const hostImports = imports.filter((specifier) => specifier.startsWith('@deepseek-ai/'));
      assert.deepEqual(hostImports, [], `${relativePath} 不得 import 宿主包`);
    });

    test(`${relativePath} 无需 harness 即可导入并工作`, async () => {
      const module = await import(`../${relativePath}`);
      assert.ok(Object.keys(module).length > 0, `${relativePath} 应当有导出`);
    });
  }

  test('契约点名的每个模块要么已被覆盖，要么尚未写出', () => {
    // 一条以可执行形式存在的提醒：这些模块之一落地时，正是该断言会告诉下一个人
    // 把它加到上面去。
    const missing = CONTRACTED_MODULES.filter((relativePath) => !HOST_FREE_MODULES.includes(relativePath));
    assert.deepEqual(
      missing,
      ['lib/scheduler.js', 'lib/health.js', 'lib/usage.js'],
      '契约模块有增删——请同步更新 HOST_FREE_MODULES',
    );
  });
});

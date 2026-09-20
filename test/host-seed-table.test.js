/**
 * 种子模块表与宿主产物对账（ticket `22` 的 `host-contract-4`）。
 *
 * `lib/client.js` 是零构建产物，它只能 `require` 宿主浏览器半边那张**冻结的种子模块表**
 * （`dsh-web-frontend` 的 `PLATFORM_MODULES`）。表的键少一个、改个名，`dsh-client-modules`
 * 的 `makeRequire` 未命中即抛，工厂在 `require` 阶段中断——**整张设置卡片不渲染**。
 *
 * 这条判据此前是手抄的：`test/client-card.test.js` 里钉着一份 9 键副本，只判「我们没点表外的
 * 键」。宿主换表时它照样全绿（实测：删掉 `react-dom`、或新增一批
 * `@deepseek-ai/dsh-client-ui-*`，`npm test` 都不动），因此那份副本的注释承诺的「宿主换了种子表
 * 这条会红」并没有兑现。这里改成从宿主自己的产物里机械解析——表是宿主的事实，不该由我们抄。
 *
 * 解析方式：宿主把整张表写成一个对象字面量（`return{react:ec,"react/jsx-runtime":ic,…}`），
 * 因此取「最后一个 `return{` 到它配平的 `}`」再逐个取键即可。字符串键与标识符键都要认。
 */

import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import test, { describe } from 'node:test';

import { resolveHostRoot } from './host-install.mjs';

/** 客户端产物所在目录（相对宿主安装根）。 */
const FRONTEND_ASSETS = join('@deepseek-ai', 'dsh-web-frontend', 'dist', 'assets');

/** 与 `test/client-card.test.js` 逐字相同的那三个 specifier——卡片真正 require 的东西。 */
const REQUIRED_BY_CARD = [
  'react',
  'react-dom',
  '@deepseek-ai/dsh-client-ui-primitives',
];

/**
 * 找到宿主前端的主产物。
 *
 * 文件名带内容哈希（`index-<hash>.js`），因此按前缀找而不是钉死一个名字——钉死它等于把
 * 「宿主换了一次构建」也变成一次守卫失败，而那条失败与种子表毫无关系。
 *
 * @returns 产物文件的绝对路径。
 * @throws {Error} 产物不存在或不是一个文件时抛出。
 */
function frontendBundle() {
  const assets = join(resolveHostRoot({
    markers: [join('@deepseek-ai', 'dsh-web-frontend', 'package.json')],
    what: 'the seed-module guard',
  }), FRONTEND_ASSETS);
  const found = readdirSync(assets).filter((name) => name.startsWith('index-') && name.endsWith('.js'));
  assert.ok(found.length > 0, `${assets} 里找不到 index-*.js`);
  return join(assets, found[0]);
}

/**
 * 从产物里抠出种子模块表的键。
 *
 * 判据是「最后一段 `return{…}`」：vite 把这张表的字面量放在模块尾部，而它前面还有别的对象
 * 字面量。取最后一个是为了不误捞前面那些；配平用花括号计数，因此嵌套对象不会截断它。
 *
 * @param source - 产物内容。
 * @returns 键名数组，按产物里的顺序。
 * @throws {Error} 找不到表时抛出（形状变了，需要重适配而不是静默跳过）。
 */
function platformModules(source) {
  const at = source.lastIndexOf('return{');
  assert.notEqual(at, -1, '产物里找不到 `return{`：种子表的形状变了，见 docs/dsh-upgrade.md 第 9 节');
  const start = source.indexOf('{', at);
  let depth = 0;
  let end = -1;
  for (let index = start; index < source.length; index += 1) {
    const char = source[index];
    if (char === '{') depth += 1;
    else if (char === '}') {
      depth -= 1;
      if (depth === 0) {
        end = index;
        break;
      }
    }
  }
  assert.notEqual(end, -1, '种子表的对象字面量没有配平');

  const body = source.slice(start + 1, end);
  const keys = [];
  // 逐字符扫顶层键：字符串键（单/双引号）与标识符键、以及 `key:value` 的冒号。
  let index = 0;
  let nest = 0;
  let quote = null;
  let token = '';
  const flush = () => {
    const trimmed = token.trim();
    if (trimmed.length > 0) keys.push(trimmed);
    token = '';
  };
  while (index < body.length) {
    const char = body[index];
    if (quote !== null) {
      token += char;
      if (char === quote && body[index - 1] !== '\\') quote = null;
      index += 1;
      continue;
    }
    if (char === '"' || char === "'" || char === '`') {
      quote = char;
      token += char;
      index += 1;
      continue;
    }
    if (char === '{' || char === '[' || char === '(') nest += 1;
    else if (char === '}' || char === ']' || char === ')') nest -= 1;
    else if (char === ',' && nest === 0) {
      flush();
      index += 1;
      continue;
    }
    token += char;
    index += 1;
  }
  flush();

  return keys.map((entry) => {
    const colon = entry.indexOf(':');
    assert.notEqual(colon, -1, `种子表的项 ${JSON.stringify(entry)} 没有键值分隔`);
    const raw = entry.slice(0, colon).trim();
    return raw.startsWith('"') || raw.startsWith("'") || raw.startsWith('`') ? raw.slice(1, -1) : raw;
  });
}

describe('22 A5：种子模块表与宿主产物对账', () => {
  test('宿主产物里真的解析得到那张表，且含卡片 require 的三个键', () => {
    const keys = platformModules(readFileSync(frontendBundle(), 'utf8'));

    assert.ok(keys.length > 0, '解析出来的表不该是空的');
    // 表是**宿主的事实**，因此这条断言失败意味着卡片会在 require 阶段整张不渲染。
    for (const specifier of REQUIRED_BY_CARD) {
      assert.equal(keys.includes(specifier), true, `宿主种子表里没有 ${specifier}——卡片会整张不渲染`);
    }
  });

  test('解析器认得两种键写法，且能配平嵌套对象', () => {
    // 判据本身要能反向验证：写死一个形状对不上真实产物的解析器，只会在真机上才暴露。
    const source = 'x();return{react:ec,"react/jsx-runtime":ic,nested:{deep:1},tail:9};';
    assert.deepEqual(platformModules(source), ['react', 'react/jsx-runtime', 'nested', 'tail']);
  });

  test('test/client-card.test.js 钉住的那份副本与宿主产物逐键一致', () => {
    // 手抄副本可以留着（它让「我们没点表外的键」这条断言不必读宿主），但它必须与真值一致。
    // 这条对账就是那份副本的注释所承诺的「宿主换了种子表，这条会红」。
    const source = readFileSync(new URL('./client-card.test.js', import.meta.url), 'utf8');
    const block = /const SEED_MODULES = Object\.freeze\(\[([\s\S]*?)\]\);/u.exec(source);
    assert.notEqual(block, null, '找不到 client-card.test.js 里的 SEED_MODULES');

    const pinned = [...block[1].matchAll(/'([^']+)'/gu)].map((match) => match[1]);
    const actual = platformModules(readFileSync(frontendBundle(), 'utf8'));

    assert.deepEqual([...pinned].sort(), [...actual].sort(), '手抄副本与宿主产物已经对不上了');
  });
});

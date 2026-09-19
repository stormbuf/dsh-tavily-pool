/**
 * 拦截同一文件里重复定义的类成员与顶层函数。
 *
 * **开发期工具，不随包发布**（`package.json` 的 `files` 白名单不含 `scripts/`）。
 *
 * 为什么需要它：`class A { m() {...} m() {...} }` 在 JavaScript 里是**合法**的，后者
 * 静默覆盖前者——`node --check` 通过，测试也可能全绿，而两处 JSDoc 会互相矛盾。本仓库
 * 真的踩过一次：`lib/pool.js` 曾有两个 `async update`，一个等落盘后改内存、一个同步改，
 * 生效的是后者，注释却两套都在，排查花了很久。
 *
 * 判据刻意窄：只找「同一个类体内同名成员出现两次」与「同名顶层函数出现两次」。两者都
 * 能靠词法扫描确定地判出来，不引入误报，也不需要解析器。
 *
 * 用法：node scripts/check-duplicate-members.mjs <文件…>
 * 有重复时以非零码退出。
 *
 * @module dsh-tavily-pool/scripts/check-duplicate-members
 */

import { readFileSync } from 'node:fs';

/**
 * 逐行扫描，收集每个作用域里定义的名字及其行号。
 *
 * 类的边界由**花括号配平**判定，而不是「遇到 `}` 就出栈」：单行成员（`m() { return 1; }`）
 * 在同一行里既开又合，按后者判定会把类提前弹掉，后面所有成员都被算到模块作用域里——
 * 那样这个脚本就永远报不出重复。
 *
 * @param source - 文件内容。
 * @returns `Map<作用域名::成员名, 行号[]>`。
 */
function collect(source) {
  const found = new Map();
  const classStack = [];
  let braceDepth = 0;

  const record = (scope, name, line) => {
    const key = `${scope}::${name}`;
    if (!found.has(key)) found.set(key, []);
    found.get(key).push(line);
  };

  const count = (text) => ({
    open: (text.match(/\{/gu) ?? []).length,
    close: (text.match(/\}/gu) ?? []).length,
  });

  for (const [index, raw] of source.split('\n').entries()) {
    const lineNumber = index + 1;
    // 去掉行注释，避免注释里的花括号干扰配平。
    const line = raw.replace(/\/\/.*$/u, '');
    const braces = count(line);

    const classMatch = /^\s*(?:export\s+)?class\s+([A-Za-z_$][\w$]*)/u.exec(line);
    if (classMatch !== null) {
      braceDepth += braces.open - braces.close;
      classStack.push({ name: classMatch[1], closesAt: braceDepth });
      continue;
    }

    braceDepth += braces.open - braces.close;
    while (classStack.length > 0 && braceDepth < classStack[classStack.length - 1].closesAt) {
      classStack.pop();
    }

    const scope = classStack.length > 0 ? classStack[classStack.length - 1].name : undefined;

    // 类成员：两空格起缩进，形如 `name(` / `async name(` / `get name(` / `#name(`。
    const member = /^\s{2}(?:static\s+)?(?:async\s+)?(?:get\s+|set\s+)?(#?[A-Za-z_$][\w$]*)\s*\(/u.exec(raw);
    if (member !== null && scope !== undefined) {
      record(scope, member[1], lineNumber);
      continue;
    }

    // 顶层函数：顶格，可带 `export` / `async`。
    const topLevel = /^(?:export\s+)?(?:async\s+)?function\s+([A-Za-z_$][\w$]*)/u.exec(raw);
    if (topLevel !== null) record('<module>', topLevel[1], lineNumber);
  }

  return found;
}

let failed = false;
for (const file of process.argv.slice(2)) {
  for (const [key, occurrences] of collect(readFileSync(file, 'utf8'))) {
    if (occurrences.length < 2) continue;
    failed = true;
    const [scope, name] = key.split('::');
    const where = scope === '<module>' ? '顶层' : `类 ${scope}`;
    process.stderr.write(
      `${file}: ${where}重复定义了 ${name}（第 ${occurrences.join('、')} 行）——`
      + '后者会静默覆盖前者，请删掉一处\n',
    );
  }
}

if (failed) process.exit(1);

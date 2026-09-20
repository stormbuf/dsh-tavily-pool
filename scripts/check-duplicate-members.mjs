/**
 * 拦截同一作用域里重复定义的类成员与函数。
 *
 * **开发期工具，不随包发布**（`package.json` 的 `files` 白名单不含 `scripts/`）。
 *
 * 为什么需要它：`class A { m() {...} m() {...} }` 与同一作用域里写两遍
 * `function f() {...}` 在 JavaScript 里都是**合法**的，后者静默覆盖前者——`node --check`
 * 通过，测试也可能全绿，而两处 JSDoc 会互相矛盾。本仓库真的踩过两次：
 *
 * - `lib/pool.js` 曾有两个 `async update`，一个等落盘后改内存、一个同步改，生效的是后者；
 * - `lib/client.js` 是零构建产物、**100% 的函数都在工厂体里**，而本脚本此前只认类成员与
 *   顶格函数，对它收集到 **0 个名字**（ticket `22` 的 `client-artifact-4`）——也就是说
 *   仓库里唯一没有别的静态检查机会的那个文件，恰好是这道守卫覆盖不到的那个。
 *
 * 判据刻意窄：只找「同一个作用域、同一缩进层级里，同名定义出现两次」。作用域由**包裹它的
 * 那个声明**确定，嵌套深度由缩进确定，因此：
 *
 * - 顶格函数归 `<module>`；
 * - 类成员归它所在的类；
 * - 工厂体（或任何函数体）里的函数归**包裹它的那个函数**，同名同类不同缩进的闭包互不干扰。
 *
 * 两处已知的**有意**局限，写在这里免得被当成承诺：
 *
 * - 箭头函数体（`factory: (require) => {`）不构成具名作用域，因此工厂体里的函数归 `<module>`；
 *   缩进那一维把它的后果限制在「同深度同名」上；
 * - 多行签名的函数（`function f(\n a,\n) {`）在扫描器眼里与同级的下一个声明同深，其体内函数
 *   的作用域名会退化一级。判据因此偏**窄**——它可能漏报，不会把不同作用域的同名混报。
 *
 * 用法：node scripts/check-duplicate-members.mjs <文件…>
 * 有重复时以非零码退出。
 *
 * @module dsh-tavily-pool/scripts/check-duplicate-members
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

/**
 * 逐行扫描，收集每个作用域里定义的名字及其行号。
 *
 * 类的边界由**花括号配平**判定，而不是「遇到 `}` 就出栈」：单行成员（`m() { return 1; }`）
 * 在同一行里既开又合，按后者判定会把类提前弹掉，后面所有成员都被算到模块作用域里——
 * 那样这个脚本就永远报不出重复。
 *
 * 函数的边界用**同一套**配平判定，于是工厂体里的函数与包裹它的函数各成一个作用域：
 * `function a() { function b() {} function b() {} }` 报的是 `a` 里的重复，而不是模块级。
 *
 * @param source - 文件内容。
 * @returns `Map<作用域名::成员名, 行号[]>`。
 */
export function collect(source) {
  const found = new Map();
  /** 闭合于该花括号深度的类；`members` 是它的成员表。 */
  const classStack = [];
  /**
   * 函数作用域栈，每项 `{ path, indent, depth, opened }`。
   *
   * `indent` 是声明所在行的缩进：同一缩进的**下一个**声明是兄弟而不是子节点，因此它出现的
   * 那一刻就把它上面那层弹掉（同级函数各自成域；`function a() {}` 与 `function b() {}` 里各
   * 有一个 `load` 是两件互不相干的事）。
   *
   * `depth` 是该函数**体**的闭合花括号深度，`opened` 表示那个 `{` 已经出现过。两者缺一不可：
   * 单行函数（`function f() {}`）与多行签名（`function f(\n  a,\n) {`）的 `{`/`}` 都不在声明
   * 那一行上，光看深度会把这两种形状算错。
   */
  const functionStack = [];
  let braceDepth = 0;

  /**
   * 记下一个定义。**键里带缩进层级**：判定是「同一作用域、同一嵌套深度、同名定义出现两次」。
   *
   * 缩进这一维是必需的而不是保守起见：本脚本按行扫描，认不出箭头函数体
   * （`factory: (require) => {` 不构成一个具名函数作用域），因此两个不同组件里的同名函数
   * （`load` / `save` 这类）会落进同一个作用域名下。带上缩进之后，「不同深度的同名」不再
   * 互相误报——判据更窄，而它盯的那类缺陷（同一处粘贴了两遍）总是同缩进的。
   */
  const record = (scope, indent, name, line) => {
    const key = `${scope}@${String(indent)}::${name}`;
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
    const indent = raw.length - raw.trimStart().length;

    const classMatch = /^\s*(?:export\s+)?class\s+([A-Za-z_$][\w$]*)/u.exec(line);
    if (classMatch !== null) {
      braceDepth += braces.open - braces.close;
      classStack.push({ name: classMatch[1], closesAt: braceDepth });
      continue;
    }

    // 同级或更浅的声明出现时，先把上面那些函数弹掉。
    while (functionStack.length > 0 && functionStack[functionStack.length - 1].indent >= indent) {
      functionStack.pop();
    }

    braceDepth += braces.open - braces.close;
    while (classStack.length > 0 && braceDepth < classStack[classStack.length - 1].closesAt) {
      classStack.pop();
    }
    while (functionStack.length > 0) {
      const innermost = functionStack[functionStack.length - 1];
      if (!innermost.opened) {
        if (braces.open > 0) innermost.opened = true;
        else if (braces.close === 0) break;
      }
      if (braceDepth >= innermost.depth) break;
      functionStack.pop();
    }

    const scope = classStack.length > 0
      ? classStack[classStack.length - 1].name
      : functionStack.length > 0
        ? functionStack[functionStack.length - 1].path
        : '<module>';

    // 类成员：两空格起缩进，形如 `name(` / `async name(` / `get name(` / `#name(`。
    const member = /^\s{2}(?:static\s+)?(?:async\s+)?(?:get\s+|set\s+)?(#?[A-Za-z_$][\w$]*)\s*\(/u.exec(raw);
    if (member !== null && classStack.length > 0) {
      record(scope, indent, member[1], lineNumber);
      continue;
    }

    // 函数声明：顶格（模块级）或缩进在函数体内（工厂体、闭包）。
    //
    // `function\s+` 里的空白是**必需**的，不能写成 `function\s*`：后者会把
    // `const functionStack = [];` 里的标识符前缀当成一个名叫 `Stack` 的函数声明。
    const declaration = /^(\s*)(?:export\s+)?(?:async\s+)?function\s+(?:\*\s*)?([A-Za-z_$][\w$]*)/u.exec(raw);
    if (declaration !== null) {
      const enclosing = functionStack.length > 0 ? functionStack[functionStack.length - 1].path : undefined;
      record(scope, indent, declaration[2], lineNumber);
      functionStack.push({
        path: enclosing === undefined ? declaration[2] : `${enclosing}.${declaration[2]}`,
        indent,
        depth: braces.open > 0 ? braceDepth : undefined,
        opened: braces.open > 0,
      });
    }
  }

  return found;
}

/**
 * 扫一批文件，把「同一作用域里同名定义出现两次」逐条报出来。
 *
 * 与 CLI 分开，是为了让守卫本身可被测试：解析规则是这个脚本的**全部**价值所在，而此前它
 * 只能靠「跑一遍看退出码」来验证——那正是它会对 `lib/client.js` 静默返回 0 个名字却仍然
 * 退出 0 的原因（ticket `22` 的 `client-artifact-4`）。
 *
 * @param files - 要检查的文件路径。
 * @returns 每条重复一份 `{ file, scope, name, lines }`；干净时返回空数组。
 */
export function checkFiles(files) {
  const problems = [];
  for (const file of files) {
    for (const [key, occurrences] of collect(readFileSync(file, 'utf8'))) {
      if (occurrences.length < 2) continue;
      const [scope, name] = key.split('::');
      problems.push({ file, scope, name, lines: occurrences });
    }
  }
  return problems;
}

/** 人类可读的一行诊断。 */
export function describeProblem({ file, scope, name, lines }) {
  const where = scope === '<module>' ? '顶层' : `作用域 ${scope}`;
  return `${file}: ${where}重复定义了 ${name}（第 ${lines.join('、')} 行）——`
    + '后者会静默覆盖前者，请删掉一处';
}

if (process.argv[1] !== undefined && fileURLToPath(import.meta.url) === process.argv[1]) {
  const problems = checkFiles(process.argv.slice(2));
  for (const problem of problems) process.stderr.write(`${describeProblem(problem)}\n`);
  if (problems.length > 0) process.exitCode = 1;
}

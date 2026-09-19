/**
 * 从 JavaScript 源文件中剥离注释，用于验证「只改注释、不动代码」。
 *
 * **开发期工具，不随包发布**（`package.json` 的 `files` 白名单不含 `scripts/`）。
 * 它的用途是在批量改注释（例如把注释整体译为另一种语言）之后，证明代码本身一字
 * 未动：剥离注释后比对哈希，哈希一致即说明改动只落在注释里。
 *
 * 这不是一个通用解析器，而是一个针对本仓库代码风格的词法扫描器：它按状态机逐字符
 * 推进，正确跳过字符串、模板字符串与正则字面量内部的 `//` 与 `/*`，因此不会把
 * `'https://…'` 或 `/^a\/b/` 误判成注释起点。
 *
 * 用法：
 *   node scripts/strip-comments.mjs <文件…>        # 打印剥离后的代码
 *   node scripts/strip-comments.mjs --hash <文件…> # 打印每个文件的 sha256
 *
 * @module dsh-tavily-pool/scripts/strip-comments
 */

import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';

/** 判断某个 `/` 是否可能是正则字面量的起点（依据前一个有效字符）。 */
function regexCanFollow(previous) {
  if (previous === undefined) return true;
  return '([{,;:=!&|?+-*%~^<>'.includes(previous);
}

/**
 * 剥离注释，保留所有代码字符与换行。
 *
 * @param source - 源文件内容。
 * @returns 去掉注释后的代码，行数与原文一致（注释内容置空，换行保留）。
 */
export function stripComments(source) {
  const out = [];
  let index = 0;
  /** 前一个已输出的非空白、非注释字符，用于判断 `/` 的语义。 */
  let previous;

  while (index < source.length) {
    const char = source[index];
    const next = source[index + 1];

    // 行注释：整行内容丢弃，换行保留，避免行号漂移。
    if (char === '/' && next === '/') {
      while (index < source.length && source[index] !== '\n') index += 1;
      continue;
    }

    // 块注释：内容丢弃，其中的换行原样保留。
    if (char === '/' && next === '*') {
      index += 2;
      while (index < source.length && !(source[index] === '*' && source[index + 1] === '/')) {
        if (source[index] === '\n') out.push('\n');
        index += 1;
      }
      index += 2;
      continue;
    }

    // 字符串与模板字符串：整体复制，内部的 // 与 /* 都不是注释。
    if (char === '"' || char === "'" || char === '`') {
      const quote = char;
      out.push(char);
      index += 1;
      while (index < source.length) {
        const inner = source[index];
        if (inner === '\\') {
          out.push(inner, source[index + 1] ?? '');
          index += 2;
          continue;
        }
        out.push(inner);
        index += 1;
        if (inner === quote) break;
      }
      previous = quote;
      continue;
    }

    // 正则字面量：仅在语法上可能出现正则的位置才按正则处理。
    if (char === '/' && regexCanFollow(previous)) {
      const start = index;
      let cursor = index + 1;
      let inClass = false;
      let closed = false;
      while (cursor < source.length) {
        const inner = source[cursor];
        if (inner === '\\') {
          cursor += 2;
          continue;
        }
        if (inner === '\n') break;
        if (inner === '[') inClass = true;
        else if (inner === ']') inClass = false;
        else if (inner === '/' && !inClass) {
          closed = true;
          break;
        }
        cursor += 1;
      }
      if (closed) {
        // 连正则标志一起复制。
        let end = cursor + 1;
        while (end < source.length && /[a-z]/u.test(source[end])) end += 1;
        out.push(source.slice(start, end));
        previous = source[end - 1];
        index = end;
        continue;
      }
    }

    out.push(char);
    if (!/\s/u.test(char)) previous = char;
    index += 1;
  }

  return out.join('');
}

/** 去掉每行首尾空白，使纯缩进/换行差异不影响比对。 */
function canonical(code) {
  return code
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .join('\n');
}

if (process.argv[1]?.endsWith('strip-comments.mjs')) {
  const args = process.argv.slice(2);
  const hashed = args[0] === '--hash';
  const files = hashed ? args.slice(1) : args;
  for (const file of files) {
    const code = canonical(stripComments(readFileSync(file, 'utf8')));
    if (hashed) {
      process.stdout.write(`${createHash('sha256').update(code).digest('hex')}  ${file}\n`);
    } else {
      process.stdout.write(code);
    }
  }
}

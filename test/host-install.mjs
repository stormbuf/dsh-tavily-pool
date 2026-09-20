/**
 * 定位**本机那份真实的 DSH 安装**，供需要与宿主产物对账的守卫使用。
 *
 * 为什么需要它：本包只依赖 seam 与两个提供方包，`dsh-base` / `dsh-tool-web` /
 * `dsh-web-frontend` 都**不是**它的依赖，因此静态 `import` 在本仓库里解析不到。于是「宿主
 * 到底把值绑成了多少」「宿主冻结的种子表里有哪些键」这两类问题只能在运行期按路径去读。
 *
 * 两条纪律，都来自 ticket `22` 的教训：
 *
 * 1. **解析不到就抛错，不跳过。** 静默跳过正是那一票要消灭的那类守卫——一条在 CI 里默默
 *    不跑的守卫与没有守卫，在「它有没有拦住过什么」这个问题上是同一件事。宿主不在场时设
 *    `DSH_HOST_ROOT` 指向含这些包的 `node_modules`。
 * 2. **判据取自宿主自己的产物**，不是本仓库里的第二份手抄副本（`host-contract-4`）。
 *
 * 用法：`resolveHostRoot({ markers: [...] })` 拿到根，再按包名拼路径读产物。默认标记只要
 * `dsh-base` 在场；需要更多包时显式传 `markers`。
 *
 * @module dsh-tavily-pool/test/host-install
 */

import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

const require = createRequire(import.meta.url);

/** 任何 DSH 安装根都该有的那个标记（`dsh-base` 是每个宿主组合的底座）。 */
export const DEFAULT_HOST_MARKERS = Object.freeze([join('@deepseek-ai', 'dsh-base', 'cordis.patch.yml')]);

/** `$DSH_HOME`，与 `lib/dsh/home-path.js` 同一套优先级：先环境变量，再操作系统 home。 */
export function dshHomeDir() {
  const configured = process.env.DSH_HOME?.trim();
  if (configured !== undefined && configured.length > 0) return configured;
  return join(homedir(), '.dsh');
}

/** 试解析一个包；失败的原因要报出去，不是吞掉。 */
function resolvePackage(id) {
  try {
    return { path: require.resolve(id) };
  } catch (error) {
    return { reason: `${id} does not resolve from this plugin (${error.code ?? error.message})` };
  }
}

/**
 * 从一个作用域包的 `package.json` 路径反推它所在的 `node_modules`。
 *
 * `<root>/@deepseek-ai/<name>/package.json` → `<root>`：三层，少一层会得到 `@deepseek-ai`
 * 自己，那样后面拼出来的标记路径会多出一段 `@deepseek-ai/`，于是一个本来可用的根被静默跳过。
 *
 * @param packageJsonPath - `require.resolve('<包>/package.json')` 的结果。
 * @returns `node_modules` 目录的绝对路径。
 */
export function scopedPackageRoot(packageJsonPath) {
  return dirname(dirname(dirname(packageJsonPath)));
}

/**
 * 解析宿主安装根。按顺序试，取第一个可用的：
 *
 * 1. `$DSH_HOST_ROOT`（显式指定，也是没有本地 DSH 安装时的出口）。**设了却不可用就直接抛错**，
 *    不悄悄换下一个根：那样「设错的覆盖值」会变成「守卫守的是另一台宿主」，而报告里看不出来；
 * 2. `@deepseek-ai/dsh-base/package.json` 解析后所在的 `node_modules`——插件与宿主装在同一棵树
 *    里时就是它（`dsh-base` 没有 `exports` 入口，解析 `package.json` 更稳）；
 * 3. `@deepseek-ai/dsh-web/package.json` 同法——它是本包的 peerDependency，**一定**解析得到，
 *    因此这条覆盖「同一棵树、但 `dsh-base` 恰好不在解析路径上」的安装；
 * 4. `$DSH_HOME/profiles/node_modules`——`dsh plugin add <path>` 把本插件作为 `link:` 依赖装进
 *    profile，宿主的各个 bundle 包则被提升到 profile 们共用的这个根下，插件自己的
 *    `node_modules` 里因此没有它们（本仓库的 `npm test` 走的正是这一条）。
 *
 * @param options - 覆盖项。
 * @param options.markers - 该根必须存在的标记路径（相对根）；默认只要 `dsh-base`。
 * @param options.what - 抛错消息里那句「谁需要这个根」。
 * @returns 宿主安装根的绝对路径。
 * @throws {Error} 找不到宿主安装时抛出；消息为英文，含试过的路径与 `DSH_HOST_ROOT` 的用法。
 */
export function resolveHostRoot({ markers = DEFAULT_HOST_MARKERS, what = 'this guard' } = {}) {
  const tried = [];

  /** @returns 可用的根，或 `undefined`（并把原因记进 `tried`）。 */
  const check = (root, why) => {
    const missing = markers.map((marker) => join(root, marker)).filter((path) => !existsSync(path));
    if (missing.length > 0) {
      tried.push(`  - ${root} (${why}): missing ${missing.join(', ')}`);
      return undefined;
    }
    return root;
  };

  const configured = process.env.DSH_HOST_ROOT?.trim();
  if (configured !== undefined && configured.length > 0) {
    const fromEnv = check(configured, '$DSH_HOST_ROOT');
    if (fromEnv !== undefined) return fromEnv;
    throw new Error([
      `dsh-tavily-pool: DSH_HOST_ROOT is set to ${configured}, but that is not a DSH host installation.`,
      `It must contain ${markers.join(', ')}.`,
      'Unset it to fall back to auto-discovery, or point it at the right node_modules.',
    ].join('\n'));
  }
  tried.push('  - $DSH_HOST_ROOT is not set');

  const base = resolvePackage('@deepseek-ai/dsh-base/package.json');
  if (base.path !== undefined) {
    const fromBase = check(scopedPackageRoot(base.path), '@deepseek-ai/dsh-base resolves next to this plugin');
    if (fromBase !== undefined) return fromBase;
  } else {
    tried.push(`  - ${base.reason}`);
  }

  const web = resolvePackage('@deepseek-ai/dsh-web/package.json');
  if (web.path !== undefined) {
    const fromWeb = check(scopedPackageRoot(web.path), '@deepseek-ai/dsh-web resolves next to this plugin');
    if (fromWeb !== undefined) return fromWeb;
  } else {
    tried.push(`  - ${web.reason}`);
  }

  const fromProfiles = check(join(dshHomeDir(), 'profiles', 'node_modules'), 'the shared install root of the DSH profiles');
  if (fromProfiles !== undefined) return fromProfiles;

  throw new Error([
    `dsh-tavily-pool: cannot locate the DSH host installation; ${what} has no reference value.`,
    'Tried:',
    ...tried,
    `Set DSH_HOST_ROOT to the node_modules directory holding ${markers.join(', ')}.`,
  ].join('\n'));
}

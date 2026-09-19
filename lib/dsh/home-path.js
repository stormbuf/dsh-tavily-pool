/**
 * 密钥池路径，经宿主解析。
 *
 * `DOC-4` 禁止硬编码本机路径，并要求用户级目录来自宿主自己的 home 解析器。
 * 把该解析放在这里（而不是让 `lib/pool.js` 去 import 宿主路径助手），正是
 * `lib/pool.js` 能只接收一个普通目录字符串、并在 `node:test` 下保持可测的原因。
 *
 * @module dsh-tavily-pool/dsh/home-path
 */

import { join } from 'node:path';

import { STATE_DIR_NAME } from '../constants.js';
import { readService } from './read-service.js';

/**
 * 解析存放本插件状态的目录。
 *
 * 优先使用宿主助手——经反射式读取获取，因为它是可选能力，而 context proxy 会对
 * 未注入的服务名抛出。回退分支的存在只是为了让「缺少该能力」退化为「路径权威性
 * 稍差」，而不是加载期抛错（`COMPAT-3`）；它复刻了宿主解析器文档化的优先级
 * （先 `$DSH_HOME`，再操作系统 home），因此退化路径仍落在同一个文件上，而不是
 * 另造一个新位置。
 *
 * @param ctx - 插件 context。
 * @returns 状态目录的绝对路径。
 * @throws {Error} 完全无法确定 home 时抛出。
 */
export function resolveStateDir(ctx) {
  const hostResolver = readService(ctx, 'dshHomePath');
  if (typeof hostResolver === 'function') return hostResolver(STATE_DIR_NAME);

  const configured = process.env.DSH_HOME?.trim();
  if (configured !== undefined && configured.length > 0) return join(configured, STATE_DIR_NAME);

  const osHome = process.env.HOME ?? process.env.USERPROFILE;
  if (osHome === undefined || osHome.length === 0) {
    throw new Error(
      'dsh-tavily-pool: cannot resolve the harness home; ctx.dshHomePath is unavailable '
      + 'and neither $DSH_HOME nor $HOME is set',
    );
  }
  return join(osHome, '.dsh', STATE_DIR_NAME);
}

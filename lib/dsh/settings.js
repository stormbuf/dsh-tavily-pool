/**
 * 把本插件的设置注册进宿主的 settings 服务。
 *
 * `COMPAT-1` 允许 `lib/dsh/` 写机械的转换代码，本文件正是那一层：schema 的形状、
 * 注册的调用方式、命名空间配对规则都属于宿主知识，因此 `lib/settings.js` 里只有
 * 纯数据与纯函数。
 *
 * @module dsh-tavily-pool/dsh/settings
 */

import z from '@deepseek-ai/schemastery';

import { SETTINGS_NAMESPACE } from '../constants.js';
import { readSettings, settingsSchema } from '../settings.js';
import { readService } from './read-service.js';

/**
 * 注册本插件的设置命名空间（`CFG-1`）。
 *
 * 命名空间**不可重复注册**：重复调用会抛错。因此本函数刻意不做幂等包装——把一次
 * 真实的重复注册伪装成成功，会让两处配置争夺同一个命名空间而不留痕迹。
 *
 * @param ctx - 插件 context。
 * @returns 注册结果，或 `undefined`（宿主没有 settings 服务时）。
 * @throws {Error} 宿主拒绝注册时抛出。
 */
export function registerSettings(ctx) {
  const settings = readService(ctx, 'settings');
  const register = settings?.register;
  // 缺席时直接返回而不是抛错：settings 是可选能力（见 `lib/dsh/capabilities.js`），
  // 没有它时开关退化为默认值，搜索照常可用。
  if (typeof register !== 'function') return undefined;
  return register.call(settings, SETTINGS_NAMESPACE, settingsSchema(z));
}

/**
 * 读取当前的设置值。
 *
 * @param ctx - 插件 context。
 * @returns `{ searchEnabled }`；settings 缺席时全是默认值。
 */
export function readPluginSettings(ctx) {
  return readSettings(readService(ctx, 'settings'), SETTINGS_NAMESPACE);
}

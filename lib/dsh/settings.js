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

import { PANEL_ERROR_CODES } from '../panel.js';
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

/**
 * 把面板提交的设置合并进用户层（`PANEL-4`、`CFG-3`）。
 *
 * 走的是宿主的 `update(ns, patch)`，因此校验、落盘、变更通知都由宿主完成——包括
 * `CFG-4` 的取值校验：那件事只能有一个来源，而我们注册的 schema 就是那个来源。
 * 校验失败时宿主抛出的错误**原样上抛**（形如
 * `$.maxResults expected number <= 20 but got 21`），由 `lib/panel.js` 编成 400：那条
 * 消息是用户唯一能据以改正的线索。
 *
 * settings 服务缺席时抛的是带 {@link PANEL_ERROR_CODES.UNAVAILABLE} 码的错误，让面板
 * 能把它与「取值非法」区分开——把「宿主没有这个服务」报成 400 会让用户以为是自己填错。
 *
 * @param ctx - 插件 context。
 * @param patch - 要合并进用户层的部分设置。
 * @returns 落盘完成的 promise。
 * @throws {Error} 宿主没有 settings 服务，或它拒绝这次写入时抛出。
 */
export function writePluginSettings(ctx, patch) {
  const settings = readService(ctx, 'settings');
  const update = settings?.update;
  if (typeof update !== 'function') {
    const error = new Error(
      'the host has no settings service, so panel changes cannot be stored '
      + '(ctx.settings.update is not a function)',
    );
    error.code = PANEL_ERROR_CODES.UNAVAILABLE;
    throw error;
  }
  return update.call(settings, SETTINGS_NAMESPACE, patch);
}

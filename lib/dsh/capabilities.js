/**
 * 宿主能力探测（`COMPAT-2`、`COMPAT-3`）。
 *
 * 本插件依赖的每一项宿主事实都在这里于**加载期**检查，并以「具体缺了哪一项」的
 * 形式上报，而不是等到模型调用 `web_search` 时才冒出一个失败。`docs/dsh-upgrade.md`
 * 里的重适配清单是同一思路面向人的那一半。
 *
 * 探测永不抛出，也不中断任何事。`COMPAT-3` 要求即使宿主形状已变、提供方也必须保持
 * 已注册——半坏的插件好过搜索中断——所以怎么处理探测结果是调用方的事，而探测结果
 * 会上报到面板。
 *
 * 本文件按设计就是宿主相关的（它位于 `lib/dsh/`），但写成了鸭子类型，因此可以用
 * 普通对象在 `node:test` 下覆盖。
 *
 * @module dsh-tavily-pool/dsh/capabilities
 */

import { readService } from './read-service.js';

/**
 * @typedef {object} CapabilityFinding
 * @property {string} id - 稳定的能力 id，可用于设置面板。
 * @property {'ok'|'missing'} status - 探测结果。
 * @property {string} detail - 哪里不对，指名具体成员。
 * @property {string|undefined} remedy - 宿主升级后该去检查什么。
 */

/**
 * 没有它们插件就完全干不了活的能力。
 *
 * 即兼容性契约点名的两项，外加它们全都依赖的反射式读取。
 *
 * `settings.register` 在 DSH 0.1.7 上不再存在，也不再是必需项：设置现在是本插件那条
 * loader 行的配置，schema 由入口模块的 `Config` 声明、值由 loader 解析后经 `apply()`
 * 递进来——**读设置不需要任何服务**。只有面板自己的写入路径要用 `settings.update`，
 * 因此它降级为可选（见 {@link OPTIONAL_CAPABILITIES}）。
 */
export const REQUIRED_CAPABILITIES = Object.freeze([
  'ctx.reflectiveRead',
  'web.registerSearchProvider',
  'clientModules',
]);

/**
 * 缺失只会让某一项功能退化、而非拖垮接管的能力。
 *
 * 只上报、绝不阻塞：抓取接管可以退回落本地 HTTP 提供方，面板可以缺席而搜索照常，
 * 缺少 home 解析器时仍能解析出路径（只是权威性稍差），缺少 `settings.update` 时
 * 搜索与抓取照常、只有面板的「保存设置」会失败。
 */
export const OPTIONAL_CAPABILITIES = Object.freeze([
  'web.registerFetchProvider',
  'settings.update',
  'dshHomePath',
  'connection.fetch.register',
]);

/** 升级后按能力逐项该去看什么。 */
const REMEDIES = Object.freeze({
  'ctx.reflectiveRead':
    'ctx.get(name) in @deepseek-ai/cordis — the non-throwing service read. Every other '
    + 'check here uses it, and provider registration depends on it, so a host without it '
    + 'is a host where this plugin cannot even find the web seam.',
  'web.registerSearchProvider':
    'ctx.web.registerSearchProvider(provider) in @deepseek-ai/dsh-web — the only '
    + 'supported way to contribute a search provider.',
  'settings.update':
    'ctx.settings.update(entryId, patch, expectedRevision?) in @deepseek-ai/dsh-settings — '
    + 'how the panel stores a settings change. Entry identity is the profile entry id, so '
    + 'the argument is this plugin\'s row id, not a namespace it chose.',
  clientModules:
    'ctx.clientModules in @deepseek-ai/dsh-client-modules — composes the dsh.client '
    + 'bundles and serves the slot host the settings card registers into.',
  'web.registerFetchProvider':
    'ctx.web.registerFetchProvider(provider) in @deepseek-ai/dsh-web.',
  dshHomePath:
    'ctx.dshHomePath(...segments) in @deepseek-ai/dsh-app-boot — how the key pool reaches '
    + 'the harness home without hardcoding a path.',
  'connection.fetch.register':
    'ctx.connection.fetch.register({path, methods, requestBody, fetch}) in '
    + '@deepseek-ai/dsh-client-connection — the panel HTTP API.',
});

/** 值是否可调用。 */
function isFunction(value) {
  return typeof value === 'function';
}

/**
 * @typedef {object} CapabilityReport
 * @property {CapabilityFinding[]} findings - 每一项被检查的能力各一条。
 * @property {boolean} ok - 所有必需能力齐备时为 true。
 * @property {string[]} missingRequired - 缺失的必需能力 id。
 * @property {string[]} missingOptional - 缺失的可选能力 id。
 * @property {string} summary - 适合放进一行日志的概要。
 */

/**
 * 探测本插件用到的每一项宿主能力。
 *
 * 服务经 {@link readService} 读取，而非属性访问：context proxy 会对读取方 fiber
 * 未 `inject` 的服务抛出，那会把「settings 服务缺席」变成「探测崩了」——与探测的
 * 目的正好相反。
 *
 * @param host - 由调用方收集的宿主表面。
 * @param host.ctx - 插件 context；缺席的服务只上报，绝不抛出。
 * @returns 一份 {@link CapabilityReport}。
 */
export function probeCapabilities(host) {
  const { ctx } = host;
  const web = readService(ctx, 'web');
  const settings = readService(ctx, 'settings');
  const clientModules = readService(ctx, 'clientModules');
  const connection = readService(ctx, 'connection');
  const dshHomePath = readService(ctx, 'dshHomePath');

  const findings = [];

  /** 记录一项检查。 */
  const check = (id, present, detail) => {
    findings.push({
      id,
      status: present ? 'ok' : 'missing',
      detail: present ? 'available' : detail,
      remedy: REMEDIES[id],
    });
  };

  // 放在第一项，因为下面每一项都依赖它：反射式读取是这些服务被取到的唯一途径，
  // 缺了它的宿主否则会先报「所有能力齐备」，紧接着在注册处死掉。
  check(
    'ctx.reflectiveRead',
    isFunction(ctx?.get),
    'ctx.get is not a function (services cannot be read reflectively, so the web seam is unreachable)',
  );
  check(
    'web.registerSearchProvider',
    isFunction(web?.registerSearchProvider),
    'ctx.web.registerSearchProvider is not a function (the web seam is missing or reshaped)',
  );
  check(
    'settings.update',
    isFunction(settings?.update),
    'ctx.settings.update is not a function (the settings service is missing or reshaped, '
    + 'so the panel cannot store a settings change)',
  );
  check(
    'clientModules',
    clientModules !== undefined,
    'ctx.clientModules is absent (the host cannot compose client bundles, so no settings card can render)',
  );
  check(
    'web.registerFetchProvider',
    isFunction(web?.registerFetchProvider),
    'ctx.web.registerFetchProvider is not a function',
  );
  check(
    'dshHomePath',
    isFunction(dshHomePath),
    'ctx.dshHomePath is not a function (the key pool path falls back to $DSH_HOME, then $HOME)',
  );
  check(
    'connection.fetch.register',
    isFunction(connection?.fetch?.register),
    'ctx.connection.fetch.register is not a function (the panel HTTP API is unavailable)',
  );

  const missingRequired = findings
    .filter((finding) => finding.status === 'missing' && REQUIRED_CAPABILITIES.includes(finding.id))
    .map((finding) => finding.id);
  const missingOptional = findings
    .filter((finding) => finding.status === 'missing' && OPTIONAL_CAPABILITIES.includes(finding.id))
    .map((finding) => finding.id);

  const summary = missingRequired.length === 0 && missingOptional.length === 0
    ? 'all probed host capabilities present'
    : `missing capabilities — required [${missingRequired.join(', ')}], optional [${missingOptional.join(', ')}]`;

  return {
    findings,
    ok: missingRequired.length === 0,
    missingRequired,
    missingOptional,
    summary,
  };
}

/**
 * 把探测报告渲染成一条可据以行动的错误消息（`COMPAT-2`）：它必须说明**缺了什么**
 * 以及**该去哪里看**，因为读它的人是将来要把插件重适配到新宿主上的维护者。
 *
 * @param report - 一份 {@link CapabilityReport}。
 * @returns 多行消息；什么都没缺时返回空字符串。
 */
export function describeMissingCapabilities(report) {
  const missing = report.findings.filter((finding) => finding.status === 'missing');
  if (missing.length === 0) return '';
  const lines = [
    `dsh-tavily-pool: the host is missing ${String(missing.length)} capability(ies) this plugin uses.`,
    'DeepSeek Harness is in preview and its plugin interfaces change between releases.',
    'See docs/dsh-upgrade.md for the re-adaptation checklist.',
  ];
  for (const finding of missing) {
    const scope = REQUIRED_CAPABILITIES.includes(finding.id) ? 'required' : 'optional';
    lines.push(`  - [${scope}] ${finding.id}: ${finding.detail}`);
    if (finding.remedy !== undefined && finding.remedy !== null) lines.push(`      expected: ${finding.remedy}`);
  }
  return lines.join('\n');
}

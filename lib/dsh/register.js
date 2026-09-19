/**
 * 经能力检查的提供方注册。
 *
 * 注册是唯一必须发生在其他一切可能失败的事情之前的一步（`PIN-5`）：先做它，
 * 后面所有初始化就都能包进 `try`/`catch`，插件至多退化为「半坏但搜索仍可用」，
 * 而不会连带把搜索拖垮。
 *
 * 检查放在这里而不是提供方内部，是为了让被改造过的 seam 在**加载期**就响亮失败，
 * 并指名到底缺了哪个成员（`COMPAT-2`），而不是等到某个调用点抛出一个令人费解的
 * `TypeError`。
 *
 * @module dsh-tavily-pool/dsh/register
 */

import { readService } from './read-service.js';

/**
 * 本插件贡献搜索提供方所经的宿主成员。
 *
 * 以路径形式命名，便于诊断信息原样引用。
 */
export const SEARCH_REGISTRATION_PATH = 'ctx.web.registerSearchProvider';

/**
 * 本插件无法绕过的能力缺失时抛出。
 *
 * 把缺失路径挂在错误对象上，使调用方（或将来的面板）无需解析消息即可据以行动。
 */
export class MissingHostCapabilityError extends Error {
  /**
   * @param path - 缺失的成员，点分路径形式。
   * @param remedy - 重适配到新宿主版本时该去哪里看。
   */
  constructor(path, remedy) {
    super(
      `dsh-tavily-pool: the host is missing ${path}, so this plugin cannot register its `
      + 'provider. DeepSeek Harness is in preview and its plugin interfaces change '
      + `between releases; see docs/dsh-upgrade.md. Expected: ${remedy}`,
    );
    this.name = 'MissingHostCapabilityError';
    this.path = path;
    this.remedy = remedy;
  }
}

/**
 * 注册搜索提供方；seam 已消失时以具名错误拒绝。
 *
 * 必须是 `apply()` 的**第一条**效果语句：profile patch 把 `searchProvider` pin 到
 * 本插件的 id，因此一个加载了却没注册的插件会让宿主对每次搜索都抛
 * `WEB_PROVIDER_CONFIGURED_MISSING`。先注册把这一后果收窄到「seam 本身坏了」——
 * 而那是唯一一种做什么都救不了的情况。
 *
 * @param ctx - 插件 context。
 * @param provider - 要注册的搜索提供方。
 * @returns 宿主给出的注册清理函数。
 * @throws {MissingHostCapabilityError} seam 缺失或形状改变时抛出。
 */
export function registerSearchProvider(ctx, provider) {
  const web = readService(ctx, 'web');
  const register = web?.registerSearchProvider;
  if (typeof register !== 'function') {
    throw new MissingHostCapabilityError(
      SEARCH_REGISTRATION_PATH,
      'ctx.web.registerSearchProvider(provider) in @deepseek-ai/dsh-web — the only supported '
      + 'way to contribute a search provider.',
    );
  }
  return register.call(web, provider);
}

/**
 * 本插件贡献抓取提供方所经的宿主成员。
 *
 * 与搜索那一条分开列，是**因为两者的失败后果不同**：搜索的注册失败会让每次
 * `web_search` 都硬抛，而抓取只让 `web_fetch` 抛——后者可以在插件内部捕获并继续用搜索。
 */
export const FETCH_REGISTRATION_PATH = 'ctx.web.registerFetchProvider';

/**
 * 注册抓取提供方；seam 已消失时以具名错误拒绝（`10`）。
 *
 * 与 {@link registerSearchProvider} 一样必须是加载期的早动作，但它**不在** `apply()` 的
 * 关键路径上：抓取是可选能力（`lib/dsh/capabilities.js` 的 `web.registerFetchProvider`），
 * 因此 `apply()` 会在自己的 `try` 里调它，让「宿主没有这个成员」只表现为抓取缺席。
 *
 * @param ctx - 插件 context。
 * @param provider - 要注册的抓取提供方。
 * @returns 宿主给出的注册清理函数。
 * @throws {MissingHostCapabilityError} seam 缺失或形状改变时抛出。
 */
export function registerFetchProvider(ctx, provider) {
  const web = readService(ctx, 'web');
  const register = web?.registerFetchProvider;
  if (typeof register !== 'function') {
    throw new MissingHostCapabilityError(
      FETCH_REGISTRATION_PATH,
      'ctx.web.registerFetchProvider(provider) in @deepseek-ai/dsh-web — the only supported '
      + 'way to contribute a fetch provider.',
    );
  }
  return register.call(web, provider);
}

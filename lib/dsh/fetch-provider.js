/**
 * 抓取提供方：把 seam 的 `WebFetchRequest` 接到「Tavily `/extract`」或「官方本地 HTTP
 * 抓取器」上去。
 *
 * 与 `search-provider.js` 同构，且共用它的失败翻译（{@link rethrowAsWebError}）——两份
 * 提供方对宿主说的是同一套失败词汇，把它们各抄一遍只会得到两处会分别漂移的真相。
 * 「哪些失败算失败」这件事留在内核（`lib/tavily.js`）与分类器（`lib/health.js`）里，
 * 本文件不做任何判断。
 *
 * 与搜索提供方唯一的实质差别是构造参数多一个**回落目标**：抓取开关关闭、或池内没有可用
 * 密钥时，请求交给官方 `HttpFetchProvider`。搜索那条路径上的回落目标需要解析凭据，因此
 * 它的回落住在 `lib/dsh/fallback.js`；抓取的回落目标是一个已经构造好的实例，直接交进来
 * 更直接，也更容易在测试里替换成一个记录调用的桩件。
 *
 * `id` 与搜索提供方共用同一个字符串，这是**必需的**而非巧合：seam 把搜索与抓取分在两个
 * 注册表里，同名不冲突；而 profile patch 的 `searchProvider` 与 `fetchProvider` 是同一份
 * `config` 对象里的两个字段，让它们指向同一个 id 是那次「必须同时写全」的事故之后最容易
 * 读懂的写法。
 *
 * @module dsh-tavily-pool/dsh/fetch-provider
 */

import { PROVIDER_ID } from '../constants.js';
import { rethrowAsWebError } from './search-provider.js';

/**
 * Tavily 抓取提供方。
 *
 * `available()` 恒返回 `true`，理由与搜索提供方逐字相同：profile patch 把
 * `fetchProvider` 静态 pin 成 `tavily`，而被 pin 的提供方若自称不可用，结果是硬抛
 * `WEB_PROVIDER_CONFIGURED_UNAVAILABLE`，不是回落。因此每一个真正的判断——抓取开关、
 * 池中是否有可用密钥——都必须发生在 `fetch()` 内部。
 */
export class TavilyFetchProvider {
  #fetch;

  /**
   * @param fetch - 在每次抓取开始时读取当前设置与密钥池，并在需要时把请求交给回落目标。
   *   之所以是 thunk 而不是值：设置与密钥池都会在插件保持注册期间变化，而为了携带新值
   *   去重新注册提供方会让 seam 的选择过程在用户眼里表现为闪烁。
   */
  constructor(fetch) {
    this.#fetch = fetch;
    this.id = PROVIDER_ID;
  }

  /**
   * 廉价的本地可用性检查；seam 调用它时不会发起网络请求。
   *
   * @returns 恒为 `true`；原因见类注释。
   */
  available() {
    return true;
  }

  /**
   * 抓取一个 URL。
   *
   * @param request - seam 的抓取请求。**它只有 `url` 一个字段**（宿主类型注释原文：
   *   「The request deliberately omits timeout, format, prompt, and extraction
   *   controls」），因此 `extract_depth` / `format` 只能来自插件设置，模型无法按次控制。
   * @param signal - 调用方取消信号。
   * @returns seam 归一化后的抓取结果。
   * @throws {WebError} 失败时抛出。
   */
  async fetch(request, signal) {
    try {
      return await this.#fetch(request, signal);
    } catch (error) {
      rethrowAsWebError(error);
    }
  }
}

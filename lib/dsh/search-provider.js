/**
 * 唯一知道宿主 web seam 长什么样的地方。
 *
 * `lib/tavily.js` 说 Tavily 的话；seam 说 `WebSearchRequest` / `WebSearchResult` 的话。
 * 本模块是两者之间的翻译层，也是搜索路径上唯一 import 宿主错误类的文件，因此失败
 * 会以 harness 期望的 `WebError` 形式抵达，而内核保持与宿主零耦合（`COMPAT-1`）。
 *
 * @module dsh-tavily-pool/dsh/search-provider
 */

import { WebError } from '@deepseek-ai/dsh-web';

import { PROVIDER_ID } from '../constants.js';
import { TavilyError } from '../tavily.js';

/**
 * 把内核失败重新抛成宿主的 `WebError`，保留机器码、上游状态码与 `request_id`。
 *
 * `code` 是 harness 作为结构化失败元数据上报的东西（`dsh-tools` 会从 `HarnessError`
 * 上读 `{ name, code }`），因此必须在跨界时保持完整。
 *
 * 取消是唯一会被翻译的 code，理由也仅仅是 seam 已经为它准备了拼写：`WebError` 的
 * 共享 code 里包含取消与提供方失败，因此发出 seam 的 `WEB_ABORTED` 能让按该词表
 * 分流的消费方继续工作，而我们的内部拼写 `TAVILY_ABORTED` 对它来说是无法识别的
 * 字符串。
 *
 * @param error - 抛出的值。
 * @returns 永不返回；必定抛出。
 */
export function rethrowAsWebError(error) {
  if (error instanceof TavilyError) {
    const code = error.code === 'TAVILY_ABORTED' ? 'WEB_ABORTED' : error.code;
    throw new WebError(error.message, code, error.cause === undefined ? undefined : { cause: error.cause });
  }
  throw error;
}

/**
 * Tavily 搜索提供方。
 *
 * `available()` 恒返回 `true`，这是硬性要求而非疏漏：profile patch 把
 * `searchProvider` pin 成 `tavily`，而被 pin 的提供方若自称不可用，结果是硬抛
 * `WEB_PROVIDER_CONFIGURED_UNAVAILABLE`，不是回落。因此每一个真正的判断——开关、
 * 池中是否有可用密钥——都必须发生在 `search()` 内部。
 */
export class TavilySearchProvider {
  #search;

  /**
   * @param search - 在每次搜索开始时读取当前设置与密钥池，并执行一次带故障切换的
   *   搜索。之所以是 thunk 而不是值：设置与密钥池都会在插件保持注册期间变化，而为了
   *   携带新值去重新注册提供方，会让 seam 的选择过程在用户眼里表现为闪烁。
   */
  constructor(search) {
    this.#search = search;
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
   * 经 Tavily 执行一次搜索。
   *
   * @param request - seam 的请求。
   * @param signal - 调用方取消信号。
   * @returns seam 归一化后的结果。
   * @throws {WebError} 失败时抛出。
   */
  async search(request, signal) {
    try {
      return await this.#search(request, signal);
    } catch (error) {
      rethrowAsWebError(error);
    }
  }
}

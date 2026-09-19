/**
 * 各处共用的固定词汇：id、端点、默认值。
 *
 * 按设计即与宿主零耦合（`COMPAT-1`）：本文件不 import 任何 `@deepseek-ai/*`，
 * 因此整份文件都能在 `node:test` 下直接测试。
 *
 * 只有真正被读取的值才放在这里。某项能力所需的常量随使用它的代码一起落地，
 * 使本文件始终是「当前插件的事实清单」，而不是一份计划。
 *
 * @module dsh-tavily-pool/constants
 */

/**
 * 本插件注册使用的提供方 id。搜索与抓取共用同一个字符串：seam 把两者分在
 * 两个注册表（`registerSearchProvider` / `registerFetchProvider`），而
 * profile patch 把两个字段都 pin 到它。
 */
export const PROVIDER_ID = 'tavily';

/** Tavily 的搜索端点。 */
export const TAVILY_SEARCH_URL = 'https://api.tavily.com/search';

/**
 * 本插件状态目录在 harness home 下的名字。经宿主路径助手解析——绝不硬编码
 * （`DOC-4`）。
 */
export const STATE_DIR_NAME = 'dsh-tavily-pool';

/** {@link STATE_DIR_NAME} 内的密钥池文件名。 */
export const KEYS_FILE_NAME = 'keys.json';

/**
 * 设置命名空间；必须与客户端卡片的 slot `key` 完全一致。两者按字符串相等配对，
 * 且该命名空间不可重复注册。
 */
export const SETTINGS_NAMESPACE = 'dsh-tavily-pool';

/**
 * `/search` 的请求超时，单位毫秒。
 *
 * 宿主给整次 `web_search` 调用 60 秒预算，而后面的 ticket 会从中分走一部分用于
 * 有界等待与跨密钥故障切换。单次尝试的超时远低于该预算，正是总耗时有界的保证。
 */
export const SEARCH_TIMEOUT_MS = 20_000;

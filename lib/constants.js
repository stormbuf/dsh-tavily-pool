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
 * Tavily 的余额与用量端点（`USAGE-1`）。
 *
 * **只能是 `GET`。** 官方 OpenAPI 把它定义成 `GET /usage`，实测 `POST` 会被以
 * `405 Method Not Allowed` 拒绝。
 */
export const TAVILY_USAGE_URL = 'https://api.tavily.com/usage';

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

/**
 * 宿主给一次 `web_search` 的**总**时间预算，单位毫秒（`SCHED-9`）。
 *
 * 它是 `dsh-tool-web` 的 `searchTimeoutMs`，也是本插件排布等待与尝试的依据：单次尝试
 * 的超时按剩余预算折算，等待预算从它里面分。
 *
 * **它是目标而不是硬上界。** {@link MIN_ATTEMPT_TIMEOUT_MS} 保证最后一次尝试一定会
 * 真的发生，因此最坏情形会略微超出这个数（等满 30 秒之后仍保底放行三次尝试）。宁可
 * 略微超出，也不要让「超了」表现为一次必然失败的 0 毫秒请求——那等于跳过一次尝试，
 * 而那次尝试本来能带回上游的真实答复。
 */
export const SEARCH_TOTAL_BUDGET_MS = 60_000;

/**
 * 单次 `web_search` 里允许花在**有界等待**上的时长，单位毫秒（`SCHED-9`）。
 *
 * 池内全部候选都在冷却时，等最早到期的那个结束；上限就是它。30 秒的取值来自 spec
 * §5.3 对 `SCHED-9` 的建议（宿主预算 60000ms，建议等待 ≤30s）：它在「等到冷却
 * 结束」与「早点了断、把真实错误交给调用方」之间留出对半的余量。
 */
export const SEARCH_WAIT_BUDGET_MS = 30_000;

/**
 * 一次等待最多占掉本次搜索剩余预算的比例（`SCHED-9`）。
 *
 * 等待是为了「等到了就能发出去」。若一次等待吃掉大半剩余预算，等到了也来不及发出
 * 请求，只是把失败推迟几十秒——那时 `REST-10` 要求的「透穿最后一个真实的上游错误
 * 响应」反而变得不可能。留出至少一次尝试的时间，等待才是有意义的。
 */
export const WAIT_BUDGET_SHARE = 0.5;

/**
 * 单次尝试超时的下限，单位毫秒。
 *
 * 剩余预算被前面的尝试吃掉之后，折算出的超时会趋于 0；一个 0 毫秒的超时必然失败，
 * 那等于跳过一次尝试，而不是保护预算。有这样一个下限时，宁可略微超出总预算，也要
 * 让最后一次尝试真的发生过——它带回的是真实的上游响应。
 */
export const MIN_ATTEMPT_TIMEOUT_MS = 2_000;

/**
 * `/usage` 的滑动窗口长度，单位毫秒（`USAGE-2`）。
 *
 * 官方对 `/usage` 的限流是 **10 次 / 10 分钟**（Development 与 Production 相同），
 * 因此窗口就是官方的那个窗口，不另造一个。
 */
export const USAGE_QUOTA_WINDOW_MS = 600_000;

/**
 * 一个滑动窗口内允许发出的 `/usage` 请求数（`USAGE-2`）。
 *
 * 取官方的 10 次本身，而不是留出余量的小数字：预占的作用是「绝不超发」，而官方
 * 限流是硬拒绝。正好打满 10 次仍然合规，少发只是让用户在额度耗尽时更晚才拿到
 * 恢复信号。
 */
export const USAGE_QUOTA_MAX_CALLS = 10;

/**
 * `/usage` 的请求超时，单位毫秒。
 *
 * 它不参与宿主的 60 秒搜索预算：这条路径要么在面板上由用户手动触发，要么发生在
 * 调度之前。10 秒足够一次正常的余额查询（实测约 1.8 秒），又不至于让面板看起来
 * 卡住。
 */
export const USAGE_TIMEOUT_MS = 10_000;

/**
 * 跨月起始后的自动探测间隔，单位毫秒（`SCHED-10`）。
 *
 * 6 小时一次，因此 48 小时的窗口里最多 **8** 次探测（实测栅格为月起始后的
 * 0/6/12/…/42 小时；第 48 小时那个点落在半开窗口之外），远低于「10 次 / 10 分钟」的官方
 * 配额。间隔也不能太短：探测的意义是覆盖全球各个时区的月初 0 点，而它们彼此相差
 * 至多 24 小时（UTC−12 到 UTC+14），6 小时足以在任何一个时区越界后的第一次探测里
 * 看见结果。
 */
export const QUOTA_PROBE_INTERVAL_MS = 6 * 3600 * 1000;

/**
 * 跨月起始后自动探测的总时长，单位毫秒（`SCHED-10`）。
 *
 * 48 小时足以覆盖 UTC±14 的全部月初 0 点。过了它仍无恢复，说明不是「还没到重置
 * 时刻」，而是要用户提额，于是停止自动探测、退回手动刷新。
 */
export const QUOTA_PROBE_WINDOW_MS = 48 * 3600 * 1000;


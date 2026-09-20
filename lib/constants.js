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
 * Tavily 的网页抽取端点（`FETCH-1`）。
 *
 * 与 `/search` 是两个端点、两套参数、两张错误表，因此是两个常量而不是一个「基址 +
 * 路径参数」：把端点的选择变成一个运行期拼接出来的字符串，会让 `REST-2` 那类「搜索
 * 固定发什么」的规则无处安放。
 */
export const TAVILY_EXTRACT_URL = 'https://api.tavily.com/extract';

/**
 * `/extract` 的抽取深度取值（`10`）。
 *
 * 它同时决定计费档位——每 5 个成功 URL 计 1（`basic`）还是 2（`advanced`）积分
 * （`USAGE-6`）——因此是用户可见的设置项，不是内部常量。
 */
export const EXTRACT_DEPTH_VALUES = Object.freeze(['basic', 'advanced']);

/**
 * `/extract` 的返回格式取值（`10`）。
 *
 * `markdown` 是官方默认。`text` 会**增加延迟**（官方参数表原文如此），因此默认不取。
 * 两者产出的都是纯文本，与本插件「必须返回 `body.kind = 'text'`」那条硬约束无关——
 * 那条约束说的是「Tavily 给的不是 HTML，标成 html 会被 turndown 二次转换」。
 */
export const EXTRACT_FORMAT_VALUES = Object.freeze(['markdown', 'text']);

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
 * 一次 Tavily 请求的超时，单位毫秒，搜索与抓取共用。
 *
 * 两条路径各自的宿主预算不同（`web_search` 60 秒、`web_fetch` 30 秒），但**留在这里
 * 的是同一个数**：它是「单次尝试最多花多久」这一条策略，不是从某个预算算出来的派生值。
 * 20 秒同时满足 `FETCH-4`（不超过 20 秒，否则与 DSH 侧 30 秒上限叠加成超时）与搜索侧
 * 「远低于 60 秒总预算」的要求，因此一个常量覆盖两条路径，而不是两个逐字相同的副本。
 */
export const TAVILY_TIMEOUT_MS = 20_000;

/**
 * 一次 `web_search` 的**总**时间预算，单位毫秒（`SCHED-9`）。
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
 * 一次 `web_fetch` 的总时间预算，单位毫秒。
 *
 * **它与搜索那个不是同一个数，这不是笔误。** 宿主侧 `dsh-base` 只把 `searchTimeoutMs`
 * 抬到 60 秒，`web_fetch` 保持 `dsh-tool-web` 的默认 **30 秒**
 * （`fetchTimeoutMs`，由 `dsh-tool-call-timeout-policy` 武装成 `exec.signal`）。抓取若沿用
 * 60 秒的预算，等待上限会折算成 30 秒——**一项就吃掉宿主的全部预算**，随后的尝试还没发出去
 * 就被掐断，用户看到的是「tool call timed out」而不是 `REST-10` 要求透穿的真实上游错误。
 *
 * 取 25 秒而不是 30：留 5 秒给本插件自己的收尾与宿主侧的回传，让「我们主动了断」永远早于
 * 「宿主掐断我们」。折算下来等待上限 12.5 秒（{@link WAIT_BUDGET_SHARE}），此后仍有至少两次
 * 20 秒上限的尝试机会（实际每次再按剩余预算折算）。
 */
export const FETCH_TOTAL_BUDGET_MS = 25_000;

/**
 * 从宿主绑定的 tool `timeoutMs` 里留出的余量，单位毫秒。
 *
 * 上面那两条预算现在是**回落值**：两条路径都先读宿主真正绑定的
 * `timeoutMs`（`lib/dsh/host-budget.js`），读不到才用常量。真正的预算按宿主值减去本余量
 * 折算。
 *
 * 余量要够我们做收尾并把真实错误回传，又不能大到让预算明显缩水。理由是 `REST-10`：只有在
 * 宿主掐断之前**自己先了断**，最后一次尝试的真实上游错误才来得及经 `WebError` 回到调用方；
 * 让宿主的 deadline 先到，模型看到的就是 `tool call timed out after …ms`，上游说了什么
 * 则无从得知。
 *
 * 2 秒：与单次尝试的下限 {@link MIN_ATTEMPT_TIMEOUT_MS} 同量级——「保底的那一次尝试」与
 * 「留给收尾的余量」本就该是同一尺度上的两个数，而不是两个各造一个的数量级。
 */
export const HOST_BUDGET_MARGIN_MS = 2_000;

/**
 * 单次调用里允许花在**有界等待**上的时长，单位毫秒（`SCHED-9`）。
 *
 * 池内全部候选都在冷却时，等最早到期的那个结束；上限就是它。30 秒的取值来自 spec
 * §5.3 对 `SCHED-9` 的建议（宿主预算 60000ms，建议等待 ≤30s）：它在「等到冷却
 * 结束」与「早点了断、把真实错误交给调用方」之间留出对半的余量。
 *
 * 它是**上限**：真正的等待额度还要与本次剩余预算的一半取较小者
 * （{@link WAIT_BUDGET_SHARE}），因此抓取那条 25 秒的预算下实际只等得到 12.5 秒。
 */
export const WAIT_BUDGET_MS = 30_000;

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

/**
 * 估算用的分档除数：每 5 个成功抽取的 URL 算一档（`USAGE-6`）。
 *
 * 官方原文：「Every 5 successful URL extractions cost 1 API credit」（`basic`）/
 * 「Every 5 successful URL extractions cost 2 API credits」（`advanced`）。这个 5 是
 * 官方口径本身，不是可调参数。
 *
 * ⚠️ **这是估算，不是记账**（2026-09-20 决定）。积分规则由上游随时可能更改，而本插件
 * 不再统计自身消耗、也不展示任何自算的积分数字——面板与设置页只展示 `/usage` 的官方
 * 余额。这组常量仅用于「余额前推」：让调度器在两次 `/usage` 刷新之间也能按大致余额
 * 排序，而不是拿上一次刷新的旧数字做决定。它算错不影响任何展示，只轻微影响排序。
 */
export const EXTRACT_URLS_PER_CREDIT_TIER = 5;

/** `basic` 档每 5 个成功 URL 的估算积分（`USAGE-6`）。 */
export const BASIC_EXTRACT_CREDITS_PER_FIVE = 1;

/** `advanced` 档每 5 个成功 URL 的估算积分（`USAGE-6`）。 */
export const ADVANCED_EXTRACT_CREDITS_PER_FIVE = 2;

/** `basic` / `fast` / `ultra-fast` 三档搜索的估算积分（官方 `search_depth` 描述）。 */
export const BASIC_SEARCH_CREDITS = 1;

/** `advanced` 档搜索的估算积分（官方 `search_depth` 描述）。 */
export const ADVANCED_SEARCH_CREDITS = 2;

/**
 * 一个 URL 也没抓到时报给 callers 的 `statusCode`（`FETCH-3`）。
 *
 * **这不是上游的状态码**——那种情形下上游给的正是 `200`。它是「向上游的请求成功了，
 * 但它没能取回被请求的那份资源」的通用表示，与 seam 自己的词汇表一致（本地 HTTP
 * 抓取器也是把非 2xx 当作**结果**而不是异常）。
 */
export const EXTRACT_FAILURE_STATUS = 502;

/** {@link STATE_DIR_NAME} 内的调用历史文件名（`14`）。 */
export const HISTORY_FILE_NAME = 'history.json';

/**
 * 调用历史保留的最大条数（`14`）。
 *
 * 上限的存在理由就是 ticket `14` 的那条「未决」：JSON 文件不适合无界增长。500 条足以覆盖
 * 一次日常使用里的最近数百次调用，而按每条约 200 字节估算，文件上限约 100 KB——一个每次调用
 * 都要重写的文件不该比这更大。
 */
export const HISTORY_MAX_ENTRIES = 500;

/**
 * 调用历史保留的最长时间，单位毫秒（`14`）。
 *
 * 30 天。条数与时间窗口**同时**生效：条数防止高频使用把文件写爆，窗口防止低频使用时一份
 * 半年前的记录永远占着位置——既没人看，又让每次调用都要重写的文件白白变大。
 */
export const HISTORY_RETENTION_MS = 30 * 24 * 3600 * 1000;

/**
 * 一次面板请求最多允许提交的密钥条数（`POOL-8`）。
 *
 * 200 落在一个很宽的量级沟里：正常用法的上界是几十把（一个用户手里能有几个 Tavily 账号），
 * 而误粘进来的是一**整个文件**——审计实测一次粘贴 5000 行全部入库（`panel-http-4`）。因此
 * 这个上限回答的不是「够不够用」，而是「粘错时要不要当场拒绝」：不拒绝时那些行各自变成一条
 * 永远鉴权不通过的记录，此后每一次 `GET /state` 都要把它们整份序列化（实测 5001 把 →
 * 696 KB 响应体），而卡片只能逐把删除。
 *
 * 它约束的是**单次请求**，与池内总数上限 {@link PANEL_KEYS_MAX} 是两件事：前者说的是「这一次
 * 粘的东西不像密钥清单」，后者说的是「池子不该被越堆越大」。两者数值相同只是因为都落在同一
 * 量级，改其中一个不必改另一个。
 */
export const PANEL_KEYS_MAX_PER_REQUEST = 200;

/**
 * 密钥池允许容纳的密钥总数上限。
 *
 * 与 {@link PANEL_KEYS_MAX_PER_REQUEST} 同值而理由不同：每一次 `GET /state` 都要把全池脱敏后
 * 整份发给卡片（`POOL-3`），卡片再把每一把渲染成一行；实测每把约 139 字节，200 把约 28 KB。
 * 更大的池子对用户已经没有意义（没有人会去逐行读两百行密钥），却让每一次面板刷新都变重。
 *
 * 它只约束**写进去**：池子满了之后添加被拒，而读取、删除与去重判定照常——上限的存在是为了
 * 让池子回到可用规模，不是为了把它锁死。
 */
export const PANEL_KEYS_MAX = 200;

/**
 * 一把明文密钥的最大长度。
 *
 * Tavily 的密钥是 `tvly-` 加一段定长随机串，实测 50 字符上下；512 是它的十倍，容得下任何
 * 真实密钥、任何顺手带上的引号或逗号、以及将来更长的新格式，而**放不下任何一整行文件内容**
 * ——审计里那把 200 KB 的「密钥」正是误粘一整行文本的形状（`panel-http-4`）。
 *
 * 超限按入参非法**拒绝**，不截断：截断后的字符串既不是用户给的密钥、也不会是别的合法密钥，
 * 而用户会以为它写进去了。
 */
export const PANEL_KEY_MAX_LENGTH = 512;


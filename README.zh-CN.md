# dsh-tavily-pool

[English](./README.md) | **简体中文**

用 [Tavily](https://tavily.com) 替代 DeepSeek Harness 内置的 web 搜索**与**网页抓取：多密钥池、余额感知轮转、失败自动切换、冷却、官方 `/usage` 余额展示，搜索与抓取各有独立开关，全部在 DSH 设置面板内配置。

> 请勿与 [`SZMY-haruhi/dsh-tavily`](https://github.com/SZMY-haruhi/dsh-tavily)（单密钥 / 免密钥，无调度）或 [`@yuuz12/dsh-tavily`](https://www.npmjs.com/package/@yuuz12/dsh-tavily)（多密钥，但不接管抓取，且在运行时改写内部字段）混淆。本插件管理一个密钥**池**，按剩余余额调度，并**同时**接管 `web_search` 与 `web_fetch`。

## 功能

- **多密钥池** —— 单把或整批粘贴添加（一行一个）、备注、启停、排序、单把或批量删除；界面只显示脱敏形式
- **调度策略可配** —— 在余额优先与手动顺序之间切换，后者下列表顺序**就是**调度顺序
- **余额感知轮转** —— 剩余额度多的先用；余额三态（上限优先取 `key.limit`，为 `null` 时退回该密钥所属账号的 `account.plan_limit`；**两级都明确为 `null`** 才算无限并排最前，未知 → 垫底）
- **失败自动切换** —— 一把失败就交给下一把
- **冷却** —— 遵循上游 `Retry-After`；冷却期内硬排除，全部冷却时在预算内等待最早到期的一把
- **按状态码分别处理** —— 区分临时失败、密钥永久失效（**看响应体**，绝不只看状态码）与额度耗尽（432 / 433 同等处理：该密钥不被选中，直到 `/usage` 确认余额回升）
- **官方余额，使用时顺手刷新** —— 卡片上的积分是官方 `/usage` 的读数（上限 − 已用）。三种情形会自动重拉：本次**真的被用到**的那把读数已超过 1 小时、密钥刚添加、以及插件下一次被用到时把池内**仍缺读数**的密钥补齐。插件**不**做自己的积分记账：Tavily 的计费规则随时可能更改，本地算出来的数字会在某次规则调整后悄悄变成误导。两次读数之间的排序靠一个刻意粗糙、且**从不作为独立数字展示**的每次调用估算前推；它会推动界面上那个「已用」数字，因此卡片同时会说出「上次官方读数」有多旧。**没有任何后台任务**：不搜索、不抓取，就一次 `/usage` 都不会发
- **余额刷新** —— 拉取官方 `/usage`，按密钥做滑动窗口配额预占，不会触发 10 次 / 10 分钟的限流
- **搜索参数可配** —— 搜索深度、结果数上限、主题、是否生成答案，改动即时生效
- **抓取接管（默认关闭）** —— 把 `web_fetch` 映射到 Tavily `/extract`，返回纯文本（绝不标成 HTML——那会让 DSH 再转换一次）；抽取深度与返回格式可配。想让 Tavily 也接管抓取时，在设置里打开它
- **调用历史与图表** —— 每次调用都留下记录（密钥、端点、结果、耗时、`request_id`），并画成 14 天的调用次数曲线；文件同时受条数上限与 30 天窗口约束
- **两个独立开关** —— 搜索与抓取可分别切回官方提供方
- **零运行时依赖** —— 纯 ESM，无构建步骤

> **已交付：** spec 要的全部——搜索接管与它的开关、密钥池（单把录入、整批粘贴、批量删除）、
> 故障切换与冷却、搜索参数、调度策略、余额刷新、抓取接管与它自己的开关（默认关闭）、
> 调用历史与图表、每把密钥的调用统计与余额进度条、连通性测试，以及设置卡片及其 HTTP 接口。

## 安装

从 npm registry 安装：

```sh
dsh plugin add dsh-tavily-pool
```

或直接从 GitHub 安装——不需要 registry 账号。想要可复现的版本就 pin 住某个已发布的 tag，
可用的见 [tags 页](https://github.com/stormbuf/dsh-tavily-pool/tags)：

```sh
dsh plugin add github:stormbuf/dsh-tavily-pool
dsh plugin add github:stormbuf/dsh-tavily-pool#vX.Y.Z
```

两条路装到的文件相同：`package.json` 里的 `files` 白名单对 git 安装同样生效，因此不会捎带上
`test/` 或 `scripts/` 目录。

然后**重启 DSH**，打开 **设置 → 插件 → dsh-tavily-pool**，粘贴你的 Tavily API key。密钥只能通过面板录入——本插件不读取环境变量，也不读取 DSH 的 credentials 服务。

配置、调度行为、计费说明与手动回退步骤见 [`docs/usage.zh-CN.md`](./docs/usage.zh-CN.md)。

## 兼容性

DeepSeek Harness 处于预览期，其架构与插件接口可能随版本变动。本插件把**绝大多数**宿主相关知识隔离在一层薄适配器（`lib/dsh/`）中，零构建客户端半边（`lib/client.js`）与 `cordis.patch.yml` 里的提供方 pin 另计；并在加载时探测宿主能力，使破坏性变更后的重适配成本保持低廉。

**已测试版本：DSH `0.1.5-rc.2`。** 在更新的版本上可能需要重新适配；届时插件会报出**明确指出缺失能力**的错误，而不是静默失败。逐条重适配清单见 [`docs/dsh-upgrade.zh-CN.md`](./docs/dsh-upgrade.zh-CN.md)。

经 `dsh plugin add` 安装后，本包会成为目标 profile 的一个 **bundle 层**（进入该 profile 的
`dsh.profile.bundles`，排在 DSH 各 bundle 之后），它的 `cordis.patch.yml` 因此能 pin 住提供方。
你自己的 profile patch 在**所有 bundle 层之后**应用，因此随时可以覆盖或停用本插件的行为——
见[手动回退](./docs/usage.zh-CN.md#手动回退)。

## 许可

MIT

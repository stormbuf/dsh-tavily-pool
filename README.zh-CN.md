# dsh-tavily-pool

[English](./README.md) | **简体中文**

用 [Tavily](https://tavily.com) 替代 DeepSeek Harness 内置的 web 搜索**与**网页抓取：多密钥池、余额感知轮转、失败自动切换、冷却、用量统计，搜索与抓取各有独立开关，全部在 DSH 设置面板内配置。

> 请勿与 [`szmy-haruhi/dsh-tavily`](https://github.com/SZMY-haruhi/dsh-tavily)（单密钥 / 免密钥，无调度）或 [`@yuuz12/dsh-tavily`](https://www.npmjs.com/package/@yuuz12/dsh-tavily)（多密钥，但不接管抓取，且在运行时改写内部字段）混淆。本插件管理一个密钥**池**，按剩余余额调度，并**同时**接管 `web_search` 与 `web_fetch`。

## 功能

- **多密钥池** —— 添加、备注、启停、排序、删除；界面只显示脱敏形式
- **余额感知轮转** —— 剩余额度多的先用；余额三态（`limit` 为 `null` → 无限最前，未知 → 垫底）
- **失败自动切换** —— 一把失败就交给下一把
- **冷却** —— 遵循上游 `Retry-After`；冷却期内硬排除，全部冷却时短暂等待最早到期的一把
- **按状态码分别处理** —— 区分临时失败、密钥永久失效（**看响应体**，绝不只看状态码）、密钥额度耗尽（432 / 433）
- **用量记账** —— 读取响应中的真实 `usage.credits`；未知记为未知，绝不记 0
- **余额刷新** —— 拉取官方 `/usage`，按密钥做滑动窗口配额预占，不会触发 10 次 / 10 分钟的限流
- **抓取接管** —— 把 `web_fetch` 映射到 Tavily `/extract`；计费按成功 URL 分档
- **两个独立开关** —— 搜索与抓取可分别切回官方提供方
- **零运行时依赖** —— 纯 ESM，无构建步骤

## 安装

```sh
dsh plugin add dsh-tavily-pool
```

然后打开 **设置 → 插件 → dsh-tavily-pool**，粘贴你的 Tavily API key。密钥只能通过面板录入——本插件不读取环境变量，也不读取 DSH 的 credentials 服务。

配置、调度行为、计费说明与手动回退步骤见 [`docs/usage.zh-CN.md`](./usage.zh-CN.md)。

## 兼容性

DeepSeek Harness 处于预览期，其架构与插件接口可能随版本变动。本插件把所有宿主相关知识隔离在一层薄适配器（`lib/dsh/`）中，并在加载时探测宿主能力，使破坏性变更后的重适配成本保持低廉。

**已测试版本：DSH `0.1.5-rc.2`。** 在更新的版本上可能需要重新适配；届时插件会报出**明确指出缺失能力**的错误，而不是静默失败。

## 许可

MIT

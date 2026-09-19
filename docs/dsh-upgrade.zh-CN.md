# 把本插件重适配到新的 DSH 版本

[English](./dsh-upgrade.md) | **简体中文**

DeepSeek Harness 处于预览期，其插件接口会随版本变动。本插件围绕一个思路构建：
**所有宿主相关知识都活在 `lib/dsh/` 里**，因此一次破坏性变更的代价是一个目录，而不是整个代码库。

| 已测试版本 | `@deepseek-ai/dsh-*` `0.1.5-rc.2`，`@deepseek-ai/cordis` `4.0.2` |
|---|---|
| 依赖 | `package.json` → `peerDependencies` 列出的包 |
| 声明区间 | 刻意取**窄** —— 见[版本区间](#版本区间) |

升级若弄坏了什么，先读失败信息：插件在**加载时探测宿主**，按名字报出**哪一项**能力缺失，
而不是等到第一次搜索才失败。那条消息通常已足够定位下面该走哪一行。

## 绝不该改动的那一层

以下模块 **不** import 任何 `@deepseek-ai/*` 包，且无需 harness 即可在 `node:test` 下运行。
若一次升级迫使你改动这里，那是设计出了问题，不是升级出了问题：

| 模块 | 负责 |
|---|---|
| `lib/constants.js` | id、端点、超时、默认值 |
| `lib/tavily.js` | Tavily REST 请求/响应形状 |
| `lib/pool.js` | 密钥池文件、原子写、脱敏、密钥编辑 |
| `lib/scheduler.js` | 余额排序、硬排除、有界等待 |
| `lib/health.js` | 失败分类、冷却、额度耗尽/永久失效状态 |
| `lib/attempts.js` | 一次请求内的跨密钥故障切换 |
| `lib/settings.js` | 设置形状与默认值（schema 本身与宿主无关） |

`lib/usage.js` 会随余额刷新（`06`）加入这一层。`test/compat-core.test.js` 机械执行该规则
——任一所列文件长出宿主 import 即失败；它同时断言这份清单本身，因此创建上述模块却没加进
清单会**直接让测试失败**，而不是静默通过。

## 作业清单

按顺序逐条走；前几项覆盖了几乎全部破坏。

### 1. seam 形状 —— `WebSearchProvider` / `WebFetchProvider`

**看哪里：** `dsh-web/lib/types/types.d.ts`
**改哪个模块：** `lib/dsh/search-provider.js`

确认两个提供方接口仍有 `id`、`available()`、`search()` / `fetch()`，且请求/结果类型仍带有
本插件读写的字段：

- `WebSearchRequest.query`、`.maxResults`
- `WebSearchResult.sources[]`、`.content?`、`.truncated`
- `WebFetchBody` 仍以 `kind` 作可辨识联合，且分支里仍有 `'text'`

### 2. 选择语义 —— `available()` 恒为 `true` 的原因

**看哪里：** `dsh-web/lib/index.js` 的 `resolveProvider`
**改哪个模块：** `lib/dsh/search-provider.js`（若结论变了，改 `available()` 的注释）

插件在 `cordis.patch.yml` 里把自己 pin 住，因此它活在**「配置了 id、已注册、却不可用 → 硬抛」**
这条规则之下，而不是回落。确认该规则仍然成立：

- 已配置 + 已注册 + `available()` → 用它
- 已配置 + 未注册 → `WEB_PROVIDER_CONFIGURED_MISSING`
- 已配置 + 已注册 + 不可用 → `WEB_PROVIDER_CONFIGURED_UNAVAILABLE`

**若 `available()` 获得了回落语义**，那它就可以开始反映真实状态了。在那之前它必须继续
返回 `true`，且所有判断都必须留在 `search()` 内部。

### 3. patch 语义 —— 两个字段都要写全的原因

**看哪里：** `cordis-plugin-include/lib/index.js` 的 `applyEntryPatches`
**改哪个模块：** `cordis.patch.yml`

patch 遍历器对它找到的每个键做赋值（`target[key] = value`），因此给 `config` 赋值会**整体替换
该对象**：被省略的字段从合成后的行里消失，而不是从基线层保留下来。确认这一点仍然成立——
已验证方式是对基线的 `web` 行直接运行宿主自己的 `applyEntryPatches`，以及
`dsh --profile <p> --dump-config`。若它变成了深合并，`cordis.patch.yml` 里的注释就不再正确；
两种情况下写全两个字段都是对的。

> 正是这个区别让「漏写一个字段」变得危险：丢失显式 pin 会让 seam 退回自动选择，而那里
> 存在第二个可用提供方时给出的是 `WEB_PROVIDER_AMBIGUOUS`，不是用户配置的那个提供方。

### 4. context 服务访问 —— 曾经弄坏过本插件的陷阱

**看哪里：** `cordis/lib/index.js` 的 `ReflectService.handler.get`
**改哪个模块：** `lib/dsh/read-service.js`

context proxy 有两种语义不同的读取方式：

- `ctx.someService` 会**抛出** `cannot get property "x" without inject`，除非读取方 fiber
  在 `inject` 里声明过它；
- `ctx.get('someService')` 则返回 `undefined`。

一切**探测**都必须用反射写法，否则「能力缺失」会被报成「崩了」而不是「缺了哪项能力」。
这一点已在 `lib/dsh/read-service.js` 实现；请确认该陷阱仍然存在，且没有代码重新开始用直接
属性读取。

### 5. 本插件直接构造的回落目标

**看哪里：** `dsh-web-search-deepseek` 与 `dsh-web-fetch-http` 的公开导出。
**改哪个模块：** 搜索回落在 `lib/dsh/fallback.js`；抓取回落届时在 `lib/dsh/` 下新增的适配模块

搜索回落已在 `lib/dsh/fallback.js` 落地：它直接构造 `DeepSeekSearchProvider`，因为回落路径
正是用户关掉本插件后所得到的东西。检查：

- `DeepSeekSearchProvider` 与 `WEB_SEARCH_DEEPSEEK_SETTINGS_NAMESPACE` 仍从该包导出；
- 它的构造签名仍是「接收一个返回选项对象的 thunk」；
- `@deepseek-ai/dsh-credentials` 仍导出 `credentialRef` / `isCredentialRefName`（前者在引用
  不合语法时会抛，因此必须先用后者判断）；
- `@deepseek-ai/dsh-launch-environment` 仍导出 `launchEnvironmentOf`，且快照的 `get(name)`
  仍返回 `{ value, source }`；
- **本插件复刻的官方默认值未变** —— `apiKeyEnv: DEEPSEEK_API_KEY`、
  `baseURL: https://api.deepseek.com/anthropic/v1`、`model: deepseek-v4-flash`、
  `apiVersion: 2023-06-01`、`maxTokens: 4096`、`maxUses: 5`，以及 `DEEPSEEK_SEARCH_BASE_URL`
  这个端点覆盖变量。官方包的 `resolveOptions` 没有导出，所以这些值是抄来的；一旦它们漂移，
  只有「用户什么都没配」那一档会与官方不一致，而那一档本来就会以凭据缺失响亮失败。

抓取接管（ticket `10`）落地后，同样检查 `HttpFetchProvider`、`publicHttpNetwork.resolve`，以及
本插件复刻的抓取限值 —— **`maxResponseBytes: 5_000_000`、`maxBodyChars: 100_000`、
`timeoutMs: 30_000`、`maxRedirects: 5`，以及
`deepseek-harness/0.0.1 (+https://github.com/deepseek-ai)` 这个 user agent。**

### 6. 设置注册

**看哪里：** `dsh-settings` —— 服务上的 `register(ns, schema, options)`，以及读回某个已注册
命名空间的 `get(ns)`。
**改哪个模块：** `lib/dsh/settings.js`

确认这个形状的两半都在：`register` 返回所有者句柄，**服务自身**带有 `get(ns)`。经 `register`
返回的句柄读取看起来等价，其实不是——服务少了 `get` 就是一处需要察觉的宿主形状变化，而本插件
经服务读取，正是为了不让一次重复注册的失败同时弄坏读取。

同时确认重复注册命名空间仍然抛错。本插件**不得**重新注册 `web-search-deepseek`：那个命名空间
属于官方插件，而官方插件必须保持启用，重新注册会抛错。

### 7. 清单字段

**看哪里：** `dsh-package-manifest/lib/types/types.d.ts` 的 `DshManifest` 接口。
**改哪个模块：** `package.json`

检查 `dsh.bundle.patch` / `dsh.client` 是否新增了必填的兄弟字段。客户端那一半对面板 ticket
有影响：`dsh.client` 要求 `exports["./client"]` 存在，且 bundle id 必须等于包名。

### 8. 客户端模块协议（仅面板 ticket）

**看哪里：** `dsh-web-frontend/dist/assets/index-*.js`，搜 `staticModules`。
**改哪个模块：** `lib/client.js`

种子模块表精确列出了零构建 bundle 可以 `require` 哪些说明符。若面板用到的一项被移除，
卡片就会加载失败。slot 契约在
`dsh-client-ui-settings-plugins/lib/types/client/slot-contract.d.ts`；卡片必须用 **`key`**
字段（即设置命名空间）注册，绝不能用 `id` 或 `order`。

## 版本区间

`package.json` → `peerDependencies` 刻意取窄区间：宿主包 `>=0.1.5-rc.2 <0.1.6`，
Cordis `>=4.0.2 <5`。

预览期支持**对未经测试的版本响亮失败，而不是声明一份从未验证过的兼容性。** 当你验证过某个
新版本后，把区间放宽到包含它，并同步更新 README 的已测试版本行——那一行与这张表是同一个
承诺，必须一起改。

放宽时记住两件事：

- 预发布版本只会被点名它的区间匹配。`^0.1.5` **不**匹配 `0.1.5-rc.2`；要写
  `>=0.1.5-rc.2 <0.1.6`，或显式点名该预发布版本。
- `pnpm`（`dsh plugin add` 转发到的就是它）不会自动安装 peer。这里的 peer 区间是文档与
  警告来源，不是安装机制。

## 升级之后

1. `npm test` —— 与宿主零耦合的内核必须**无需任何改动**即保持全绿。
2. 带真实密钥运行 `node test/live/seam-check.mjs` —— 证明 seam 能解析到被 pin 的提供方，
   且一次真实搜索能正确映射回来。
3. 重启 harness，通过界面跑一次真实的 `web_search`，然后逐条走
   `.scratch/dsh-tavily/issues/16-real-machine-e2e-verification.md`。只存在于运行中 harness
   里的行为无法用单测证明，而每次升级都会让上一次的验证结论作废。

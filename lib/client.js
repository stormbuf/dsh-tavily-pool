/**
 * dsh-tavily-pool 的设置卡片，浏览器半边（`PANEL-1`～`PANEL-6`）。
 *
 * **这是一份零构建产物。** 它不经过任何打包器：宿主把本文件当作一个 bundle 直接投给
 * 浏览器，因此这里的形态是硬约束，不是风格选择——
 *
 * - 外壳是 `window.__ModuleLoader__.load({ id, factory })`，`factory` 收到一个
 *   **同步** `require`；
 * - `require` 只能点种子表里的 9 个模块（`react` / `react/jsx-runtime` / `react-dom` /
 *   `react-dom/client` / `@deepseek-ai/cordis` / `dsh-client-store` /
 *   `dsh-client-ui-slots` / `dsh-client-ui-primitives` / `dsh-client-ui-dockkit`）。
 *   本文件只点其中两个：`react` 与 `@deepseek-ai/dsh-client-ui-primitives`。点得越少，
 *   随宿主漂移的面就越小；
 * - **手写 `React.createElement`，没有 JSX**：JSX 需要一次转译，而转译就是构建步骤。
 *
 * `PANEL-3` 允许复用 `@deepseek-ai/dsh-client-ui-primitives` 已导出的基础组件，因此
 * 开关直接用它的 `Switch`（宿主自己的卡片也用它，外观与键盘行为因此天然一致）；**表单
 * 字段与列表控件全部自绘**——文本输入、下拉、按钮、进度条在种子里没有对应原语，而内置
 * 包里的 `ValueField` / `SecretField` 是那个包内的私有实现，第三方 require 不到。
 *
 * 样式用宿主主题的 CSS 变量（`--dsw-alias-*`）并给每一项带一个中性回退值：于是明暗两套
 * 主题下都可读（`PANEL-5`），而变量名若有变动也不会退化成看不见的文字。
 *
 * @module dsh-tavily-pool/client
 */

window.__ModuleLoader__.load({
  id: 'dsh-tavily-pool',
  factory: (require) => {
    const module = { exports: {} };
    const exports = module.exports;
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' });

    const react = require('react');
    const primitives = require('@deepseek-ai/dsh-client-ui-primitives');

    /** 设置命名空间，同时是 slot 的 `key`（`PANEL-1`）——两者必须逐字相同。 */
    const NS = 'dsh-tavily-pool';

    /** 面板 HTTP 接口的路径，与 `lib/dsh/panel-routes.js` 一一对应（`PANEL-4`）。 */
    const ROUTES = Object.freeze({
      state: '/api/tavily-pool.state',
      keys: '/api/tavily-pool.keys',
      settings: '/api/tavily-pool.settings',
      refresh: '/api/tavily-pool.refresh',
      test: '/api/tavily-pool.test',
    });

    /** 与 `lib/settings.js` 的词表一致（`CFG-4`）。这里是展示用的副本，权威在 schema。 */
    const SEARCH_DEPTHS = Object.freeze(['basic', 'advanced', 'fast', 'ultra-fast']);
    const TOPICS = Object.freeze(['general', 'news', 'finance']);
    const EXTRACT_DEPTHS = Object.freeze(['basic', 'advanced']);
    const EXTRACT_FORMATS = Object.freeze(['markdown', 'text']);
    const SCHEDULING_POLICIES = Object.freeze(['balance', 'manual']);
    const MAX_RESULTS_MIN = 1;
    const MAX_RESULTS_MAX = 20;

    /** 中文文案。 */
    const zh = {
      title: 'Tavily 密钥池',
      description: '用 Tavily 承载 web_search：多把密钥、按余额调度、失败自动切换。',
      searchToggle: '接管搜索（web_search）',
      searchToggleHint: '关闭后搜索转交 DSH 官方提供方。改动保存后立即生效，无需重启。',
      fetchToggle: '接管抓取（web_fetch）',
      fetchToggleHint: '关闭后抓取转交 DSH 内置的本地 HTTP 抓取器。与搜索开关互不影响。',
      fetchParams: '抓取参数',
      fetchDepth: '抽取深度',
      fetchDepthHint: '每 5 个成功抽取的 URL 计 1 积分（advanced 计 2）；失败的 URL 不计费。',
      fetchFormat: '返回格式',
      fetchFormatHint: 'markdown 是官方默认；text 会额外增加延迟。',
      schedulingPolicy: '调度策略',
      schedulingPolicyHint: 'balance：剩余额度多的先用，同档轮转。',
      schedulingPolicyManualHint: 'manual：严格按下方密钥池的顺序依次尝试，不参考余额；下方列表的顺序就是调度顺序。',
      manualOrderHint: '当前策略为 manual，因此这个列表的顺序就是调度顺序。',
      params: '搜索参数',
      searchDepth: '搜索深度',
      searchDepthHint: 'advanced 每次计 2 积分，其余三档各 1 积分。',
      maxResults: '结果条数',
      maxResultsHint: `取值 ${MAX_RESULTS_MIN}–${MAX_RESULTS_MAX}。`,
      maxResultsInvalid: `结果条数必须是 ${MAX_RESULTS_MIN}–${MAX_RESULTS_MAX} 之间的整数。`,
      topic: '主题',
      includeAnswer: '生成答案',
      includeAnswerHint: '让 Tavily 额外生成一段答案，作为搜索结果的 content 返回。',
      save: '保存',
      discard: '放弃改动',
      unsaved: '有未保存的改动',
      saved: '已保存',
      fallback: '回落目标',
      fallbackMissing: '凭据未配置。开关关闭后搜索会失败——请先在 Models 页或环境变量里配置官方凭据。',
      fallbackInvalid: '凭据已失效。官方提供方上次拒绝了它（HTTP 401/403），需要换一把。',
      fallbackConfigured: '凭据已配置。',
      fallbackUnknown: '凭据状态未知。',
      keys: '密钥池',
      keyPlaceholder: '粘贴 Tavily API key（tvly-…）',
      labelPlaceholder: '备注（可选）',
      add: '添加',
      empty: '池中还没有密钥。密钥只从本面板添加，插件不读环境变量。',
      refreshAll: '刷新全部余额',
      refreshing: '刷新中…',
      refreshSummary: '{total} 把里已刷新 {ok} 把，{skipped} 把因配额跳过，{failed} 把失败',
      test: '测试连通性',
      testing: '测试中…',
      refresh: '刷新',
      remove: '删除',
      confirmRemove: '再次点击以确认删除',
      rename: '改名',
      renaming: '确定',
      cancel: '取消',
      disabledTag: '已停用',
      invalidTag: '永久失效',
      quotaTag: '额度耗尽',
      coolingTag: '冷却中',
      moveUp: '上移',
      moveDown: '下移',
      balance: '余额',
      balanceUnknown: '未知',
      balanceUnlimited: '无限',
      balanceStale: '读数已陈旧（上次刷新失败）',
      credits: '剩余 {remaining} / {limit} 积分',
      stats: '调用 {calls} · 成功 {successes} · 失败 {failures} · 消耗 {credits} 积分',
      statsPartial: '（其中 {count} 次消耗未知）',
      lastError: '最近错误：{message}',
      lastUsed: '最近使用：{at}',
      lastDuration: '最近耗时：{ms} ms',
      poolError: '密钥池文件不可读：{message}',
      poolErrorPath: '文件：{path}',
      poolErrorFix: '修好或删除该文件即可恢复；在此之前搜索会转交官方提供方。',
      capabilityMissing: '宿主缺少本插件使用的 {count} 项能力：{list}',
      capabilityHint: 'DSH 处于预览期，插件接口会随版本变动；见 docs/dsh-upgrade.md。',
      enable: '启用',
      disable: '停用',
      summarySearchOn: '已接管搜索',
      summarySearchOff: '搜索未接管',
      summaryFetchOn: '已接管抓取',
      summaryFetchOff: '抓取未接管',
      summaryKeys: '{count} 把密钥',
      summaryNoKeys: '尚无密钥',
      expand: '展开',
      collapse: '收起',
      loading: '加载中…',
      retry: '重试',
      panelUnavailable: '面板接口不可用：{message}',
      classificationOk: '可用',
      classificationAuth: '鉴权失败，需要换一把密钥',
      classificationRateLimited: '被上游限流，稍后再试',
      classificationExhausted: '额度耗尽，下月 1 日重置或到 dashboard 提额',
      classificationNetwork: '网络不可达',
      classificationUpstream: '上游故障，稍后再试',
      classificationFatal: '请求被上游拒绝',
      classificationAborted: '已取消',
      classificationQuota: '本机刷新配额已用尽（每 600 秒 10 次），稍后再试',
    };

    /** English copy. */
    const en = {
      title: 'Tavily key pool',
      description: 'Runs web_search through Tavily: multiple keys, balance-aware scheduling, automatic failover.',
      searchToggle: 'Take over search (web_search)',
      searchToggleHint: 'When off, search goes to the DSH official provider. Saving applies immediately; no restart.',
      fetchToggle: 'Take over fetch (web_fetch)',
      fetchToggleHint: "When off, fetching goes to DSH's built-in local HTTP fetcher. Independent of the search toggle.",
      fetchParams: 'Fetch parameters',
      fetchDepth: 'Extraction depth',
      fetchDepthHint: 'Every 5 successful URLs cost 1 credit (advanced costs 2); failed URLs are never charged.',
      fetchFormat: 'Output format',
      fetchFormatHint: 'markdown is the official default; text adds latency.',
      schedulingPolicy: 'Scheduling policy',
      schedulingPolicyHint: 'balance: highest remaining balance first, rotating within a tier.',
      schedulingPolicyManualHint: 'manual: try keys strictly in the order listed below, ignoring balance; that list becomes the scheduling order.',
      manualOrderHint: 'The policy is manual, so this list is the scheduling order.',
      params: 'Search parameters',
      searchDepth: 'Search depth',
      searchDepthHint: 'advanced costs 2 credits per call; the other three cost 1.',
      maxResults: 'Results',
      maxResultsHint: `Between ${MAX_RESULTS_MIN} and ${MAX_RESULTS_MAX}.`,
      maxResultsInvalid: `Results must be an integer between ${MAX_RESULTS_MIN} and ${MAX_RESULTS_MAX}.`,
      topic: 'Topic',
      includeAnswer: 'Generate an answer',
      includeAnswerHint: 'Ask Tavily for a generated answer returned as the result content.',
      save: 'Save',
      discard: 'Discard',
      unsaved: 'Unsaved changes',
      saved: 'Saved',
      fallback: 'Fallback target',
      fallbackMissing: 'Credential not configured. Turning the toggle off will fail — configure the official credential in the Models page or the environment first.',
      fallbackInvalid: 'Credential no longer valid. The official provider rejected it (HTTP 401/403); store a new one.',
      fallbackConfigured: 'Credential configured.',
      fallbackUnknown: 'Credential state unknown.',
      keys: 'Keys',
      keyPlaceholder: 'Paste a Tavily API key (tvly-…)',
      labelPlaceholder: 'Label (optional)',
      add: 'Add',
      empty: 'No keys yet. Keys are added here only; this plugin never reads environment variables.',
      refreshAll: 'Refresh all balances',
      refreshing: 'Refreshing…',
      refreshSummary: '{ok} of {total} refreshed, {skipped} skipped (quota), {failed} failed',
      test: 'Test connectivity',
      testing: 'Testing…',
      refresh: 'Refresh',
      remove: 'Remove',
      confirmRemove: 'Click again to confirm removal',
      rename: 'Rename',
      renaming: 'Apply',
      cancel: 'Cancel',
      disabledTag: 'disabled',
      invalidTag: 'permanently invalid',
      quotaTag: 'quota exhausted',
      coolingTag: 'cooling down',
      moveUp: 'Move up',
      moveDown: 'Move down',
      balance: 'Balance',
      balanceUnknown: 'unknown',
      balanceUnlimited: 'unlimited',
      balanceStale: 'stale reading (the last refresh failed)',
      credits: '{remaining} / {limit} credits left',
      stats: '{calls} calls · {successes} ok · {failures} failed · {credits} credits spent',
      statsPartial: '({count} calls with unknown usage)',
      lastError: 'Last error: {message}',
      lastUsed: 'Last used: {at}',
      lastDuration: 'Last duration: {ms} ms',
      poolError: 'The key pool file could not be read: {message}',
      poolErrorPath: 'File: {path}',
      poolErrorFix: 'Fix or remove that file to recover; until then search falls back to the official provider.',
      capabilityMissing: 'The host is missing {count} capability(ies) this plugin uses: {list}',
      capabilityHint: 'DSH is in preview and its plugin interfaces change between releases; see docs/dsh-upgrade.md.',
      enable: 'Enable',
      disable: 'Disable',
      summarySearchOn: 'search taken over',
      summarySearchOff: 'search off',
      summaryFetchOn: 'fetch taken over',
      summaryFetchOff: 'fetch off',
      summaryKeys: '{count} keys',
      summaryNoKeys: 'no keys yet',
      expand: 'Expand',
      collapse: 'Collapse',
      loading: 'Loading…',
      retry: 'Retry',
      panelUnavailable: 'The panel API is unavailable: {message}',
      classificationOk: 'reachable',
      classificationAuth: 'authentication failed — store a different key',
      classificationRateLimited: 'rate limited upstream — try again later',
      classificationExhausted: 'quota exhausted — resets on the 1st, or raise the limit in the dashboard',
      classificationNetwork: 'network unreachable',
      classificationUpstream: 'upstream failure — try again later',
      classificationFatal: 'the upstream rejected the request',
      classificationAborted: 'cancelled',
      classificationQuota: 'the local refresh quota for this key is exhausted (10 calls per 600s); try again later',
    };

    /** 两套文案。键集必须完全相同，`test/client-card.test.js` 会强制这一点。 */
    const DICTIONARIES = Object.freeze({ zh, en });

    const CSS = `
.dtp-card{border:.5px solid var(--dsw-alias-border-l4,#0000001f);background:var(--dsw-alias-bg-layer-3,transparent);border-radius:16px;list-style:none;transition:border-color .16s,background .16s;color:var(--dsw-alias-label-primary,#1a1a1a)}
.dtp-card:hover{border-color:var(--dsw-alias-label-dimmed,#00000040)}
.dtp-card-open{background:var(--dsw-alias-bg-layer-2,transparent);border-color:var(--dsw-alias-label-dimmed,#00000040)}
.dtp-header{appearance:none;width:100%;font:inherit;color:inherit;text-align:left;cursor:pointer;background:0 0;border:0;border-radius:12px;align-items:center;gap:12px;padding:14px 16px;display:flex}
.dtp-header:focus-visible{outline:2px solid var(--dsw-alias-brand-primary,#3b6cf0);outline-offset:-2px}
.dtp-head-text{flex-direction:column;flex:1;gap:4px;min-width:0;display:flex}
.dtp-name{color:var(--dsw-alias-label-primary,#1a1a1a);font-size:15px;font-weight:600;line-height:1.4}
.dtp-description{color:var(--dsw-alias-label-tertiary,#6b6b6b);font-size:13px;line-height:1.5}
.dtp-summary{color:var(--dsw-alias-label-tertiary,#6b6b6b);font-size:12px;line-height:1.5}
.dtp-chevron{color:var(--dsw-alias-label-tertiary,#6b6b6b);flex:none;transition:transform .16s}
.dtp-chevron-open{transform:rotate(180deg)}
.dtp-pending{flex:none}
.dtp-body{border-top:.5px solid var(--dsw-alias-border-l2,#0000000f);margin:0 16px;padding-bottom:8px}
.dtp-block{flex-direction:column;gap:8px;padding:12px 0;display:flex}
.dtp-block+.dtp-block{border-top:.5px solid var(--dsw-alias-border-l2,#0000000f)}
.dtp-heading{color:var(--dsw-alias-label-primary,#1a1a1a);font-size:13px;font-weight:500;line-height:1.5}
.dtp-row{display:flex;align-items:center;gap:8px;flex-wrap:wrap}
.dtp-grow{flex:1;min-width:0}
.dtp-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(160px,1fr));gap:8px 12px}
.dtp-field{flex-direction:column;gap:6px;display:flex;min-width:0}
.dtp-field-label{min-width:0;color:var(--dsw-alias-label-primary,#1a1a1a);font-size:13px;font-weight:500;line-height:1.5}
.dtp-input,.dtp-select{border:.5px solid var(--dsw-alias-border-l4,#0000001f);background:var(--dsw-alias-bg-layer-3,transparent);height:34px;font:inherit;color:var(--dsw-alias-label-primary,#1a1a1a);border-radius:8px;padding:0 12px;font-size:13px;line-height:1.5;box-sizing:border-box;width:100%;outline:none}
.dtp-input:focus-visible,.dtp-select:focus-visible{border-color:var(--dsw-alias-brand-primary,#3b6cf0)}
.dtp-input:disabled,.dtp-select:disabled{color:var(--dsw-alias-label-tertiary,#6b6b6b);cursor:default;opacity:.6}
.dtp-button{appearance:none;font:inherit;cursor:pointer;border:1px solid var(--dsw-alias-border-l2,#00000014);border-radius:8px;padding:5px 14px;font-size:13px;line-height:1.5;color:var(--dsw-alias-label-secondary,#4a4a4a);background:0 0}
.dtp-button:hover:not(:disabled){color:var(--dsw-alias-label-primary,#1a1a1a);border-color:var(--dsw-alias-label-dimmed,#00000040)}
.dtp-button:disabled{opacity:.4;cursor:default}
.dtp-button-primary{background:var(--dsw-alias-label-primary,#1a1a1a);color:var(--dsw-alias-bg-layer-3,#fff);border-color:transparent}
.dtp-button-primary:hover:not(:disabled){color:var(--dsw-alias-bg-layer-3,#fff);border-color:transparent;opacity:.88}
.dtp-button-danger{color:var(--dsw-alias-label-error,#c62828);border-color:var(--dsw-alias-label-error,#c628284d)}
.dtp-button-danger:hover:not(:disabled){color:var(--dsw-alias-label-error,#c62828);border-color:var(--dsw-alias-label-error,#c62828)}
.dtp-footer{border-top:.5px solid var(--dsw-alias-border-l2,#0000000f);justify-content:flex-end;align-items:center;gap:8px;padding:12px 0 4px;display:flex}
.dtp-list{flex-direction:column;gap:8px;list-style:none;margin:0;padding:0;display:flex}
.dtp-key{flex-direction:column;gap:6px;border:.5px solid var(--dsw-alias-border-l2,#00000014);border-radius:10px;padding:10px 12px;display:flex}
.dtp-key-head{display:flex;align-items:center;gap:8px;flex-wrap:wrap}
.dtp-mask{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:12px}
.dtp-label{color:var(--dsw-alias-label-tertiary,#6b6b6b);font-size:12px;line-height:1.5}
.dtp-tag{color:var(--dsw-alias-label-tertiary,#6b6b6b);border-radius:6px;background:var(--dsw-alias-bg-layer-4,#0000000a);padding:0 6px;font-size:11px;line-height:16px}
.dtp-tag-warn{color:var(--dsw-alias-label-error,#c62828)}
.dtp-bar{border-radius:999px;background:var(--dsw-alias-border-l4,#0000001a);height:6px;overflow:hidden}
.dtp-bar-fill{background:var(--dsw-alias-brand-primary,#3b6cf0);height:100%}
/* 陈旧（USAGE-3）：读数不再可信，因此条本身要看得出来——斜纹底 + 灰色填充，与「余额充足」
   那条实心蓝条一眼可分。只在下面挂一行说明是不够的：进度条是这张卡片上最先被扫到的东西。 */
.dtp-bar-stale{background:repeating-linear-gradient(45deg,var(--dsw-alias-border-l4,#0000001a) 0 4px,transparent 4px 8px)}
.dtp-bar-stale .dtp-bar-fill{background:var(--dsw-alias-label-tertiary,#6b6b6b)}
.dtp-balance{flex-direction:column;gap:4px;display:flex}
.dtp-error{color:var(--dsw-alias-label-error,#c62828);margin:0;font-size:12px;line-height:1.5}
.dtp-meta{color:var(--dsw-alias-label-tertiary,#6b6b6b);margin:0;font-size:12px;line-height:1.5}
.dtp-notice,.dtp-hint{color:var(--dsw-alias-label-tertiary,#6b6b6b);margin:0;font-size:12px;line-height:1.5}
.dtp-actions{display:flex;gap:6px;flex-wrap:wrap}
.dtp-add{display:flex;gap:8px;flex-wrap:wrap}
.dtp-add-key{flex:1 1 220px;min-width:0}
.dtp-add-label{flex:0 1 150px;min-width:0}
.dtp-diagnostics{border-top:.5px solid var(--dsw-alias-border-l2,#0000000f);flex-direction:column;gap:6px;margin:0 16px;padding:10px 0;display:flex}
`.trim();

    // 样式在模块体内注入。client-modules 把 bundle 的执行分成「注册工厂」与「物化」两步，
    // 而物化正是模块体副作用该发生的地方；宿主据此按 `data-plugin-css` 记账，并在卸载时
    // 摘掉它们（见 dsh-client-hmr）。`typeof document` 守卫让本文件也能在 Node 里被加载与
    // 检验——那正是 `test/client-card.test.js` 做的事。
    if (typeof document !== 'undefined' && document.querySelector('style[data-plugin-css="dsh-tavily-pool/card"]') === null) {
      const tag = document.createElement('style');
      tag.dataset.plugin = 'dsh-tavily-pool';
      tag.dataset.pluginCss = 'dsh-tavily-pool/card';
      tag.textContent = CSS;
      document.head.appendChild(tag);
    }

    const h = react.createElement;

    /**
     * 取一个翻译函数。
     *
     * 首选 slot 宿主按 `locale: NS` 传进来的 `props.t`——那是宿主自己的卡片走的路，也是
     * 语言切换能触发重渲染的唯一途径。宿主没传时退到本 bundle 自带的词表，按
     * `navigator.language` 选一套：`PANEL-5` 要求卡片有中英双语，而拿不到 `t` 时让整张
     * 卡片变成一片 `undefined` 是最糟的结果。这一步不碰任何宿主服务，因此不会抛。
     *
     * @param props - 卡片收到的属性。
     * @returns `(key, values?) => string`。
     */
    function translate(props) {
      if (typeof props?.t === 'function') return props.t;
      const language = typeof navigator !== 'undefined' && typeof navigator.language === 'string'
        ? navigator.language.toLowerCase()
        : '';
      const dictionary = language.startsWith('zh') ? zh : en;
      return (key, values) => interpolate(dictionary[key] ?? en[key] ?? key, values);
    }

    /** 把 `{name}` 占位符替换成实参。 */
    function interpolate(template, values) {
      if (values === undefined || values === null) return template;
      return template.replace(/\{(\w+)\}/gu, (whole, name) => (
        Object.hasOwn(values, name) ? String(values[name]) : whole
      ));
    }

    /**
     * 调一次面板接口（`PANEL-4`）。
     *
     * 同源 `fetch`，凭据由宿主在 `/api` 前缀上校验——本文件不碰 token，也不该碰。
     *
     * @param path - 路由路径。
     * @param options - 方法与请求体。
     * @returns 解码后的响应体。
     * @throws {Error} 传输失败或宿主返回了错误信封时抛出。
     */
    async function request(path, { method = 'GET', body } = {}) {
      const response = await fetch(path, {
        method,
        ...body === undefined ? {} : { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) },
      });
      const text = await response.text();
      let decoded;
      try {
        decoded = text.length === 0 ? undefined : JSON.parse(text);
      } catch {
        throw new Error(`${method} ${path} returned HTTP ${String(response.status)} with a non-JSON body`);
      }
      if (!response.ok) {
        throw new Error(decoded?.error?.message ?? `${method} ${path} returned HTTP ${String(response.status)}`);
      }
      return decoded;
    }

    /**
     * 把服务端的设置投影成可编辑的草稿。
     *
     * `maxResults` 在草稿里是**字符串**而不是数字：用户清空输入框、或敲到一半留下 `1`，
     * 都是合法的中间态，把它们强行读成 `NaN` 会让输入框当场跳回旧值。转换发生在保存那
     * 一刻，取值范围也在那里校验——`CFG-4` 的权威始终在宿主的 schema 上，这里只是不让
     * 用户提交一个必然被拒的值。
     *
     * @param settings - `GET state` 返回的设置。
     * @returns 草稿对象。
     */
    function draftOf(settings) {
      return {
        searchEnabled: settings.searchEnabled === true,
        fetchEnabled: settings.fetchEnabled === true,
        searchDepth: settings.searchDepth,
        maxResults: String(settings.maxResults),
        topic: settings.topic,
        includeAnswer: settings.includeAnswer === true,
        fetchDepth: settings.fetchDepth,
        fetchFormat: settings.fetchFormat,
        schedulingPolicy: settings.schedulingPolicy,
      };
    }

    /**
     * 草稿是否与已保存的设置一致。
     *
     * 由 {@link draftOf} 派生，而不是再列一遍字段：两份清单一旦分叉，症状是「改了却显示没有未
     * 保存改动」这类静默错误，而那正是这一处最容易出问题的地方。
     */
    function sameSettings(draft, settings) {
      if (draft === null || settings === null || settings === undefined) return true;
      const saved = draftOf(settings);
      return Object.keys(saved).every((field) => draft[field] === saved[field]);
    }

    /** 草稿里的 `maxResults` 是否落在 schema 允许的区间内。 */
    function maxResultsValid(draft) {
      const text = draft.maxResults.trim();
      const value = Number(text);
      return /^\d+$/u.test(text) && value >= MAX_RESULTS_MIN && value <= MAX_RESULTS_MAX;
    }

    /**
     * 把一次 `/usage` 缓存投影成余额视图（`PANEL-6`）。
     *
     * 三态与 `balanceRank` / `hasPositiveBalance` 是同一套输入，但这里的第三态是**显示**
     * 意义上的：**余额未知时给 `unknown`，绝不画成 0%**。把「没读到」画成一根空进度条等
     * 于告诉用户「这把密钥没量了」，而事实是我们并不知道。
     *
     * @param entry - 密钥记录里的 `usage`。
     * @returns `{ kind, percent, remaining, limit, stale }`。
     */
    function balanceOf(entry) {
      const key = entry?.key;
      if (key === null || typeof key !== 'object') return { kind: 'unknown', percent: null, stale: false };
      if (key.limit === null) return { kind: 'unlimited', percent: null, stale: entry.stale === true };
      const limit = key.limit;
      const used = key.usage;
      if (!Number.isFinite(limit) || !Number.isFinite(used) || limit <= 0) {
        return { kind: 'unknown', percent: null, stale: entry.stale === true };
      }
      const remaining = Math.max(0, limit - used);
      return {
        kind: 'known',
        percent: Math.round((remaining / limit) * 100),
        remaining,
        limit,
        stale: entry.stale === true,
      };
    }

    /** 一把密钥此刻处在哪些非正常状态（`SCHED-3`、`SCHED-8`、`REST-5`）。 */
    function stateTags(t, stats, nowMs) {
      const tags = [];
      if (stats?.permanentlyInvalidAt !== undefined) tags.push(t('invalidTag'));
      if (stats?.quotaExhaustedAt !== undefined) tags.push(t('quotaTag'));
      const cooldownUntil = stats?.cooldownUntil === undefined ? Number.NaN : Date.parse(stats.cooldownUntil);
      if (Number.isFinite(cooldownUntil) && cooldownUntil > nowMs) tags.push(t('coolingTag'));
      return tags;
    }

    /**
     * 分类词到词表键的映射（`12`）。
     *
     * 用一张**显式**的表，而不是把分类词拼成键名：拼装会让键名与算法隐式耦合（改一个分类词
     * 就悄悄换了一个键），而显式表还能让「宿主给了一个我们不认识的分类」退化成显示原词，
     * 而不是显示一个拼出来的键名。
     */
    const CLASSIFICATION_KEYS = Object.freeze({
      ok: 'classificationOk',
      auth: 'classificationAuth',
      'rate-limited': 'classificationRateLimited',
      exhausted: 'classificationExhausted',
      network: 'classificationNetwork',
      upstream: 'classificationUpstream',
      fatal: 'classificationFatal',
      aborted: 'classificationAborted',
      quota: 'classificationQuota',
    });

    /** 一次连通性测试的结论文案；不认识的分类原样显示。 */
    function classificationText(t, classification) {
      const key = CLASSIFICATION_KEYS[classification];
      return key === undefined ? String(classification) : t(key);
    }

    /** 卡片的初始 UI 状态。 */
    const INITIAL_UI = Object.freeze({
      /** `loading` | `ready` | `failed` */
      phase: 'loading',
      state: null,
      error: null,
      /** 卡片是否展开。**默认收起**：宿主自己的卡片都是收起的，展开的卡片在这一页里是异类。 */
      expanded: false,
      /** 正在进行的动作，用于禁用控件并显示进行中的文案。 */
      busy: null,
      /** 一次性提示：保存成功，或某次操作失败的原因。 */
      notice: null,
      /** 每把密钥最近一次连通性测试的结论，按 id 索引。 */
      tests: {},
      /** 正在确认删除的密钥 id：删除不可撤销，因此要点两次。 */
      confirming: null,
      /** 正在改名的密钥 id，以及输入框里那一刻的值。 */
      renaming: null,
      renameText: '',
      newKey: '',
      newLabel: '',
    });

    /**
     * 设置卡片（`PANEL-1`）。
     *
     * 界面状态刻意收在两个 hook 里：`ui`（瞬时状态）与 `draft`（草稿设置）。这样切分不是
     * 为了别的，而是因为**状态越集中，能出错的状态组合越少**——「保存中却允许再次保存」
     * 「加载失败却显示旧列表」这类毛病正是从十个独立 `useState` 之间的不一致里长出来的。
     *
     * 每次改动之后都重新读一遍完整状态（而不是把服务端的返回值手工并进本地副本）：多一次
     * `GET` 换来的是「界面永远等于磁盘上的事实」，而这类卡片出错时最难查的恰恰是本地副本
     * 与真实状态分叉。
     *
     * @param props - slot 宿主传入的属性；`t` 是其中唯一被用到的。
     * @returns 卡片的 React 元素。
     */
    function TavilyPoolCard(props) {
      const t = translate(props);
      const [ui, setUi] = react.useState(INITIAL_UI);
      const [draft, setDraft] = react.useState(null);

      const patch = (changes) => setUi((current) => ({ ...current, ...changes }));

      /** 读一次面板状态；草稿只在还没有草稿时初始化，免得覆盖用户正在编辑的内容。 */
      async function load() {
        try {
          const next = await request(ROUTES.state);
          patch({ phase: 'ready', state: next, error: null });
          setDraft((current) => current ?? draftOf(next.settings));
        } catch (error) {
          patch({ phase: 'failed', error: String(error?.message ?? error) });
        }
      }

      /**
       * 跑一条会改动服务端状态的命令。
       *
       * 失败一律变成一条可读的提示而不是抛出：面板是排障入口，一次失败的删除不该让整张
       * 卡片消失，用户需要看到的是原因。
       *
       * @param label - 忙碌标记；带 id 的形式让「哪一行在忙」看得出来。
       * @param run - 真正的请求。
       * @returns 响应体；失败时返回 `undefined`。
       */
      async function perform(label, run) {
        patch({ busy: label, notice: null });
        try {
          return await run();
        } catch (error) {
          patch({ notice: String(error?.message ?? error) });
          return undefined;
        } finally {
          patch({ busy: null });
        }
      }

      /** 一次改动之后的重新读取。 */
      async function reload() {
        await load();
      }

      react.useEffect(() => {
        void load();
      }, []);

      if (ui.phase === 'loading') {
        return cardShell({ t, ui, patch, summary: t('loading'), body: null, dirty: false });
      }
      if (ui.phase === 'failed') {
        return cardShell({
          t,
          ui,
          patch,
          dirty: false,
          summary: t('panelUnavailable', { message: ui.error }),
          body: h('div', { className: 'dtp-block' },
            h('div', { className: 'dtp-footer' },
              h('button', {
                type: 'button',
                className: 'dtp-button',
                onClick: () => {
                  patch({ phase: 'loading' });
                  void load();
                },
              }, t('retry')))),
        });
      }

      const state = ui.state;
      const settings = state.settings;
      const dirty = !sameSettings(draft, settings);
      const invalid = !maxResultsValid(draft);
      const busy = ui.busy !== null;

      /** 提交草稿里与已保存值不同的字段（`CFG-3`）。 */
      async function save() {
        const next = {};
        if (draft.searchEnabled !== settings.searchEnabled) next.searchEnabled = draft.searchEnabled;
        if (draft.fetchEnabled !== settings.fetchEnabled) next.fetchEnabled = draft.fetchEnabled;
        if (draft.searchDepth !== settings.searchDepth) next.searchDepth = draft.searchDepth;
        if (draft.topic !== settings.topic) next.topic = draft.topic;
        if (draft.includeAnswer !== settings.includeAnswer) next.includeAnswer = draft.includeAnswer;
        if (draft.fetchDepth !== settings.fetchDepth) next.fetchDepth = draft.fetchDepth;
        if (draft.fetchFormat !== settings.fetchFormat) next.fetchFormat = draft.fetchFormat;
        if (draft.schedulingPolicy !== settings.schedulingPolicy) next.schedulingPolicy = draft.schedulingPolicy;
        if (Number(draft.maxResults) !== settings.maxResults) next.maxResults = Number(draft.maxResults);
        if (Object.keys(next).length === 0) return;

        const saved = await perform('save', () => request(ROUTES.settings, { method: 'POST', body: { patch: next } }));
        if (saved === undefined) return;
        // 用宿主解析后的值回填：它是权威，而「我提交了什么」不是。
        //
        // 存成功后收起卡片，与宿主自己的卡片同款：反馈是「未保存」标记消失、卡片收回，而不是
        // 在主体里留一句「已保存」——那句会在下次展开时变成一句过时的陈述。
        patch({ expanded: false, notice: null, state: { ...state, settings: saved.settings } });
        setDraft(draftOf(saved.settings));
      }

      /** 把草稿退回已保存的值。 */
      function discard() {
        setDraft(draftOf(settings));
        patch({ notice: null });
      }

      /** 密钥池的编辑（`POOL-4`）。 */
      async function editKeys(label, body) {
        return perform(label, () => request(ROUTES.keys, { method: 'POST', body }));
      }

      /** 添加一把密钥。明文只在这一趟请求里出现，此后服务端只会回脱敏形式（`POOL-3`）。 */
      async function addKey() {
        const key = ui.newKey.trim();
        if (key.length === 0) return;
        const label = ui.newLabel.trim();
        const result = await editKeys('add', { action: 'add', key, ...label.length === 0 ? {} : { label } });
        if (result === undefined) return;
        patch({ newKey: '', newLabel: '' });
        await reload();
      }

      /** 刷新全部密钥的余额（`USAGE-1`），并如实显示哪些被配额跳过（`USAGE-2`）。 */
      async function refreshAll() {
        const result = await perform('refresh-all', () => request(ROUTES.refresh, { method: 'POST', body: {} }));
        if (result === undefined) return;
        const total = result.results.length;
        const skipped = result.results.filter((entry) => entry.skipped === 'quota').length;
        const failed = result.results.filter((entry) => entry.ok === false && entry.skipped !== 'quota').length;
        // 只在**有**跳过或失败时才提示：全都刷新成功时屏幕上的余额自己就说明了结果，
        // 再补一句「N/N 成功」纯属噪音。
        if (skipped > 0 || failed > 0) {
          patch({ notice: t('refreshSummary', { ok: total - skipped - failed, total, skipped, failed }) });
        }
        await reload();
      }

      /** 刷新一把密钥的余额。 */
      async function refreshOne(id) {
        await perform(`refresh:${id}`, () => request(ROUTES.refresh, { method: 'POST', body: { id } }));
        await reload();
      }

      /** 对一把密钥做连通性测试（`12`）。 */
      async function testOne(id) {
        const result = await perform(`test:${id}`, () => request(ROUTES.test, { method: 'POST', body: { id } }));
        if (result === undefined) return;
        patch({ tests: { ...ui.tests, [id]: result } });
      }

      /** 把一把密钥上移或下移一格。 */
      async function moveKey(id, delta) {
        const ids = state.keys.map((record) => record.id);
        const from = ids.indexOf(id);
        const to = from + delta;
        if (from < 0 || to < 0 || to >= ids.length) return;
        ids.splice(to, 0, ...ids.splice(from, 1));
        if (await editKeys('reorder', { action: 'reorder', ids }) === undefined) return;
        await reload();
      }

      // 摘要行：卡片收起时它是唯一能说明「现在是什么状态」的东西，因此必须带上真正有用的
      // 事实——两个开关各自开没开、池里有几把密钥——而不是重复标题。两个开关各占一格
      // 是因为它们彼此独立（`CFG-2`）：只报搜索那一个，用户就无从知道抓取此刻走的是谁。
      const summary = [
        draft.searchEnabled ? t('summarySearchOn') : t('summarySearchOff'),
        draft.fetchEnabled ? t('summaryFetchOn') : t('summaryFetchOff'),
        state.keys.length === 0 ? t('summaryNoKeys') : t('summaryKeys', { count: state.keys.length }),
      ].join(' · ');

      return cardShell({
        t,
        ui,
        patch,
        dirty,
        summary,
        // 诊断必须**始终可见**：收起状态藏起一条「密钥池文件坏了」比不显示它更糟。
        diagnostics: [poolErrorBlock(t, state.poolError), capabilityBlock(t, state.capabilities)],
        body: h('div', { className: 'dtp-body' },
        h('div', { className: 'dtp-block' },
          h('div', { className: 'dtp-row' },
            h('span', { className: 'dtp-heading dtp-grow' }, t('searchToggle')),
            h(primitives.Switch, {
              checked: draft.searchEnabled,
              label: t('searchToggle'),
              disabled: busy,
              onChange: (next) => setDraft({ ...draft, searchEnabled: next }),
            }),
          ),
          h('p', { className: 'dtp-hint' }, t('searchToggleHint')),
          h('div', { className: 'dtp-row' },
            h('span', { className: 'dtp-heading dtp-grow' }, t('fetchToggle')),
            h(primitives.Switch, {
              checked: draft.fetchEnabled,
              label: t('fetchToggle'),
              disabled: busy,
              onChange: (next) => setDraft({ ...draft, fetchEnabled: next }),
            }),
          ),
          h('p', { className: 'dtp-hint' }, t('fetchToggleHint')),
        ),
        h('div', { className: 'dtp-block' },
          h('span', { className: 'dtp-heading' }, t('params')),
          h('div', { className: 'dtp-grid' },
            field(t('searchDepth'),
              h('select', {
                className: 'dtp-select',
                value: draft.searchDepth,
                disabled: busy,
                onChange: (event) => setDraft({ ...draft, searchDepth: event.target.value }),
              }, SEARCH_DEPTHS.map((value) => h('option', { key: value, value }, value))),
              t('searchDepthHint')),
            field(t('maxResults'),
              h('input', {
                className: 'dtp-input',
                type: 'number',
                min: String(MAX_RESULTS_MIN),
                max: String(MAX_RESULTS_MAX),
                step: '1',
                value: draft.maxResults,
                disabled: busy,
                onChange: (event) => setDraft({ ...draft, maxResults: event.target.value }),
              }),
              invalid ? t('maxResultsInvalid') : t('maxResultsHint'),
              invalid),
            field(t('topic'),
              h('select', {
                className: 'dtp-select',
                value: draft.topic,
                disabled: busy,
                onChange: (event) => setDraft({ ...draft, topic: event.target.value }),
              }, TOPICS.map((value) => h('option', { key: value, value }, value)))),
            field(t('schedulingPolicy'),
              h('select', {
                className: 'dtp-select',
                value: draft.schedulingPolicy,
                disabled: busy,
                onChange: (event) => setDraft({ ...draft, schedulingPolicy: event.target.value }),
              }, SCHEDULING_POLICIES.map((value) => h('option', { key: value, value }, value))),
              draft.schedulingPolicy === 'manual' ? t('schedulingPolicyManualHint') : t('schedulingPolicyHint')),
          ),
          h('div', { className: 'dtp-row' },
            h('span', { className: 'dtp-grow' }, t('includeAnswer')),
            h(primitives.Switch, {
              checked: draft.includeAnswer,
              label: t('includeAnswer'),
              disabled: busy,
              onChange: (next) => setDraft({ ...draft, includeAnswer: next }),
            }),
          ),
          h('p', { className: 'dtp-hint' }, t('includeAnswerHint')),
        ),
        h('div', { className: 'dtp-block' },
          h('span', { className: 'dtp-heading' }, t('fetchParams')),
          h('div', { className: 'dtp-grid' },
            field(t('fetchDepth'),
              h('select', {
                className: 'dtp-select',
                value: draft.fetchDepth,
                disabled: busy,
                onChange: (event) => setDraft({ ...draft, fetchDepth: event.target.value }),
              }, EXTRACT_DEPTHS.map((value) => h('option', { key: value, value }, value))),
              t('fetchDepthHint')),
            field(t('fetchFormat'),
              h('select', {
                className: 'dtp-select',
                value: draft.fetchFormat,
                disabled: busy,
                onChange: (event) => setDraft({ ...draft, fetchFormat: event.target.value }),
              }, EXTRACT_FORMATS.map((value) => h('option', { key: value, value }, value))),
              t('fetchFormatHint')),
          ),
          // 与宿主卡片同款的页脚：说明在前并占满剩余空间，按钮靠右。
          h('div', { className: 'dtp-footer' },
            ui.notice === null ? null : h('span', { className: 'dtp-notice dtp-grow' }, ui.notice),
            dirty ? h('span', { className: 'dtp-notice dtp-grow' }, t('unsaved')) : null,
            h('button', {
              type: 'button',
              className: 'dtp-button',
              disabled: busy || !dirty,
              onClick: discard,
            }, t('discard')),
            h('button', {
              type: 'button',
              className: 'dtp-button dtp-button-primary',
              disabled: busy || !dirty || invalid,
              onClick: () => {
                void save();
              },
            }, t('save')),
          ),
        ),
        fallbackBlock(t, state.fallback),
        keyPoolBlock({
          t,
          ui,
          patch,
          busy,
          // 手动顺序策略下，这份列表的顺序**就是**调度顺序（`SCHED-7`）。把它说清楚是必要
          // 的：在 `balance` 下上下移只是展示偏好，用户没有任何线索知道它换了含义。
          manualOrder: draft.schedulingPolicy === 'manual',
          onAdd: addKey,
          onRefreshAll: refreshAll,
          onRefreshOne: refreshOne,
          onTestOne: testOne,
          onMove: moveKey,
          onEdit: editKeys,
          reload,
        }),
        ),
      });
    }

    /**
     * 卡片外壳：一个可点开的标题行，外加可选的主体（`PANEL-1`）。
     *
     * 形态照抄宿主自己的卡片（`PluginCard`）：`li` + 可点开的 `button` 头部 + 展开时才渲染的
     * 主体。两点是刻意的：
     *
     * - **默认收起。** 设置页里内置的每一张卡片都是收起的；一张常开的卡片在这一页里既突兀
     *   又占地方。收起时摘要行仍要说清「接管开没开、池里有几把密钥」。
     * - **`li` 而不是 `section`。** 这一页把卡片渲染进一个 `ul`，内置卡片返回的就是 `li`。
     *
     * @param props - 卡片外壳的组成。
     * @param props.t - 翻译函数。
     * @param props.ui - 瞬时状态；`expanded` 决定主体是否渲染。
     * @param props.patch - 状态更新函数。
     * @param props.summary - 摘要行文案。
     * @param props.body - 主体；`null` 表示这类状态没有主体可展开。
     * @param props.diagnostics - 始终可见的诊断块。
     * @returns 卡片的 React 元素。
     */
    function cardShell({ t, ui, patch, summary, body, dirty = false, diagnostics = [] }) {
      const expanded = ui.expanded === true && body !== null;
      return h('li', { className: `dtp-card${expanded ? ' dtp-card-open' : ''}` },
        h('button', {
          type: 'button',
          className: 'dtp-header',
          'aria-expanded': expanded,
          'aria-label': `${t(expanded ? 'collapse' : 'expand')}: ${t('title')}`,
          onClick: () => patch({ expanded: !expanded }),
        },
          h('span', { className: 'dtp-head-text' },
            h('span', { className: 'dtp-name' }, t('title')),
            h('span', { className: 'dtp-description' }, t('description')),
            h('span', { className: 'dtp-summary' }, summary),
          ),
          dirty ? h(primitives.Tag, { tone: 'neutral', className: 'dtp-pending' }, t('unsaved')) : null,
          // 箭头用种子模块导出的那个图标——`PANEL-3` 明文允许的就是它。缺了它（预览期宿主
          // 改名）只丢一个箭头，因此退化成文字而不是让整张卡片崩掉。
          typeof primitives.IconChevronDownOutline14 === 'function'
            ? h(primitives.IconChevronDownOutline14, {
              className: `dtp-chevron${expanded ? ' dtp-chevron-open' : ''}`,
            })
            : h('span', { className: `dtp-chevron${expanded ? ' dtp-chevron-open' : ''}` }, '▾'),
        ),
        diagnostics.length === 0 ? null : h('div', { className: 'dtp-diagnostics' }, diagnostics),
        expanded ? body : null,
      );
    }

    /** 一个带标签与提示的表单字段。 */
    function field(label, control, hint, invalid = false) {
      return h('label', { className: 'dtp-field' },
        h('span', { className: 'dtp-field-label' }, label),
        control,
        hint === undefined ? null : h('span', { className: invalid ? 'dtp-error' : 'dtp-hint' }, hint),
      );
    }

    /** 密钥池文件不可读时的报告（`POOL-7`）。 */
    function poolErrorBlock(t, poolError) {
      if (poolError === null || poolError === undefined) return null;
      return h('div', { className: 'dtp-block' },
        h('p', { className: 'dtp-error' }, t('poolError', { message: poolError.message })),
        poolError.path === null ? null : h('p', { className: 'dtp-meta' }, t('poolErrorPath', { path: poolError.path })),
        h('p', { className: 'dtp-meta' }, t('poolErrorFix')),
      );
    }

    /** 宿主能力缺失时的报告（`COMPAT-3`）。 */
    function capabilityBlock(t, capabilities) {
      if (capabilities === undefined || capabilities.ok === true) return null;
      const missing = [...capabilities.missingRequired, ...capabilities.missingOptional];
      if (missing.length === 0) return null;
      return h('div', { className: 'dtp-block' },
        h('p', { className: 'dtp-error' }, t('capabilityMissing', { count: missing.length, list: missing.join(', ') })),
        h('p', { className: 'dtp-meta' }, t('capabilityHint')),
      );
    }

    /** 回落目标当前的两态凭据（`CFG-5`）。 */
    function fallbackBlock(t, fallback) {
      const credential = fallback?.credential;
      const text = credential === 'missing' ? t('fallbackMissing')
        : credential === 'invalid' ? t('fallbackInvalid')
          : credential === 'configured' ? t('fallbackConfigured')
            : t('fallbackUnknown');
      return h('div', { className: 'dtp-block' },
        h('span', { className: 'dtp-heading' }, t('fallback')),
        h('p', { className: credential === 'configured' ? 'dtp-meta' : 'dtp-notice' }, text),
        fallback?.reason === null || fallback?.reason === undefined
          ? null
          : h('p', { className: 'dtp-meta' }, String(fallback.reason)),
      );
    }

    /**
     * 密钥池那一块：添加表单 + 列表 + 批量刷新（`POOL-2`、`POOL-4`、`POOL-5`、`PANEL-6`）。
     *
     * 每一项都带自己的动作，因为它们的作用域不同：测试与刷新只动一把密钥，上移下移改的是
     * 全局顺序，而删除不可撤销——后者因此要点两次。
     */
    function keyPoolBlock(handlers) {
      const { t, ui, patch, busy, onAdd, onRefreshAll } = handlers;
      const keys = ui.state.keys;

      return h('div', { className: 'dtp-block' },
        h('div', { className: 'dtp-row' },
          h('span', { className: 'dtp-heading dtp-grow' }, t('keys')),
          h('button', {
            type: 'button',
            className: 'dtp-button',
            disabled: busy || keys.length === 0,
            onClick: () => {
              void onRefreshAll();
            },
          }, ui.busy === 'refresh-all' ? t('refreshing') : t('refreshAll')),
        ),
        h('div', { className: 'dtp-add' },
          h('input', {
            className: 'dtp-input dtp-add-key',
            type: 'password',
            autoComplete: 'off',
            placeholder: t('keyPlaceholder'),
            value: ui.newKey,
            disabled: busy,
            onChange: (event) => patch({ newKey: event.target.value }),
          }),
          h('input', {
            className: 'dtp-input dtp-add-label',
            type: 'text',
            placeholder: t('labelPlaceholder'),
            value: ui.newLabel,
            disabled: busy,
            onChange: (event) => patch({ newLabel: event.target.value }),
          }),
          h('button', {
            type: 'button',
            className: 'dtp-button dtp-button-primary',
            disabled: busy || ui.newKey.trim().length === 0,
            onClick: () => {
              void onAdd();
            },
          }, t('add')),
        ),
        // 手动顺序策略下，这个列表的顺序就是调度顺序（`SCHED-7`）。这句话只在那种策略下出现：
        // 常显会让 `balance` 的用户以为排序也在起作用。
        handlers.manualOrder ? h('p', { className: 'dtp-hint' }, t('manualOrderHint')) : null,
        keys.length === 0 ? h('p', { className: 'dtp-notice' }, t('empty')) : null,
        h('ul', { className: 'dtp-list' }, keys.map((record) => keyRow({ ...handlers, record }))),
      );
    }

    /** 列表里的一把密钥。 */
    function keyRow(handlers) {
      const { t, ui, patch, busy, record, onEdit, onMove, onRefreshOne, onTestOne, reload } = handlers;
      const stats = record.stats;
      const tags = stateTags(t, stats, Date.now());
      const balance = balanceOf(record.usage);
      const test = ui.tests[record.id];
      const renaming = ui.renaming === record.id;
      const confirmArmed = ui.confirming === record.id;

      /** 一次编辑之后重新读状态；失败时 `onEdit` 已经把原因放进提示里。 */
      const commit = async (label, body) => {
        if (await onEdit(label, body) === undefined) return false;
        await reload();
        return true;
      };

      return h('li', { key: record.id, className: 'dtp-key' },
        h('div', { className: 'dtp-key-head' },
          h(primitives.Switch, {
            checked: record.disabled !== true,
            label: record.disabled === true ? t('enable') : t('disable'),
            disabled: busy,
            onChange: (next) => {
              void commit(`disable:${record.id}`, { action: 'setDisabled', id: record.id, disabled: !next });
            },
          }),
          h('span', { className: 'dtp-mask' }, record.masked),
          record.label.length === 0 ? null : h('span', { className: 'dtp-label' }, record.label),
          record.disabled === true ? h('span', { className: 'dtp-tag' }, t('disabledTag')) : null,
          tags.map((tag) => h('span', { key: tag, className: 'dtp-tag dtp-tag-warn' }, tag)),
        ),
        renaming
          ? h('div', { className: 'dtp-row' },
            h('input', {
              className: 'dtp-input dtp-grow',
              type: 'text',
              value: ui.renameText,
              disabled: busy,
              onChange: (event) => patch({ renameText: event.target.value }),
            }),
            h('button', {
              type: 'button',
              className: 'dtp-button',
              disabled: busy,
              onClick: () => {
                void commit(`rename:${record.id}`, { action: 'rename', id: record.id, label: ui.renameText })
                  .then((done) => (done ? patch({ renaming: null }) : undefined));
              },
            }, t('renaming')),
            h('button', {
              type: 'button',
              className: 'dtp-button',
              disabled: busy,
              onClick: () => patch({ renaming: null }),
            }, t('cancel')),
          )
          : null,
        h('div', { className: 'dtp-balance' },
          h('span', { className: 'dtp-label' },
            balance.kind === 'known' ? t('credits', { remaining: balance.remaining, limit: balance.limit })
              : balance.kind === 'unlimited' ? t('balanceUnlimited') : t('balanceUnknown')),
          balance.percent === null ? null : h('div', {
            className: `dtp-bar${balance.stale ? ' dtp-bar-stale' : ''}`,
          },
          h('div', { className: 'dtp-bar-fill', style: { width: `${String(balance.percent)}%` } })),
          balance.stale ? h('span', { className: 'dtp-error' }, t('balanceStale')) : null,
        ),
        h('span', { className: 'dtp-label' },
          t('stats', {
            calls: stats?.calls ?? 0,
            successes: stats?.successes ?? 0,
            failures: stats?.failures ?? 0,
            credits: stats?.credits ?? 0,
          }),
          (stats?.creditsUnknown ?? 0) > 0 ? ` ${t('statsPartial', { count: stats.creditsUnknown })}` : ''),
        stats?.lastUsedAt === undefined
          ? null
          : h('span', { className: 'dtp-label' }, t('lastUsed', { at: new Date(stats.lastUsedAt).toLocaleString() })),
        Number.isFinite(stats?.lastDurationMs)
          ? h('span', { className: 'dtp-label' }, t('lastDuration', { ms: stats.lastDurationMs }))
          : null,
        stats?.lastError === undefined
          ? null
          : h('span', { className: 'dtp-error' }, t('lastError', { message: stats.lastError.message ?? '' })),
        test === undefined
          ? null
          : h('span', { className: test.ok === true ? 'dtp-label' : 'dtp-error' }, classificationText(t, test.classification)),
        h('div', { className: 'dtp-actions' },
          h('button', {
            type: 'button',
            className: 'dtp-button',
            disabled: busy,
            onClick: () => {
              void onTestOne(record.id);
            },
          }, ui.busy === `test:${record.id}` ? t('testing') : t('test')),
          h('button', {
            type: 'button',
            className: 'dtp-button',
            disabled: busy,
            onClick: () => {
              void onRefreshOne(record.id);
            },
          }, ui.busy === `refresh:${record.id}` ? t('refreshing') : t('refresh')),
          h('button', {
            type: 'button',
            className: 'dtp-button',
            disabled: busy,
            onClick: () => patch({ renaming: record.id, renameText: record.label }),
          }, t('rename')),
          h('button', {
            type: 'button',
            className: 'dtp-button',
            disabled: busy,
            onClick: () => {
              void onMove(record.id, -1);
            },
          }, t('moveUp')),
          h('button', {
            type: 'button',
            className: 'dtp-button',
            disabled: busy,
            onClick: () => {
              void onMove(record.id, 1);
            },
          }, t('moveDown')),
          h('button', {
            type: 'button',
            className: 'dtp-button dtp-button-danger',
            disabled: busy,
            onClick: () => {
              if (!confirmArmed) {
                patch({ confirming: record.id });
                return;
              }
              void commit(`remove:${record.id}`, { action: 'remove', id: record.id })
                .then((done) => (done ? patch({ confirming: null }) : undefined));
            },
          }, confirmArmed ? t('confirmRemove') : t('remove')),
        ),
      );
    }

    /**
     * 卡片挂载时要做的事（`PANEL-1`、`PANEL-5`）。
     *
     * `key` 必须与 settings 命名空间逐字相同：宿主按命名空间派发卡片，两者不一致时卡片
     * **根本不会被渲染**，而且没有任何报错——竞品 `dsh-tavily@0.3.0` 因此出过「整个 Web
     * 卡在 Failed to load plugins」。这正是 `NS` 是一个常量、而不是两处字面量的理由。
     *
     * @param ctx - 浏览器插件的 context。
     */
    function applyCard(ctx) {
      ctx.effect(
        () => ctx.locale.register(NS, DICTIONARIES),
        'dsh-tavily-pool: card dictionaries',
      );
      ctx.slots.inject('settings.plugin.item', () => ctx.slots.register({
        name: 'settings.plugin.item',
        key: NS,
        locale: NS,
      }, TavilyPoolCard));
    }

    exports.apply = applyCard;
    exports.inject = ['slots', 'locale'];
    return module.exports;
  },
});

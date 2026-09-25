/**
 * 回落目标的构造与两态凭据判定（`PIN-3`、`CFG-5`）。
 *
 * 这里对着**真实的** `DeepSeekSearchProvider` 跑，不替身：`CFG-5` 要求区分「凭据未
 * 配置」与「凭据已失效」，而那个区别只能由官方提供方的真实行为划出来——替身会把我们
 * 对它的猜测一并复制过去。
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { describe } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';

import { credentialRef } from '@deepseek-ai/dsh-credentials';
import { launchEnvironmentOf } from '@deepseek-ai/dsh-launch-environment';
import {
  Config as OfficialConfig,
  DEEPSEEK_DEFAULT_BASE_URL,
  WEB_SEARCH_DEEPSEEK_SETTINGS_NAMESPACE,
} from '@deepseek-ai/dsh-web-search-deepseek';

import { apply } from '../index.js';
import {
  FALLBACK_CREDENTIAL_INVALID,
  FALLBACK_CREDENTIAL_MISSING,
  resolveOfficialOptions,
  searchWithOfficialProvider,
} from '../lib/dsh/fallback.js';
import { PANEL_ROUTE_PATHS } from '../lib/dsh/panel-routes.js';

/**
 * 一个只提供指定服务的替身 context。
 *
 * `launchEnvironment` 默认提供一个**空**快照，而且**必须**提供：`launchEnvironmentOf`
 * 在快照缺席时会退回真实的 `process.env`，于是「本机没配 DEEPSEEK_API_KEY」这个环境
 * 偶然事实会变成这些用例的隐含前提——开发机上装了官方凭据，它们就会红。空快照让结果
 * 只取决于测试自己给的东西。需要覆盖环境变量时显式传 `environment`。
 *
 * `agents` 只在显式传入时可见：官方提供方的 `recordRequest` 读的就是它，而「服务缺席
 * 时静默不记」与「读到会话时确实追加」两条都要能测。
 */
function fakeContext({ settings, credentials, environment, agents } = {}) {
  const services = {
    // DSH 0.1.7 起，读别的条目配置的唯一公开途径是 `settings.describe()`：它返回每个有
    // 可编辑字段的条目的已解析配置，`ns` 就是条目 id（不再有 `get(namespace)`）。替身照着
    // 这个形状来，而不是照着我们**以为**的形状来——那正是旧替身盖住 `get` 消失的方式。
    ...settings === undefined ? {} : {
      settings: {
        describe: () => [{ ns: WEB_SEARCH_DEEPSEEK_SETTINGS_NAMESPACE, value: settings }],
      },
    },
    ...credentials === undefined ? {} : { credentials },
    ...agents === undefined ? {} : { agents },
    launchEnvironment: { get: (name) => environment?.(name) },
  };
  return { get: (name) => services[name] };
}

/**
 * 一份官方提供方会当作成功的最小 Messages 响应。
 *
 * 它要求响应里带 `web_search_tool_result` 块——缺了会按 `WEB_PROVIDER_ERROR` 抛错，
 * 因此这条桩件同时也钉住了「我们确实走完了整条回落链路」，而不只是没抛错。
 *
 * @param url - 引用来源的地址。
 * @returns 官方 Messages 响应体。
 */
function officialSuccess(url = 'https://official.example') {
  return {
    content: [
      { type: 'text', text: 'answer', citations: [{ url, cited_text: 'cited' }] },
      { type: 'web_search_tool_result', content: [{ type: 'web_search_result', url, title: 'Official' }] },
    ],
  };
}

describe('resolveOfficialOptions：与官方包同一套优先级', () => {
  test('什么都没配时给出官方默认值', async () => {
    const options = resolveOfficialOptions(fakeContext());

    assert.equal(options.apiKeyEnv, 'DEEPSEEK_API_KEY');
    assert.equal(options.baseURL, 'https://api.deepseek.com/anthropic/v1');
    assert.equal(options.model, 'deepseek-v4-flash');
    assert.equal(options.maxUses, 5);
    assert.equal(await options.resolveApiKey(), undefined);
  });

  test('用户配置压过默认值', () => {
    const options = resolveOfficialOptions(fakeContext({
      settings: { apiKeyEnv: 'MY_KEY', baseURL: 'https://example.test/v1', model: 'custom', maxUses: 2 },
    }));

    assert.equal(options.apiKeyEnv, 'MY_KEY');
    assert.equal(options.baseURL, 'https://example.test/v1');
    assert.equal(options.model, 'custom');
    assert.equal(options.maxUses, 2);
  });

  test('launcher 快照压过 process.env', async () => {
    const options = resolveOfficialOptions(fakeContext({
      environment: (name) => (name === 'DEEPSEEK_API_KEY' ? { value: 'from-snapshot', source: 'user-env' } : undefined),
    }));

    assert.equal(
      await options.resolveApiKey(),
      'from-snapshot',
      '官方提供方读的是 launcher 快照（进程环境 + 项目 .env + home .env 三层合并），因此我们也必须读它',
    );
  });

  test('凭据服务压过环境变量', async () => {
    const options = resolveOfficialOptions(fakeContext({
      credentials: { resolve: async () => ({ value: 'from-credentials' }) },
      environment: () => ({ value: 'from-env' }),
    }));

    assert.equal(await options.resolveApiKey(), 'from-credentials');
  });

  test('settings 服务缺席时不抛错，退到默认值', () => {
    assert.doesNotThrow(() => resolveOfficialOptions(fakeContext()));
  });

  test('apiKeyEnv 不合 credentials 语法时不抛错，按未配置继续', async () => {
    // 用户完全可以把 apiKeyEnv 写成 `MY KEY`。credentials.resolve 收到不合语法的引用
    // 会抛 TypeError，而把一次回落变成插件崩溃是错误的量级。
    const options = resolveOfficialOptions(fakeContext({
      settings: { apiKeyEnv: 'MY KEY' },
      credentials: { resolve: async () => undefined },
    }));

    await assert.doesNotReject(() => options.resolveApiKey());
    assert.equal(await options.resolveApiKey(), undefined);
  });
});

describe('CFG-5：凭据未配置与凭据已失效必须可区分', () => {
  test('没有任何凭据时报「未配置」', async () => {
    const error = await searchWithOfficialProvider({
      ctx: fakeContext(),
      request: { query: 'q' },
    }).catch((thrown) => thrown);

    assert.equal(error.code, FALLBACK_CREDENTIAL_MISSING);
    assert.match(error.message, /not configured/u);
    assert.match(error.message, /DEEPSEEK_API_KEY/u, '要指名缺的是哪个凭据');
  });

  test('凭据配了但上游拒绝时报「已失效」，而不是「未配置」', async () => {
    // 官方提供方用 `globalThis.fetch` 直接发请求，因此桩在全局上——与 `entry.test.js`
    // 对搜索路径的做法一致。桩在这里是必需的而不只是图快：真打网络会让这条断言依赖
    // 一个外部服务是否可达，而它要验证的是**我们**对 401 的分类。
    const original = globalThis.fetch;
    globalThis.fetch = async () => new Response(JSON.stringify({ error: 'authentication_error' }), { status: 401 });
    try {
      const error = await searchWithOfficialProvider({
        ctx: fakeContext({ settings: { apiKey: 'sk-definitely-not-valid' } }),
        request: { query: 'q' },
      }).catch((thrown) => thrown);

      assert.equal(error.code, FALLBACK_CREDENTIAL_INVALID, '配了不能用，与从来没配过是两回事');
      assert.match(error.message, /no longer valid/u);
      assert.match(error.message, /HTTP 401/u);
    } finally {
      globalThis.fetch = original;
    }
  });

  test('非鉴权类失败原样向上，不被误报成凭据问题', async () => {
    // 端点不通、超时、上游 5xx 说的是「这次请求没成功」，不是「这把 key 不能用了」。
    // 把它们算成凭据失效会让用户去换一把本来好好的 key。
    const original = globalThis.fetch;
    globalThis.fetch = async () => new Response(JSON.stringify({ error: 'internal' }), { status: 500 });
    try {
      const error = await searchWithOfficialProvider({
        ctx: fakeContext({ settings: { apiKey: 'sk-x' } }),
        request: { query: 'q' },
      }).catch((thrown) => thrown);

      assert.equal(error.code, 'WEB_PROVIDER_ERROR', '仍按提供方失败上报');
      assert.match(error.message, /HTTP 500/u);
    } finally {
      globalThis.fetch = original;
    }
  });

  test('两个 code 不相同：面板要据它们给出不同的下一步', () => {
    assert.notEqual(FALLBACK_CREDENTIAL_MISSING, FALLBACK_CREDENTIAL_INVALID);
  });
});

describe('回落的成功路径', () => {
  /** 在桩住的 fetch 下跑一次回落。 */
  async function withStubbedFetch(response, run) {
    const original = globalThis.fetch;
    const calls = [];
    globalThis.fetch = async (url, init) => {
      calls.push({ url, body: JSON.parse(init?.body ?? '{}') });
      return new Response(JSON.stringify(response), { status: 200 });
    };
    try {
      return await run(calls);
    } finally {
      globalThis.fetch = original;
    }
  }

  test('返回 seam 形状的结果，而不只是不抛错', async () => {
    // 这条是独立审查点名的缺口：先前所有回落用例都停在失败路径上，成功返回值长什么样
    // **从未被验证过**——而它正是用户关掉开关之后每一次搜索都会拿到的东西。
    const result = await withStubbedFetch(
      officialSuccess(),
      () => searchWithOfficialProvider({
        ctx: fakeContext({ settings: { apiKey: 'sk-literal' } }),
        request: { query: 'hello' },
      }),
    );

    assert.deepEqual(
      result.sources,
      [{ url: 'https://official.example', title: 'Official', snippet: 'cited' }],
      '来源要按 seam 的 WebSearchSource 形状给出，且 snippet 取自 citations',
    );
    assert.equal(result.truncated, false);
  });

  test('请求真的发往官方端点，且带上凭据', async () => {
    const result = await withStubbedFetch(officialSuccess(), (calls) => searchWithOfficialProvider({
      ctx: fakeContext({ settings: { apiKey: 'sk-literal' } }),
      request: { query: 'hello' },
    }).then((value) => ({ value, calls })));

    assert.match(result.calls[0].url, /api\.deepseek\.com\/anthropic\/v1\/messages$/u);
    assert.equal(result.calls[0].body.messages[0].content[0].text.includes('hello'), true, '查询词要进请求体');
  });

  test('取消信号确实交到回落目标手上', async () => {
    // 断言的是「signal 被传下去了」这个事实本身。先前写成「先发请求再 abort」是错的：
    // 桩件立即兑现，abort 落在返回之后，那条断言测不到任何东西。
    const controller = new AbortController();
    const original = globalThis.fetch;
    let seen;
    globalThis.fetch = async (url, init) => {
      seen = init?.signal;
      return new Response(JSON.stringify(officialSuccess()), { status: 200 });
    };
    try {
      await searchWithOfficialProvider({
        ctx: fakeContext({ settings: { apiKey: 'sk-literal' } }),
        request: { query: 'q' },
        signal: controller.signal,
      });
    } finally {
      globalThis.fetch = original;
    }

    assert.notEqual(seen, undefined, '官方提供方要能收到调用方的取消信号');
    assert.equal(seen.aborted, false, '未取消时不该是已中止状态');
  });
});

describe('回落文案必须说清**真正的**起点', () => {
  test('原因来自调用方，不由本模块猜', async () => {
    // 这条压的是一个已经被复现过的缺陷：原因曾在这里写死成「开关关了」，而 `index.js`
    // 另外把真实原因拼在消息前面。于是密钥池文件损坏（开关明明是**开**的）时，用户读到
    // 的是两句话互相矛盾，其中一句还指着一个不需要动的开关。
    const error = await searchWithOfficialProvider({
      ctx: fakeContext(),
      request: { query: 'q' },
      reason: 'the key pool could not be read: keys.json is not valid JSON',
    }).catch((thrown) => thrown);

    assert.equal(error.code, FALLBACK_CREDENTIAL_MISSING);
    assert.match(error.message, /keys\.json is not valid JSON/u, '真实起点必须在文案里');
    assert.doesNotMatch(error.message, /turned off/u, '开关根本没关，不得这么说');
  });

  test('没有给原因时也不编造一个', async () => {
    const error = await searchWithOfficialProvider({
      ctx: fakeContext(),
      request: { query: 'q' },
    }).catch((thrown) => thrown);

    assert.equal(error.code, FALLBACK_CREDENTIAL_MISSING);
    assert.doesNotMatch(error.message, /turned off/u, '不知道原因就不要说一个具体的原因');
    assert.match(error.message, /fallback|fell back/u);
  });

  test('凭据失效那条也带上同一个起点', async () => {
    const original = globalThis.fetch;
    globalThis.fetch = async () => new Response(JSON.stringify({ error: 'auth' }), { status: 401 });
    try {
      const error = await searchWithOfficialProvider({
        ctx: fakeContext({ settings: { apiKey: 'sk-x' } }),
        request: { query: 'q' },
        reason: 'no Tavily key is usable: the pool is empty',
      }).catch((thrown) => thrown);

      assert.equal(error.code, FALLBACK_CREDENTIAL_INVALID);
      assert.match(error.message, /the pool is empty/u, '失效那条同样要说清为什么离开 Tavily');
    } finally {
      globalThis.fetch = original;
    }
  });
});

describe('取消经回落路径向上传递', () => {
  test('调用方已中止时按取消报错，而不是报成凭据问题', async () => {
    const controller = new AbortController();
    controller.abort();

    const error = await searchWithOfficialProvider({
      ctx: fakeContext({ settings: { apiKey: 'sk-x' } }),
      request: { query: 'q' },
      signal: controller.signal,
    }).catch((thrown) => thrown);

    assert.equal(error.code, 'WEB_ABORTED');
  });
});

describe('host-contract-1：回落要复刻官方的会话副作用', () => {
  /** 一个把会话追加记下来的 `agents` 服务替身。 */
  function recordingAgents(appended) {
    return {
      currentInitiator: () => ({
        session: { append: (type, payload) => appended.push({ type, payload }) },
      }),
    };
  }

  /**
   * 在桩住的 fetch 下跑一次回落。
   *
   * @param options - 本次回落。
   * @param options.agents - `agents` 服务替身；省略表示宿主没有这项服务。
   * @returns 会话事件的追加记录。
   */
  async function runFallback({ agents } = {}) {
    const appended = [];
    const original = globalThis.fetch;
    globalThis.fetch = async () => new Response(JSON.stringify(officialSuccess()), { status: 200 });
    try {
      await searchWithOfficialProvider({
        ctx: fakeContext({
          settings: { apiKey: 'sk-literal-test-key' },
          agents: agents?.(appended),
        }),
        request: { query: 'hello' },
      });
    } finally {
      globalThis.fetch = original;
    }
    return appended;
  }

  test('每一次真正发出去的回落搜索都追加 web/deepseek-search-llm-request', async () => {
    // 官方提供方在 fetch **之前**调 `options.recordRequest?.()`，而调用点是可选链：
    // 缺了这个键，一次成功的回落搜索不会在会话里留下任何持久记录，两条路径因此产生
    // 结构不同的会话，而单测与面板都不会有任何异样。
    const appended = await runFallback({ agents: recordingAgents });

    assert.equal(appended.length, 1, '官方会记一次，我们也要记一次');
    assert.equal(appended[0].type, 'web/deepseek-search-llm-request');
    assert.equal(appended[0].payload.endpoint, 'https://api.deepseek.com/anthropic/v1/messages');
    assert.equal(appended[0].payload.apiVersion, '2023-06-01');
    assert.equal(appended[0].payload.body.model, 'deepseek-v4-flash', '事件体要带走这次请求的 body');
    assert.equal(appended[0].payload.body.messages[0].content[0].text.includes('hello'), true);
  });

  test('recordRequest 是 options 上的一个函数，与官方逐字同名', () => {
    const options = resolveOfficialOptions(fakeContext());
    assert.equal(typeof options.recordRequest, 'function');
  });

  test('agents 服务缺席时静默不记，而不是让搜索失败', async () => {
    // `agents` 不在本插件 `inject` 的三项之内，组合完成之前读不到它是正常状态；记录
    // 会话不该有能力让一次搜索失败——官方也是这么写的。
    const appended = await runFallback({ agents: undefined });
    assert.deepEqual(appended, []);
  });
});

describe('host-contract-1：与官方 resolveOptions 的键集对账', () => {
  /** 官方提供方的产物；`resolveOptions` 没有导出，因此从源码里抽。 */
  const OFFICIAL_INDEX_URL = new URL(
    '../node_modules/@deepseek-ai/dsh-web-search-deepseek/lib/index.js',
    import.meta.url,
  );

  /**
   * 从源码里按大括号配平抽出一个函数的全文。
   *
   * @param source - 源码。
   * @param signature - 函数签名，含结尾的 `{`。
   * @returns 函数全文。
   */
  function extractFunction(source, signature) {
    const start = source.indexOf(signature);
    assert.notEqual(start, -1, `官方源码里找不到 ${signature}——上游的写法变了，这条对账要跟着改`);
    let depth = 0;
    for (let index = source.indexOf('{', start); index < source.length; index += 1) {
      if (source[index] === '{') depth += 1;
      else if (source[index] === '}') {
        depth -= 1;
        if (depth === 0) return source.slice(start, index + 1);
      }
    }
    throw new Error(`从 ${signature} 开始的大括号没有配平`);
  }

  /**
   * 用官方源码亲手造一份 options，再读出它的键集。
   *
   * 不是正则去数 `xxx:` 的字面量：官方的对象里有一个条件展开
   * （`...literalApiKey === void 0 ? {} : { apiKey }`），只有真的把它跑起来才知道
   * 键集长什么样。
   *
   * @returns 排好序的键名。
   */
  function officialOptionKeys() {
    const source = readFileSync(OFFICIAL_INDEX_URL, 'utf8');
    const literal = (name) => {
      const matched = new RegExp(`const ${name} = "([^"]+)"`).exec(source);
      assert.notEqual(matched, null, `官方源码里找不到常量 ${name}`);
      return matched[1];
    };
    // eslint-disable-next-line no-new-func -- 在受控作用域里重建官方函数，用的全是官方自己的依赖
    const build = new Function(
      'credentialRef',
      'launchEnvironmentOf',
      'SEARCH_BASE_URL_ENV',
      `${extractFunction(source, 'function resolveOptions(ctx, config) {')}\nreturn resolveOptions;`,
    );
    const resolve = build(
      credentialRef,
      launchEnvironmentOf,
      literal('SEARCH_BASE_URL_ENV'),
    );
    return Object.keys(resolve(fakeContext(), {})).sort();
  }

  test('我们的选项对象与官方逐键相同', () => {
    // 这是一条**对账**而不是一份手抄副本：上游给 `resolveOptions` 加字段时这里会变红，
    // 而不是继续静默漏一次官方的副作用（`recordRequest` 就是这么漏掉的）。
    assert.deepEqual(Object.keys(resolveOfficialOptions(fakeContext())).sort(), officialOptionKeys());
  });

  test('照抄的官方默认值与官方 schema 逐项一致', () => {
    // 官方把 `DEFAULT_API_KEY_ENV` 这类常量收进了 schema 的 `.default()`：0.1.7 的源码里
    // 已经**没有那个标识符**，`resolveOptions` 直接读 `config.apiKeyEnv`。因此「本插件抄的
    // 那份默认值有没有漂移」不能再从源码抽常量来比，而要直接问官方的 schema——这也更接近
    // 事实：loader 解析条目配置时用的就是它。
    const ours = resolveOfficialOptions(fakeContext());

    for (const field of ['apiKeyEnv', 'model', 'apiVersion', 'maxTokens', 'maxUses']) {
      assert.equal(
        ours[field],
        OfficialConfig.dict[field].meta.default,
        `${field} 的默认值与官方 schema 不一致`,
      );
    }
    assert.equal(ours.baseURL, DEEPSEEK_DEFAULT_BASE_URL, 'baseURL 的默认值与官方导出的常量不一致');
  });
});

describe('failure-paths-7：官方凭据状态必须可撤销', () => {
  /**
   * 一个足以让插件经 `apply()` 加载的替身宿主。
   *
   * `inject` 是**异步**的，与真实宿主同形：回调排在 profile 组合完成之后（实测时序见
   * `lib/dsh/host-services.js`），因此用之前必须先 `await delay(0)`。这条用例要走的正是
   * 「服务就绪之后才注册」的那半条路径——面板路由只能在 `connection` 的就绪回调里注册。
   *
   * @returns `{ ctx, registered, routes, warnings, setNamespaceValue }`。
   */
  async function fakeHost() {
    const home = await mkdtemp(join(tmpdir(), 'dsh-tavily-pool-fallback-'));
    const registered = [];
    const routes = new Map();
    const warnings = [];
    const values = {
      // 官方命名空间里的字面凭据：回落要真的走到发请求那一步，而 `credentials` 服务在
      // 这个替身里是缺席的。
      'web-search-deepseek': { apiKey: 'sk-literal-test-key' },
    };

    const services = {
      web: {
        registerSearchProvider(provider) {
          registered.push(provider);
          return () => undefined;
        },
        registerFetchProvider() {
          return () => undefined;
        },
      },
      settings: {
        // 0.1.7 的读取途径：`describe()` 返回每个**有可编辑字段的**条目的已解析配置，
        // `ns` 就是条目 id。替身按这个形状来，而不是按我们以为的形状来。
        describe: () => Object.entries(values).map(([ns, value]) => ({ ns, value })),
        // 写入途径：面板的「保存设置」落在这里；条目 id 同样是入参。
        update: (ns, patch) => {
          values[ns] = { ...values[ns], ...patch };
          return Promise.resolve();
        },
      },
      connection: {
        fetch: {
          register: (spec) => { routes.set(spec.path, spec.fetch); },
        },
      },
      clientModules: {},
      dshHomePath: (...segments) => join(home, ...segments),
      launchEnvironment: { get: () => undefined },
    };

    const ctx = {
      get: (name) => services[name],
      inject: (deps, callback) => {
        if (deps.every((name) => services[name] !== undefined)) setTimeout(() => { callback(ctx); }, 0);
        return { dispose: () => undefined };
      },
      logger: { warn: (message) => warnings.push(String(message)) },
    };

    return {
      ctx,
      registered,
      routes,
      warnings,
      /** 改一个条目的配置值，用来模拟用户在设置页改配置。 */
      setNamespaceValue: (namespace, next) => { values[namespace] = next; },
    };
  }

  /**
   * 读一次面板状态。
   *
   * 面板是用户唯一能看到「凭据需要更换」的地方，因此这条状态机只能从它这一面观察。
   *
   * @param routes - 已注册的路由表。
   * @returns 面板状态对象。
   */
  async function readPanelState(routes) {
    const handler = routes.get(PANEL_ROUTE_PATHS.state);
    assert.notEqual(handler, undefined, 'connection 就绪后面板路由必须已注册');
    const response = await handler(new Request(`http://localhost${PANEL_ROUTE_PATHS.state}`));
    assert.equal(response.status, 200);
    return response.json();
  }

  test('一次 403 之后回落成功，面板不再报告凭据需要更换', async () => {
    const { ctx, registered, routes } = await fakeHost();
    apply(ctx, {});
    await delay(0);

    assert.equal(registered.length, 1, '搜索提供方必须先注册');
    const provider = registered[0];
    const original = globalThis.fetch;
    try {
      // ① 官方以 401 拒绝：这是「凭据已失效」唯一的来源——`available()` 只会说「有值」。
      globalThis.fetch = async () => new Response(JSON.stringify({ error: 'authentication_error' }), { status: 401 });
      const rejected = await provider.search({ query: 'q' }, undefined).catch((thrown) => thrown);
      assert.equal(rejected.code, FALLBACK_CREDENTIAL_INVALID);

      const before = await readPanelState(routes);
      assert.equal(before.fallback.credential, 'invalid', '一次真实的鉴权失败才让面板知道凭据不能用');
      assert.equal(before.fallback.credentialSource, 'last-failure');
      assert.notEqual(before.fallback.lastFailureAt, null);

      // ② 同一把凭据，官方这次接受了它。
      globalThis.fetch = async () => new Response(JSON.stringify(officialSuccess()), { status: 200 });
      const result = await provider.search({ query: 'q' }, undefined);
      assert.equal(result.sources.length, 1, '这一次是真的回落成功了');

      // ③ 面板必须撤销那条结论。留着一个永远不撤的 `invalid`，用户会去换一把其实可用的
      // 凭据，而真正的问题（网络、代理、WAF 的 403）被盖住。
      const after = await readPanelState(routes);
      assert.equal(after.fallback.credential, 'configured', '官方反过来接受了这把凭据，旧结论必须撤销');
      assert.equal(after.fallback.credentialSource, 'probe');
      assert.equal(after.fallback.lastFailureAt, null, '那次失败的时刻也不该继续挂着');
    } finally {
      globalThis.fetch = original;
    }
  });

  test('凭据缺失那一档同样不留痕', async () => {
    const { ctx, registered, routes, setNamespaceValue } = await fakeHost();
    apply(ctx, {});
    await delay(0);

    const original = globalThis.fetch;
    try {
      // 让本机真的没有官方凭据：settings 里的字面 key 抽掉，凭据服务与启动环境都是空的。
      setNamespaceValue('web-search-deepseek', {});
      globalThis.fetch = async () => { throw new Error('不该发出请求'); };

      const provider = registered[0];
      const missing = await provider.search({ query: 'q' }, undefined).catch((thrown) => thrown);
      assert.equal(missing.code, FALLBACK_CREDENTIAL_MISSING);

      const state = await readPanelState(routes);
      assert.equal(state.fallback.credential, 'missing');
      assert.equal(state.fallback.lastFailureAt, null, '`describeOfficialCredential` 对 MISSING 不做保留，这里也不留痕');
    } finally {
      globalThis.fetch = original;
    }
  });
});

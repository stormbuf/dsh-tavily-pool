/**
 * 回落目标的构造与两态凭据判定（`PIN-3`、`CFG-5`）。
 *
 * 这里对着**真实的** `DeepSeekSearchProvider` 跑，不替身：`CFG-5` 要求区分「凭据未
 * 配置」与「凭据已失效」，而那个区别只能由官方提供方的真实行为划出来——替身会把我们
 * 对它的猜测一并复制过去。
 */

import assert from 'node:assert/strict';
import test, { describe } from 'node:test';

import {
  FALLBACK_CREDENTIAL_INVALID,
  FALLBACK_CREDENTIAL_MISSING,
  resolveOfficialOptions,
  searchWithOfficialProvider,
} from '../lib/dsh/fallback.js';

/**
 * 一个只提供指定服务的替身 context。
 *
 * `launchEnvironment` 默认提供一个**空**快照，而且**必须**提供：`launchEnvironmentOf`
 * 在快照缺席时会退回真实的 `process.env`，于是「本机没配 DEEPSEEK_API_KEY」这个环境
 * 偶然事实会变成这些用例的隐含前提——开发机上装了官方凭据，它们就会红。空快照让结果
 * 只取决于测试自己给的东西。需要覆盖环境变量时显式传 `environment`。
 */
function fakeContext({ settings, credentials, environment } = {}) {
  const services = {
    ...settings === undefined ? {} : { settings: { get: () => settings } },
    ...credentials === undefined ? {} : { credentials },
    launchEnvironment: { get: (name) => environment?.(name) },
  };
  return { get: (name) => services[name] };
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
  /**
   * 一份官方提供方会当作成功的最小 Messages 响应。
   *
   * 它要求响应里带 `web_search_tool_result` 块——缺了会按 `WEB_PROVIDER_ERROR` 抛错，
   * 因此这条桩件同时也钉住了「我们确实走完了整条回落链路」，而不只是没抛错。
   */
  function officialSuccess(url = 'https://official.example') {
    return {
      content: [
        { type: 'text', text: 'answer', citations: [{ url, cited_text: 'cited' }] },
        { type: 'web_search_tool_result', content: [{ type: 'web_search_result', url, title: 'Official' }] },
      ],
    };
  }

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

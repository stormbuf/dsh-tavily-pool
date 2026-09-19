/**
 * Tavily 调用内核，针对打桩的 `fetch` 检验。
 *
 * 这些测试 pin 住插件其余部分据以编写的契约：线上实际发出什么、响应如何变成 seam
 * 的词汇、以及失败如何向调用方描述。
 */

import assert from 'node:assert/strict';
import test, { describe } from 'node:test';

import {
  TavilyError,
  extractCreditDelta,
  extractTavily,
  mapSearchResponse,
  searchTavily,
} from '../lib/tavily.js';
import { EXTRACT_FAILURE_STATUS, TAVILY_EXTRACT_URL, TAVILY_SEARCH_URL } from '../lib/constants.js';
import { classifyFailure } from '../lib/health.js';

/**
 * 一个记录自身调用并返回固定响应的 `fetch` 桩件。
 *
 * @param options - 固定响应。
 * @param options.status - HTTP 状态码。
 * @param options.body - 响应体；对象会被 JSON 编码。
 * @param options.headers - 额外的响应头。
 * @param options.failure - 用来代替响应的抛出错误。
 * @returns `{ fetchImpl, calls }`。
 */
function stubFetch({ status = 200, body = {}, headers = {}, failure } = {}) {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, init });
    if (failure !== undefined) throw failure;
    const text = typeof body === 'string' ? body : JSON.stringify(body);
    return new Response(text, { status, headers });
  };
  return { fetchImpl, calls };
}

describe('REST-1/REST-2：请求在线上实际发出的样子', () => {
  test('以 bearer 认证 POST 到搜索端点', async () => {
    const { fetchImpl, calls } = stubFetch({ body: { results: [] } });
    await searchTavily({ apiKey: 'tvly-secret', query: 'hello', fetchImpl });

    assert.equal(calls.length, 1);
    assert.equal(calls[0].url, TAVILY_SEARCH_URL);
    assert.equal(calls[0].init.method, 'POST');
    assert.equal(calls[0].init.headers.authorization, 'Bearer tvly-secret');
  });

  test('总是索取 usage，使记账永远不靠猜', async () => {
    const { fetchImpl, calls } = stubFetch({ body: { results: [] } });
    await searchTavily({ apiKey: 'k', query: 'q', fetchImpl });
    assert.equal(JSON.parse(calls[0].init.body).include_usage, true);
  });

  test('发送已配置的参数，并省略未设置的参数', async () => {
    const { fetchImpl, calls } = stubFetch({ body: { results: [] } });
    await searchTavily({
      apiKey: 'k',
      query: 'q',
      maxResults: 5,
      params: { searchDepth: 'advanced', topic: 'news', includeAnswer: true },
      fetchImpl,
    });
    const body = JSON.parse(calls[0].init.body);
    assert.deepEqual(body, {
      query: 'q',
      search_depth: 'advanced',
      topic: 'news',
      include_answer: true,
      max_results: 5,
      include_usage: true,
    });
  });

  test('调用方未设上限时完全省略 max_results', async () => {
    const { fetchImpl, calls } = stubFetch({ body: { results: [] } });
    await searchTavily({ apiKey: 'k', query: 'q', fetchImpl });
    assert.equal('max_results' in JSON.parse(calls[0].init.body), false);
  });
});

describe('响应映射', () => {
  test('把结果映射为可引用的来源', () => {
    const result = mapSearchResponse({
      answer: 'a generated answer',
      results: [
        { url: 'https://example.com/a', title: 'A', content: 'snippet a', published_date: '2026-01-02' },
        { url: 'https://example.com/b' },
      ],
    });
    assert.equal(result.content, 'a generated answer');
    assert.equal(result.truncated, false, '截断由 seam 负责，不是提供方');
    assert.deepEqual(result.sources, [
      { url: 'https://example.com/a', title: 'A', snippet: 'snippet a', publishedAt: '2026-01-02' },
      { url: 'https://example.com/b' },
    ]);
  });

  test('丢弃无法引用的条目', () => {
    const result = mapSearchResponse({
      results: [{ url: 'https://ok.example' }, { title: 'no url' }, null, { url: '' }],
    });
    assert.deepEqual(result.sources.map((source) => source.url), ['https://ok.example']);
  });

  test('提供方没有返回答案时省略该字段', () => {
    const result = mapSearchResponse({ results: [], answer: null });
    assert.equal('content' in result, false);
  });

  test('完全没有 results 数组的响应也能处理', () => {
    assert.deepEqual(mapSearchResponse({}), { sources: [], truncated: false });
  });

});

describe('失败处理', () => {
  test('上报上游状态码与错误文本', async () => {
    const { fetchImpl } = stubFetch({
      status: 429,
      body: { detail: { error: 'rate limited' } },
    });
    const error = await searchTavily({ apiKey: 'k', query: 'q', fetchImpl }).catch((thrown) => thrown);
    assert.ok(error instanceof TavilyError);
    assert.equal(error.status, 429);
    assert.equal(error.code, 'TAVILY_HTTP_429');
    assert.match(error.message, /rate limited/u);
  });

  test('被拒绝的请求会保留上游状态码与响应体文本', async () => {
    const { fetchImpl } = stubFetch({ status: 400, body: { detail: { error: 'bad topic' } } });
    const error = await searchTavily({ apiKey: 'k', query: 'q', fetchImpl }).catch((thrown) => thrown);
    assert.equal(error.status, 400);
    assert.equal(error.code, 'TAVILY_HTTP_400');
    assert.match(error.message, /bad topic/u);
  });

  test('传输失败被上报为没有上游状态码', async () => {
    const { fetchImpl } = stubFetch({ failure: new TypeError('socket hang up') });
    const error = await searchTavily({ apiKey: 'k', query: 'q', fetchImpl }).catch((thrown) => thrown);
    assert.equal(error.code, 'TAVILY_NETWORK_ERROR');
    assert.equal(error.status, undefined, '没有收到响应，因此没有状态码可上报');
  });

  test('成功但响应体不是 JSON 时会被上报，而不是静默为空', async () => {
    const { fetchImpl } = stubFetch({ body: '<html>not json</html>' });
    const error = await searchTavily({ apiKey: 'k', query: 'q', fetchImpl }).catch((thrown) => thrown);
    assert.equal(error.code, 'TAVILY_UNPROCESSABLE_RESPONSE');
  });

  test('REST-10：失败时保留上游的 request_id', async () => {
    const { fetchImpl } = stubFetch({
      status: 432,
      body: { detail: { error: 'Key limit or Plan Limit exceeded.' }, request_id: 'req-abc-123' },
    });

    const error = await searchTavily({ apiKey: 'k', query: 'q', fetchImpl }).catch((thrown) => thrown);

    assert.equal(error.requestId, 'req-abc-123', '排障时要能直接把它交给 Tavily 支持');
    assert.match(error.message, /req-abc-123/u, '消息里也要带上，否则用户看不到');
  });

  test('上游没给 request_id 时不编造一个', async () => {
    const { fetchImpl } = stubFetch({ status: 500, body: { detail: { error: 'boom' } } });

    const error = await searchTavily({ apiKey: 'k', query: 'q', fetchImpl }).catch((thrown) => thrown);

    assert.equal(error.requestId, undefined);
    assert.doesNotMatch(error.message, /request_id/u);
  });

  test('REST-3：成功时回传 credits，缺失则为 undefined 而不是 0', async () => {
    const withUsage = stubFetch({ body: { results: [], usage: { credits: 2 } } });
    const counted = await searchTavily({ apiKey: 'k', query: 'q', fetchImpl: withUsage.fetchImpl });
    assert.equal(counted.credits, 2);

    const withoutUsage = stubFetch({ body: { results: [] } });
    const unknown = await searchTavily({ apiKey: 'k', query: 'q', fetchImpl: withoutUsage.fetchImpl });
    assert.equal(unknown.credits, undefined, '「不知道消耗了多少」不是「没消耗」');
  });

  test('调用方中止可与超时区分开', async () => {
    const controller = new AbortController();
    controller.abort();
    const { fetchImpl } = stubFetch({ failure: new DOMException('aborted', 'AbortError') });
    const error = await searchTavily({
      apiKey: 'k',
      query: 'q',
      signal: controller.signal,
      fetchImpl,
    }).catch((thrown) => thrown);
    assert.equal(error.code, 'TAVILY_ABORTED');
  });

  test('超时到期被上报为超时', async () => {
    const { fetchImpl } = stubFetch({ failure: new DOMException('timed out', 'TimeoutError') });
    const error = await searchTavily({ apiKey: 'k', query: 'q', fetchImpl }).catch((thrown) => thrown);
    assert.equal(error.code, 'TAVILY_TIMEOUT');
  });
});

describe('REST-9：取消能到达请求本身', () => {
  test('调用方已中止时，交给 fetch 的 signal 也已中止', async () => {
    const controller = new AbortController();
    controller.abort();
    const { fetchImpl, calls } = stubFetch({ body: { results: [] } });
    await searchTavily({ apiKey: 'k', query: 'q', signal: controller.signal, fetchImpl }).catch(() => undefined);
    assert.equal(calls[0].init.signal.aborted, true);
  });
});

describe('FETCH-1：/extract 请求在线上实际发出的样子', () => {
  test('以 bearer 认证 POST 到抽取端点，且只带一个 URL', async () => {
    const { fetchImpl, calls } = stubFetch({ body: { results: [{ url: 'https://example.com', raw_content: '# hi' }] } });
    await extractTavily({ apiKey: 'tvly-secret', url: 'https://example.com', fetchImpl });

    assert.equal(calls.length, 1);
    assert.equal(calls[0].url, TAVILY_EXTRACT_URL);
    assert.equal(calls[0].init.method, 'POST');
    assert.equal(calls[0].init.headers.authorization, 'Bearer tvly-secret');

    // seam 的 `WebFetchRequest` 只有 `url`，因此 `urls` 恒为一个元素的数组——官方 schema
    // 要求它 `minItems: 1`，而这里没有可合并的批量。
    assert.deepEqual(JSON.parse(calls[0].init.body).urls, ['https://example.com']);
  });

  test('抽取深度与返回格式来自设置，并转成上游的参数名', async () => {
    const { fetchImpl, calls } = stubFetch({ body: { results: [] } });
    await extractTavily({
      apiKey: 'k',
      url: 'https://example.com',
      depth: 'advanced',
      format: 'text',
      fetchImpl,
    });

    const body = JSON.parse(calls[0].init.body);
    assert.equal(body.extract_depth, 'advanced');
    assert.equal(body.format, 'text');
  });

  test('省略未配置的可选参数，而不是发一个 undefined 过去', async () => {
    const { fetchImpl, calls } = stubFetch({ body: { results: [] } });
    await extractTavily({ apiKey: 'k', url: 'https://example.com', fetchImpl });

    const body = JSON.parse(calls[0].init.body);
    assert.equal('extract_depth' in body, false);
    assert.equal('format' in body, false);
  });

  test('FETCH-4：timeout 以秒送出，且不超过 20 秒', async () => {
    const { fetchImpl, calls } = stubFetch({ body: { results: [] } });
    await extractTavily({ apiKey: 'k', url: 'https://example.com', fetchImpl, timeoutMs: 20_000 });

    // 官方把 `timeout` 定义成 1.0–60.0 的 float（秒），而我们的内部单位是毫秒。
    assert.equal(JSON.parse(calls[0].init.body).timeout, 20);
  });

  test('总是索取 usage，供对账', async () => {
    const { fetchImpl, calls } = stubFetch({ body: { results: [] } });
    await extractTavily({ apiKey: 'k', url: 'https://example.com', fetchImpl });
    assert.equal(JSON.parse(calls[0].init.body).include_usage, true);
  });
});

describe('FETCH-1：抓取返回纯文本', () => {
  test('成功抽取的内容标成 text，而不是 html', async () => {
    // 硬约束：Tavily 给的已是 markdown，标成 `html` 会被 `dsh-tool-web` 用 turndown
    // 二次转换，内容被结构性破坏。这条断言是那一约束在代码里的唯一守卫。
    const { fetchImpl } = stubFetch({
      body: {
        results: [{ url: 'https://example.com', title: 'Example', raw_content: '# Example Domain\n\n正文' }],
        failed_results: [],
      },
    });

    const outcome = await extractTavily({ apiKey: 'k', url: 'https://example.com', fetchImpl });

    assert.equal(outcome.result.body.kind, 'text');
    assert.equal(outcome.result.body.content, '# Example Domain\n\n正文');
    assert.equal(outcome.result.statusCode, 200);
    assert.equal(outcome.result.truncated, false);
  });

  test('FETCH-2：部分成功时返回成功结果，失败条目不影响它', async () => {
    const { fetchImpl } = stubFetch({
      body: {
        results: [{ url: 'https://ok.example', raw_content: 'good' }],
        failed_results: [{ url: 'https://bad.example', error: 'Failed to fetch url' }],
      },
    });

    const outcome = await extractTavily({ apiKey: 'k', url: 'https://ok.example', fetchImpl });

    assert.equal(outcome.result.statusCode, 200);
    assert.equal(outcome.result.body.content, 'good');
    assert.equal(outcome.successfulUrls, 1);
    assert.equal(outcome.failedUrls, 1);
  });

  test('FETCH-3：全部失败仍返回结果而不是抛错，并带上失败原因', async () => {
    const { fetchImpl } = stubFetch({
      body: { results: [], failed_results: [{ url: 'https://bad.example', error: 'Failed to fetch url' }] },
    });

    const outcome = await extractTavily({ apiKey: 'k', url: 'https://bad.example', fetchImpl });

    assert.equal(outcome.result.statusCode, EXTRACT_FAILURE_STATUS);
    assert.equal(outcome.result.body.kind, 'text');
    assert.match(outcome.result.body.content, /Failed to fetch url/u, '失败原因必须带给模型');
    assert.equal(outcome.result.url, 'https://bad.example');
    assert.equal(outcome.successfulUrls, 0);
  });

  test('200 却没有 results 也没有 failed_results 时也返回结果', async () => {
    // 官方 200 响应的 schema 没有 `required`，因此两个数组都可能缺席。这时仍不该抛错，
    // 只是没有任何原因可说——文案要退到「可能是 JS 渲染或站点拒绝抓取」。
    const { fetchImpl } = stubFetch({ body: { response_time: 0.01 } });
    const outcome = await extractTavily({ apiKey: 'k', url: 'https://example.com', fetchImpl });

    assert.equal(outcome.result.statusCode, EXTRACT_FAILURE_STATUS);
    assert.match(outcome.result.body.content, /JavaScript/u);
  });
});

describe('USAGE-6：抓取按成功 URL 数计费', () => {
  test('累计跨过第 5 个成功 URL 时才记 1 积分（basic）', () => {
    // 官方口径是「Every 5 successful URL extractions cost 1 API credit」——5 是**跨请求累计**
    // 的。因此前四次各记 0，第五次记 1，第六到九次又是 0，第十次再记 1。
    const billed = [];
    for (let call = 1; call <= 10; call += 1) {
      billed.push(extractCreditDelta({ successfulUrls: call - 1, added: 1, depth: 'basic' }));
    }

    assert.deepEqual(billed, [0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);
    assert.equal(billed.reduce((total, value) => total + value, 0), 2, '十次各一个 URL = 2 积分');
  });

  test('一次成功 5 个 URL 记 1 积分（basic）——Gherkin 那条场景', () => {
    assert.equal(extractCreditDelta({ successfulUrls: 0, added: 5, depth: 'basic' }), 1);
    assert.equal(extractCreditDelta({ successfulUrls: 5, added: 5, depth: 'basic' }), 1);
  });

  test('advanced 档每 5 个成功 URL 记 2 积分', () => {
    assert.equal(extractCreditDelta({ successfulUrls: 0, added: 5, depth: 'advanced' }), 2);
    assert.equal(extractCreditDelta({ successfulUrls: 5, added: 5, depth: 'advanced' }), 2);
  });

  test('一次抓取 1 个 URL 记 0 积分——按请求取整会让余额以五倍速度下降', () => {
    // 这条是本票最要紧的一条断言：余额是 `balance` 策略的排序输入，按请求取整（每抓一次记 1）
    // 会让本地读数比官方账单快五倍地掉。
    assert.equal(extractCreditDelta({ successfulUrls: 0, added: 1, depth: 'basic' }), 0);
    assert.equal(extractCreditDelta({ successfulUrls: 3, added: 1, depth: 'basic' }), 0);
  });

  test('抓取失败不计费', async () => {
    assert.equal(extractCreditDelta({ successfulUrls: 4, added: 0, depth: 'basic' }), 0);

    const { fetchImpl } = stubFetch({
      body: { results: [], failed_results: [{ url: 'https://bad.example', error: 'nope' }] },
    });
    const outcome = await extractTavily({ apiKey: 'k', url: 'https://bad.example', fetchImpl });
    assert.equal(outcome.successfulUrls, 0, '内核只如实回报成功数与失败数，积分由累计计数那一层算');
    assert.equal(outcome.failedUrls, 1);
  });

  test('内核不自己算积分——它交回的是「这次成功了几个 URL」', async () => {
    // 计费口径只有一个来源：`lib/health.js` 的 `recordSuccess`（它持有累计计数）。
    // 内核若也算一遍，同一份知识就有两处，而两处迟早会分叉。
    const { fetchImpl } = stubFetch({
      body: { results: [{ url: 'https://example.com', raw_content: 'x' }], failed_results: [] },
    });
    const outcome = await extractTavily({ apiKey: 'k', url: 'https://example.com', fetchImpl });

    assert.equal('credits' in outcome, false);
    assert.equal(outcome.successfulUrls, 1);
  });
});

describe('FETCH-5：/extract 的错误表与 /search 不同', () => {
  test('HTTP 错误带上状态码、上游文本与 request_id', async () => {
    const { fetchImpl } = stubFetch({
      status: 401,
      body: { detail: { error: 'Unauthorized: missing or invalid API key.' }, request_id: 'req-1' },
    });

    const error = await extractTavily({ apiKey: 'k', url: 'https://example.com', fetchImpl }).catch((thrown) => thrown);

    assert.ok(error instanceof TavilyError);
    assert.equal(error.code, 'TAVILY_HTTP_401');
    assert.equal(error.status, 401);
    assert.equal(error.requestId, 'req-1');
  });

  test('400 时带上逐 URL 的失败原因，而不是只说「400」', async () => {
    // `/extract` 的 400 会把原因放在 `detail.failed_results` 里，而 `detailOf` 只看
    // `detail.error` 那一层。少了这一层，用户看到的是一条没有任何线索的 400。
    const { fetchImpl } = stubFetch({
      status: 400,
      body: { detail: { error: 'All URLs failed validation.', failed_results: [{ url: 'nope', error: 'invalid url' }] } },
    });

    const error = await extractTavily({ apiKey: 'k', url: 'nope', fetchImpl }).catch((thrown) => thrown);
    assert.equal(error.status, 400);
    assert.match(error.message, /invalid url/u);
  });

  test('429 原样搬运 Retry-After，由健康状态决定冷却时长', async () => {
    const { fetchImpl } = stubFetch({
      status: 429,
      headers: { 'retry-after': '60' },
      body: { detail: { error: 'rate limited' } },
    });

    const error = await extractTavily({ apiKey: 'k', url: 'https://example.com', fetchImpl }).catch((thrown) => thrown);
    assert.equal(error.retryAfter, '60');
  });

  test('432 / 433 与搜索同名：都表示该密钥额度耗尽', async () => {
    for (const status of [432, 433]) {
      const { fetchImpl } = stubFetch({ status, body: { detail: { error: 'Plan limit exceeded' } } });
      const error = await extractTavily({ apiKey: 'k', url: 'https://example.com', fetchImpl }).catch((thrown) => thrown);
      assert.equal(error.status, status);
      assert.equal(classifyFailure({ status: error.status, detail: error.detail }).action, 'exhausted');
    }
  });

  test('取消与超时在抓取路径上同样可区分', async () => {
    const controller = new AbortController();
    controller.abort();
    const aborted = await extractTavily({
      apiKey: 'k',
      url: 'https://example.com',
      signal: controller.signal,
      fetchImpl: () => Promise.reject(new DOMException('aborted', 'AbortError')),
    }).catch((thrown) => thrown);
    assert.equal(aborted.code, 'TAVILY_ABORTED');

    const timedOut = await extractTavily({
      apiKey: 'k',
      url: 'https://example.com',
      fetchImpl: () => Promise.reject(new DOMException('timed out', 'TimeoutError')),
    }).catch((thrown) => thrown);
    assert.equal(timedOut.code, 'TAVILY_TIMEOUT');
  });

  test('响应体不是 JSON 时按不可解码处理', async () => {
    const { fetchImpl } = stubFetch({ body: '<html>not json</html>' });
    const error = await extractTavily({ apiKey: 'k', url: 'https://example.com', fetchImpl }).catch((thrown) => thrown);
    assert.equal(error.code, 'TAVILY_UNPROCESSABLE_RESPONSE');
  });
});

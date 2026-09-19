/**
 * Tavily 调用内核，针对打桩的 `fetch` 检验。
 *
 * 这些测试 pin 住插件其余部分据以编写的契约：线上实际发出什么、响应如何变成 seam
 * 的词汇、以及失败如何向调用方描述。
 */

import assert from 'node:assert/strict';
import test, { describe } from 'node:test';

import { mapSearchResponse, searchTavily, TavilyError } from '../lib/tavily.js';
import { TAVILY_SEARCH_URL } from '../lib/constants.js';

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

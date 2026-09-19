/**
 * The Tavily call kernel, against a stubbed `fetch`.
 *
 * These tests pin the contract the rest of the plugin is written against: what
 * goes on the wire, how a response becomes seam vocabulary, and how a failure
 * is described to the caller.
 */

import assert from 'node:assert/strict';
import test, { describe } from 'node:test';

import {
  creditsOf,
  mapSearchResponse,
  searchTavily,
  TavilyError,
  validateSearchParams,
} from '../lib/tavily.js';
import { TAVILY_SEARCH_URL } from '../lib/constants.js';

/**
 * A `fetch` stub that records its call and returns a canned response.
 *
 * @param options - the canned response.
 * @param options.status - HTTP status.
 * @param options.body - response body; objects are JSON-encoded.
 * @param options.headers - extra response headers.
 * @param options.failure - an error to throw instead of responding.
 * @returns `{ fetchImpl, calls }`.
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

describe('REST-1/REST-2: the request as it goes on the wire', () => {
  test('posts to the search endpoint with bearer auth', async () => {
    const { fetchImpl, calls } = stubFetch({ body: { results: [] } });
    await searchTavily({ apiKey: 'tvly-secret', query: 'hello', fetchImpl });

    assert.equal(calls.length, 1);
    assert.equal(calls[0].url, TAVILY_SEARCH_URL);
    assert.equal(calls[0].init.method, 'POST');
    assert.equal(calls[0].init.headers.authorization, 'Bearer tvly-secret');
  });

  test('always asks for usage, so accounting is never guessing', async () => {
    const { fetchImpl, calls } = stubFetch({ body: { results: [] } });
    await searchTavily({ apiKey: 'k', query: 'q', fetchImpl });
    assert.equal(JSON.parse(calls[0].init.body).include_usage, true);
  });

  test('sends configured parameters and omits unset ones', async () => {
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

  test('omits max_results entirely when the caller set no bound', async () => {
    const { fetchImpl, calls } = stubFetch({ body: { results: [] } });
    await searchTavily({ apiKey: 'k', query: 'q', fetchImpl });
    assert.equal('max_results' in JSON.parse(calls[0].init.body), false);
  });
});

describe('response mapping', () => {
  test('maps results onto citeable sources', () => {
    const result = mapSearchResponse({
      answer: 'a generated answer',
      results: [
        { url: 'https://example.com/a', title: 'A', content: 'snippet a', published_date: '2026-01-02' },
        { url: 'https://example.com/b' },
      ],
    });
    assert.equal(result.content, 'a generated answer');
    assert.equal(result.truncated, false, 'the seam owns truncation, not the provider');
    assert.deepEqual(result.sources, [
      { url: 'https://example.com/a', title: 'A', snippet: 'snippet a', publishedAt: '2026-01-02' },
      { url: 'https://example.com/b' },
    ]);
  });

  test('drops entries that cannot be cited', () => {
    const result = mapSearchResponse({
      results: [{ url: 'https://ok.example' }, { title: 'no url' }, null, { url: '' }],
    });
    assert.deepEqual(result.sources.map((source) => source.url), ['https://ok.example']);
  });

  test('omits the answer when the provider returned none', () => {
    const result = mapSearchResponse({ results: [], answer: null });
    assert.equal('content' in result, false);
  });

  test('survives a response with no results array at all', () => {
    assert.deepEqual(mapSearchResponse({}), { sources: [], truncated: false });
  });

  test('distinguishes a reported zero from an unreported cost', () => {
    assert.equal(creditsOf({ usage: { credits: 0 } }), 0);
    assert.equal(creditsOf({ usage: { credits: 1 } }), 1);
    assert.equal(creditsOf({}), undefined, 'missing must stay unknown, never zero');
    assert.equal(creditsOf({ usage: {} }), undefined);
  });
});

describe('failure handling', () => {
  test('reports the upstream status and request_id', async () => {
    const { fetchImpl } = stubFetch({
      status: 429,
      headers: { 'retry-after': '120' },
      body: { detail: { error: 'rate limited' }, request_id: 'req-1' },
    });
    const error = await searchTavily({ apiKey: 'k', query: 'q', fetchImpl }).catch((thrown) => thrown);
    assert.ok(error instanceof TavilyError);
    assert.equal(error.status, 429);
    assert.equal(error.requestId, 'req-1');
    assert.equal(error.code, 'TAVILY_HTTP_429');
    assert.match(error.message, /rate limited/);
  });

  test('a malformed request is marked non-retryable', async () => {
    const { fetchImpl } = stubFetch({ status: 400, body: { detail: { error: 'bad topic' } } });
    const error = await searchTavily({ apiKey: 'k', query: 'q', fetchImpl }).catch((thrown) => thrown);
    assert.equal(error.retryable, false);
  });

  test('a transport failure is retryable', async () => {
    const { fetchImpl } = stubFetch({ failure: new TypeError('socket hang up') });
    const error = await searchTavily({ apiKey: 'k', query: 'q', fetchImpl }).catch((thrown) => thrown);
    assert.equal(error.code, 'TAVILY_NETWORK_ERROR');
    assert.equal(error.retryable, true);
  });

  test('a non-JSON success body is reported rather than silently empty', async () => {
    const { fetchImpl } = stubFetch({ body: '<html>not json</html>' });
    const error = await searchTavily({ apiKey: 'k', query: 'q', fetchImpl }).catch((thrown) => thrown);
    assert.equal(error.code, 'TAVILY_UNPROCESSABLE_RESPONSE');
  });

  test('a caller abort is distinguishable from a timeout', async () => {
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
    assert.equal(error.retryable, false);
  });

  test('an expired timeout is reported as a timeout', async () => {
    const { fetchImpl } = stubFetch({ failure: new DOMException('timed out', 'TimeoutError') });
    const error = await searchTavily({ apiKey: 'k', query: 'q', fetchImpl }).catch((thrown) => thrown);
    assert.equal(error.code, 'TAVILY_TIMEOUT');
    assert.equal(error.retryable, true);
  });
});

describe('REST-9: cancellation reaches the request', () => {
  test('the signal handed to fetch is already aborted when the caller aborted', async () => {
    const controller = new AbortController();
    controller.abort();
    const { fetchImpl, calls } = stubFetch({ body: { results: [] } });
    await searchTavily({ apiKey: 'k', query: 'q', signal: controller.signal, fetchImpl }).catch(() => undefined);
    assert.equal(calls[0].init.signal.aborted, true);
  });
});

describe('parameter validation', () => {
  test('accepts the full legal range', () => {
    for (const searchDepth of ['basic', 'advanced', 'fast', 'ultra-fast']) {
      assert.equal(validateSearchParams({ searchDepth }).searchDepth, searchDepth);
    }
    for (const topic of ['general', 'news', 'finance']) {
      assert.equal(validateSearchParams({ topic }).topic, topic);
    }
    for (const maxResults of [0, 20]) {
      assert.equal(validateSearchParams({ maxResults }).maxResults, maxResults);
    }
  });

  test('rejects out-of-range values instead of forwarding them', () => {
    assert.throws(() => validateSearchParams({ maxResults: 21 }), /between 0 and 20/u);
    assert.throws(() => validateSearchParams({ searchDepth: 'deep' }), /unsupported searchDepth/u);
    assert.throws(() => validateSearchParams({ topic: 'sports' }), /unsupported topic/u);
    assert.throws(() => validateSearchParams({ includeAnswer: 'yes' }), /must be a boolean/u);
  });
});

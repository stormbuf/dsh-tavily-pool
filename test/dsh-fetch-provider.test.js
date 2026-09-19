/**
 * 抓取提供方的 seam 映射（`10`）。
 *
 * `lib/dsh/fetch-provider.js` 是抓取路径上唯一碰宿主类型的地方，因此这里**直接针对已安装
 * 的 `@deepseek-ai/dsh-web` 与 `@deepseek-ai/dsh-web-fetch-http` 做断言**——正是 harness
 * 用来做 `instanceof` 检查的那两个类。桩件会让「翻译对了」退化成「我以为翻译对了」。
 */

import assert from 'node:assert/strict';
import test, { describe } from 'node:test';

import { Config } from '@deepseek-ai/dsh-web-fetch-http';
import { WebError } from '@deepseek-ai/dsh-web';
import { HarnessError } from '@deepseek-ai/dsh-llm';

import { TavilyFetchProvider } from '../lib/dsh/fetch-provider.js';
import { officialFetchLimits } from '../lib/dsh/fallback.js';
import { PROVIDER_ID } from '../lib/constants.js';
import { TavilyError } from '../lib/tavily.js';

describe('抓取提供方的可用性与 id', () => {
  test('id 与 profile patch pin 的那个字符串一致', () => {
    assert.equal(new TavilyFetchProvider(() => undefined).id, PROVIDER_ID);
  });

  test('available() 恒为 true——被 pin 的提供方不得自称不可用', () => {
    // profile patch 把 `fetchProvider` 静态 pin 成 `tavily`。一个自称不可用的被 pin 提供方
    // 会让 seam 硬抛 `WEB_PROVIDER_CONFIGURED_UNAVAILABLE`，**不是**回落。因此「开关关了」
    // 之类的判断只能发生在 `fetch()` 里。
    const provider = new TavilyFetchProvider(() => {
      throw new Error('fetch must not be called by available()');
    });
    assert.equal(provider.available(), true);
  });
});

describe('失败以宿主自己的错误类型穿过 seam', () => {
  test('Tavily 失败会变成携带 code、status 与 cause 的 WebError', async () => {
    const cause = new Error('socket hang up');
    const provider = new TavilyFetchProvider(() => Promise.reject(new TavilyError('Tavily extract failed', {
      code: 'TAVILY_HTTP_500',
      status: 500,
      requestId: 'req-fetch-1',
      cause,
    })));

    const thrown = await provider.fetch({ url: 'https://example.com' }).catch((error) => error);

    assert.ok(thrown instanceof WebError, 'harness 只认得它自己的错误类');
    assert.ok(thrown instanceof HarnessError, 'WebError 继承 HarnessError，dsh-tools 读的是后者');
    assert.equal(thrown.code, 'TAVILY_HTTP_500', '上游的机器码必须原样保留');
    assert.equal(thrown.status, 500);
    assert.equal(thrown.requestId, 'req-fetch-1', 'REST-10 要求保留 request_id');
    assert.equal(thrown.cause, cause, '底层失败必须保持可达');
  });

  test('取消被翻译成 seam 自己的中止码', async () => {
    const provider = new TavilyFetchProvider(() => Promise.reject(new TavilyError('aborted', { code: 'TAVILY_ABORTED' })));
    const thrown = await provider.fetch({ url: 'https://example.com' }).catch((error) => error);
    assert.equal(thrown.code, 'WEB_ABORTED', 'TAVILY_ABORTED 不在 seam 的词表里');
  });

  test('非 Tavily 错误原样穿过', async () => {
    const original = new TypeError('something else entirely');
    const provider = new TavilyFetchProvider(() => Promise.reject(original));
    assert.equal(await provider.fetch({ url: 'https://example.com' }).catch((error) => error), original);
  });
});

describe('回落契约：限值逐字段复现官方默认', () => {
  test('照抄的限值与官方包的 Config schema 完全一致', () => {
    // 这是 ticket `10` 的回落契约里唯一可自动化的那一半：「关闭开关后，抓取行为与本机原有
    // 官方实现逐字段一致」。读的是**官方包自己的** schema，因此上游一改默认值它就红。
    const official = Config({});
    assert.deepEqual(officialFetchLimits(), {
      maxResponseBytes: official.maxResponseBytes,
      maxBodyChars: official.maxBodyChars,
      timeoutMs: official.timeoutMs,
      maxRedirects: official.maxRedirects,
      userAgent: official.userAgent,
    });
  });

  test('限值表是冻结的，调用方改不动它', () => {
    // 一份可以被顺手改掉的「官方默认值」等于没有默认值：改动会活到进程结束，而没有任何
    // 迹象说明它偏离了官方。
    const limits = officialFetchLimits();
    limits.timeoutMs = 1;
    assert.equal(officialFetchLimits().timeoutMs, Config({}).timeoutMs);
  });
});

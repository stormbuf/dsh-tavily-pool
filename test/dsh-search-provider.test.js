/**
 * seam 映射，针对宿主真实的 `WebError` 做检验。
 *
 * `lib/dsh/search-provider.js` 是本插件自己的失败词汇变成宿主失败词汇的边界。搞错
 * 它在那些把 seam 打桩的单元测试里是看不见的，因此本文件直接针对已安装的
 * `@deepseek-ai/dsh-web` 里那个类做断言——也正是 harness 在附加结构化失败元数据时
 * 用 `instanceof HarnessError` 检查的那个类。
 */

import assert from 'node:assert/strict';
import test, { describe } from 'node:test';

import { WebError } from '@deepseek-ai/dsh-web';
import { HarnessError } from '@deepseek-ai/dsh-llm';

import { rethrowAsWebError, TavilySearchProvider } from '../lib/dsh/search-provider.js';
import { TavilyError } from '../lib/tavily.js';
import { PROVIDER_ID } from '../lib/constants.js';

describe('失败以宿主自己的错误类型穿过 seam', () => {
  test('Tavily 失败会变成携带 code 与 cause 的 WebError', () => {
    const cause = new Error('socket hang up');
    const original = new TavilyError('Tavily search request failed', {
      code: 'TAVILY_NETWORK_ERROR',
      status: 503,
      cause,
    });

    const thrown = (() => {
      try {
        rethrowAsWebError(original);
        return undefined;
      } catch (error) {
        return error;
      }
    })();

    assert.ok(thrown instanceof WebError, 'harness 只认得它自己的错误类');
    assert.ok(thrown instanceof HarnessError, 'WebError 继承 HarnessError，dsh-tools 读的是后者');
    assert.equal(thrown.code, 'TAVILY_NETWORK_ERROR');
    assert.equal(thrown.cause, cause, '底层失败必须保持可达');
  });

  test('取消被翻译成 seam 自己的中止码', () => {
    const thrown = (() => {
      try {
        rethrowAsWebError(new TavilyError('aborted', { code: 'TAVILY_ABORTED' }));
        return undefined;
      } catch (error) {
        return error;
      }
    })();
    assert.equal(thrown.code, 'WEB_ABORTED', 'TAVILY_ABORTED 不在 seam 的词汇表里');
  });

  test('非 Tavily 错误原样穿过', () => {
    const original = new TypeError('something else entirely');
    const thrown = (() => {
      try {
        rethrowAsWebError(original);
        return undefined;
      } catch (error) {
        return error;
      }
    })();
    assert.equal(thrown, original, '只有我们自己的失败会被改写');
  });

  test('REST-10：上游状态码与 request_id 挂在实例上穿过边界', () => {
    // `WebError` 的构造签名只接 `(message, code, options)`，没有承载上游状态码的形参，
    // 因此结构化保留只能靠自有属性。少了这一步，`REST-10` 的「保留 request_id」就只剩
    // 消息文本里那一份，而消费方读的是字段。
    const thrown = (() => {
      try {
        rethrowAsWebError(new TavilyError('Tavily returned HTTP 401: nope', {
          code: 'TAVILY_HTTP_401',
          status: 401,
          requestId: 'req-abc-123',
        }));
        return undefined;
      } catch (error) {
        return error;
      }
    })();

    assert.equal(thrown.status, 401, '上游状态码必须结构化保留');
    assert.equal(thrown.requestId, 'req-abc-123', 'request_id 必须结构化保留');
    assert.equal(thrown.code, 'TAVILY_HTTP_401', '机器码不得被改写');
  });

  test('没有这些事实时不凭空造字段', () => {
    const thrown = (() => {
      try {
        rethrowAsWebError(new TavilyError('timed out', { code: 'TAVILY_TIMEOUT' }));
        return undefined;
      } catch (error) {
        return error;
      }
    })();

    assert.equal(thrown.status, undefined, '传输层失败没有上游状态码可报');
    assert.equal(thrown.requestId, undefined);
  });
});

describe('seam 据以解析的提供方契约', () => {
  test('它以 profile patch pin 住的 id 注册', () => {
    const provider = new TavilySearchProvider(async () => ({ apiKey: 'k' }));
    assert.equal(provider.id, PROVIDER_ID);
  });

  test('即便什么都没配置，available() 也为 true', () => {
    // 被 pin 住的提供方自称不可用，会硬抛
    // WEB_PROVIDER_CONFIGURED_UNAVAILABLE，因此这里绝不能依赖状态。这个 thunk 会
    // 抛错，而 available() 不得调用它。
    const provider = new TavilySearchProvider(() => {
      throw new Error('the options thunk must not run during available()');
    });
    assert.equal(provider.available(), true);
  });
});

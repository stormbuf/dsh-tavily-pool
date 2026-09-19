/**
 * 搜索参数（`CFG-3`、`CFG-4`）。
 *
 * `searchParamsOf` 与 `effectiveMaxResults` 是纯函数，因此这里直接覆盖；而「改完之后
 * 下一次搜索真的带上了新值」那条链路属于入口，由 `entry.test.js` 压真实往返。
 */

import assert from 'node:assert/strict';
import test, { describe } from 'node:test';

import {
  MAX_RESULTS_MAX,
  MAX_RESULTS_MIN,
  SEARCH_DEPTH_VALUES,
  SEARCH_PARAM_DEFAULTS,
  TOPIC_VALUES,
  effectiveMaxResults,
  readSettings,
  searchParamsOf,
} from '../lib/settings.js';

/** 从一个裸值读出设置。 */
function read(raw) {
  return readSettings({ get: () => raw });
}

describe('CFG-3：搜索参数可配置', () => {
  test('默认值与 Tavily 自己的默认一致', () => {
    assert.deepEqual(read(undefined), {
      searchEnabled: true,
      fetchEnabled: true,
      fetchDepth: 'basic',
      fetchFormat: 'markdown',
      searchDepth: 'basic',
      maxResults: 10,
      topic: 'general',
      includeAnswer: false,
    });
  });

  test('用户取值被原样读出', () => {
    const settings = read({
      searchEnabled: false,
      searchDepth: 'advanced',
      maxResults: 3,
      topic: 'news',
      includeAnswer: true,
    });

    assert.equal(settings.searchDepth, 'advanced');
    assert.equal(settings.maxResults, 3);
    assert.equal(settings.topic, 'news');
    assert.equal(settings.includeAnswer, true);
  });

  test('投影成发给 Tavily 的那三项', () => {
    const params = searchParamsOf(read({ searchDepth: 'fast', topic: 'finance', includeAnswer: true }));

    assert.deepEqual(params, { searchDepth: 'fast', topic: 'finance', includeAnswer: true });
    assert.equal('maxResults' in params, false, 'maxResults 另行折算，不在这里');
  });
});

describe('CFG-4：非法取值退回默认值', () => {
  test('四个 searchDepth 取值全部被接受', () => {
    for (const depth of SEARCH_DEPTH_VALUES) {
      assert.equal(read({ searchDepth: depth }).searchDepth, depth);
    }
  });

  test('三个 topic 取值全部被接受', () => {
    for (const topic of TOPIC_VALUES) {
      assert.equal(read({ topic }).topic, topic);
    }
  });

  test('词表外的枚举退回默认值', () => {
    assert.equal(read({ searchDepth: 'deep' }).searchDepth, SEARCH_PARAM_DEFAULTS.searchDepth);
    assert.equal(read({ topic: 'sports' }).topic, SEARCH_PARAM_DEFAULTS.topic);
    assert.equal(read({ searchDepth: 42 }).searchDepth, SEARCH_PARAM_DEFAULTS.searchDepth);
  });

  test('越界或非整数的 maxResults 退回默认值', () => {
    for (const maxResults of [0, -1, MAX_RESULTS_MAX + 1, 2.5, Number.NaN, '10', null]) {
      assert.equal(
        read({ maxResults }).maxResults,
        SEARCH_PARAM_DEFAULTS.maxResults,
        `${JSON.stringify(maxResults)} 不得原样发给 Tavily：它会被以 400 拒绝，而 400 不重试也不切换密钥`,
      );
    }
  });

  test('区间两端是合法取值', () => {
    assert.equal(read({ maxResults: MAX_RESULTS_MIN }).maxResults, MAX_RESULTS_MIN);
    assert.equal(read({ maxResults: MAX_RESULTS_MAX }).maxResults, MAX_RESULTS_MAX);
  });

  test('下界是 1 而不是官方 OpenAPI 写的 0', () => {
    assert.equal(MAX_RESULTS_MIN, 1, '实测 max_results: 0 被上游以 400 Invalid max results. 拒绝');
  });

  test('非布尔的 includeAnswer 退回默认值', () => {
    assert.equal(read({ includeAnswer: 'yes' }).includeAnswer, false);
  });
});

describe('effectiveMaxResults：用户配置与调用方请求取较小者', () => {
  test('调用方要得更少时听调用方的', () => {
    assert.equal(effectiveMaxResults(20, 5), 5);
  });

  test('调用方要得更多时听用户配置的', () => {
    assert.equal(effectiveMaxResults(3, 20), 3, '配置的语义是「上限」：调大它不会让调用方拿到更多');
  });

  test('调用方没给时按配置值发', () => {
    assert.equal(effectiveMaxResults(7, undefined), 7);
    assert.equal(effectiveMaxResults(7, null), 7);
    assert.equal(effectiveMaxResults(7, 2.5), 7, '非整数不算一个有效的请求上限');
  });
});

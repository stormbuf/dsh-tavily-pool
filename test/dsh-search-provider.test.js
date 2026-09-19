/**
 * The seam mapping, exercised against the host's real `WebError`.
 *
 * `lib/dsh/search-provider.js` is the boundary where this plugin's own failure
 * vocabulary becomes the host's. Getting it wrong is invisible in unit tests
 * that stub the seam, so this file asserts against the installed
 * `@deepseek-ai/dsh-web` class directly — the same one the harness checks with
 * `instanceof HarnessError` when it attaches structured failure metadata.
 */

import assert from 'node:assert/strict';
import test, { describe } from 'node:test';

import { WebError } from '@deepseek-ai/dsh-web';
import { HarnessError } from '@deepseek-ai/dsh-llm';

import { rethrowAsWebError, TavilySearchProvider } from '../lib/dsh/search-provider.js';
import { TavilyError } from '../lib/tavily.js';
import { PROVIDER_ID } from '../lib/constants.js';

describe('failures cross the seam as the host\'s own error type', () => {
  test('a Tavily failure becomes a WebError that carries the code and cause', () => {
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

    assert.ok(thrown instanceof WebError, 'the harness only recognizes its own error class');
    assert.ok(thrown instanceof HarnessError, 'WebError extends HarnessError, which dsh-tools reads');
    assert.equal(thrown.code, 'TAVILY_NETWORK_ERROR');
    assert.equal(thrown.cause, cause, 'the underlying failure must stay reachable');
  });

  test('cancellation is translated to the seam\'s own abort code', () => {
    const thrown = (() => {
      try {
        rethrowAsWebError(new TavilyError('aborted', { code: 'TAVILY_ABORTED' }));
        return undefined;
      } catch (error) {
        return error;
      }
    })();
    assert.equal(thrown.code, 'WEB_ABORTED', 'TAVILY_ABORTED is not in the seam vocabulary');
  });

  test('a non-Tavily error is passed through untouched', () => {
    const original = new TypeError('something else entirely');
    const thrown = (() => {
      try {
        rethrowAsWebError(original);
        return undefined;
      } catch (error) {
        return error;
      }
    })();
    assert.equal(thrown, original, 'only our own failures get rewritten');
  });
});

describe('the provider contract the seam resolves against', () => {
  test('it registers under the id the profile patch pins', () => {
    const provider = new TavilySearchProvider(async () => ({ apiKey: 'k' }));
    assert.equal(provider.id, PROVIDER_ID);
  });

  test('available() is true even when nothing is configured', () => {
    // A pinned provider reporting unavailable is a hard
    // WEB_PROVIDER_CONFIGURED_UNAVAILABLE throw, so this must not depend on
    // state. The thunk throws, and available() must not call it.
    const provider = new TavilySearchProvider(() => {
      throw new Error('the options thunk must not run during available()');
    });
    assert.equal(provider.available(), true);
  });
});

/**
 * 余额三态判定（`SCHED-2`、`SCHED-8`、`PANEL-6`）。
 *
 * 这个模块之所以存在，是因为同一套判定此前有**四个副本**（调度、恢复判定、本地前推、面板
 * 显示），而每一个都把「`key.limit` 为 `null`」读成无限——免费账号的 `key.limit` 恰好也是
 * `null`（ticket `20`）。因此这里逐条钉住判定顺序，尤其是「退回 `account.plan_limit`」
 * 那一步与它**不做**的事（不猜哪几把密钥属于同一个账号）。
 *
 * 一份实测的官方响应长这样（免费账号）：
 *
 * ```json
 * { "key": { "usage": 0, "limit": null }, "account": { "current_plan": "Researcher", "plan_limit": 1000 } }
 * ```
 */

import assert from 'node:assert/strict';
import test, { describe } from 'node:test';

import { BALANCE_KINDS, quotaLimitOf, readBalance } from '../lib/balance.js';

/** 一份免费账号的 `/usage` 响应。 */
function freeAccount({ usage = 0, planLimit = 1000 } = {}) {
  return { key: { usage, limit: null }, account: { current_plan: 'Researcher', plan_usage: usage, plan_limit: planLimit } };
}

describe('quotaLimitOf：上限从哪来', () => {
  test('密钥级上限优先：它比账号套餐更贴近这把密钥', () => {
    assert.equal(quotaLimitOf({ key: { limit: 50, usage: 0 }, account: { plan_limit: 1000 } }), 50);
  });

  test('密钥级为 null 时退回账号套餐上限（ticket 20 的核心）', () => {
    assert.equal(quotaLimitOf(freeAccount()), 1000);
  });

  test('两侧都明确为 null 才是无限', () => {
    assert.equal(quotaLimitOf({ key: { limit: null, usage: 0 }, account: { plan_limit: null } }), null);
  });

  test('形状不认识时是 undefined（未知），不拿账号层的数字去补', () => {
    // `limit` 是字符串说明响应形状已经变了。此时用 `plan_limit` 顶上会掩盖这个问题，
    // 而「以为它用不完」比「以为它没量了」危险得多。
    assert.equal(quotaLimitOf({ key: { limit: '1000', usage: 0 }, account: { plan_limit: 1000 } }), undefined);
    assert.equal(quotaLimitOf({ key: { limit: Number.NaN, usage: 0 }, account: { plan_limit: 1000 } }), undefined);
  });

  test('账号段缺失、或它自己也没有上限字段时读不出来', () => {
    assert.equal(quotaLimitOf({ key: { limit: null, usage: 0 } }), undefined);
    assert.equal(quotaLimitOf({ key: { limit: null, usage: 0 }, account: {} }), undefined);
    assert.equal(quotaLimitOf({ key: { limit: null, usage: 0 }, account: { plan_limit: '1000' } }), undefined);
  });

  test('没有 key 对象、或缓存整个缺席时读不出来', () => {
    assert.equal(quotaLimitOf(undefined), undefined);
    assert.equal(quotaLimitOf({}), undefined);
    assert.equal(quotaLimitOf({ key: null }), undefined);
  });
});

describe('readBalance：三态', () => {
  test('known：上限与用量都读得到，剩余按 0 截断', () => {
    assert.deepEqual(readBalance({ key: { limit: 1000, usage: 250 } }), {
      kind: BALANCE_KINDS.known,
      limit: 1000,
      used: 250,
      remaining: 750,
    });
    assert.equal(readBalance({ key: { limit: 100, usage: 120 } }).remaining, 0, '本地前推越过上限时取 0');
  });

  test('known：免费账号走 account.plan_limit，用量取密钥级的那个', () => {
    assert.deepEqual(readBalance(freeAccount({ usage: 250 })), {
      kind: BALANCE_KINDS.known,
      limit: 1000,
      used: 250,
      remaining: 750,
    });
  });

  test('unlimited：两侧都没有上限', () => {
    assert.deepEqual(readBalance({ key: { limit: null, usage: 9999 }, account: { plan_limit: null } }), {
      kind: BALANCE_KINDS.unlimited,
    });
  });

  test('unknown：缓存缺席、上限读不出来、用量读不出来', () => {
    assert.equal(readBalance(undefined).kind, BALANCE_KINDS.unknown);
    assert.equal(readBalance({ key: { limit: null, usage: 0 } }).kind, BALANCE_KINDS.unknown, '没有 account 段');
    assert.equal(readBalance({ key: { limit: 1000 } }).kind, BALANCE_KINDS.unknown, '有上限但没有用量');
    assert.equal(readBalance({ key: { limit: 1000, usage: '250' } }).kind, BALANCE_KINDS.unknown);
  });

  test('未知与无限是两种不同的结论', () => {
    const unknown = readBalance({ key: { limit: null, usage: 0 } });
    const unlimited = readBalance({ key: { limit: null, usage: 0 }, account: { plan_limit: null } });
    assert.notEqual(unknown.kind, unlimited.kind, '「读不出来」与「用不完」不能合并成一个结论');
  });

  test('不跨密钥推理：一份响应只决定一把密钥的余额', () => {
    // 判定只吃一份 `/usage` 缓存，看不到池里别的密钥，也不去猜哪几把属于同一个账号。
    // 两把各自独立的密钥因此各算各的——这正是「操作对象是密钥而不是账号」的落点。
    const a = readBalance(freeAccount({ usage: 100 }));
    const b = readBalance(freeAccount({ usage: 900 }));
    assert.equal(a.remaining, 900);
    assert.equal(b.remaining, 100);
  });
});

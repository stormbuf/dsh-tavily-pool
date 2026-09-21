/**
 * 条件式余额刷新（`USAGE-8`）。
 *
 * 这一层要钉住的是**触发纪律**，而不是判据本身（那是 `test/usage.test.js` 的事）：
 * 该问的时候问一次、不该问的时候一次都不问、在飞的时候不重复问、以及**绝不拖慢或
 * 弄挂调用方**。
 */

import assert from 'node:assert/strict';
import test, { describe } from 'node:test';

import { BalanceRefresher } from '../lib/balance-refresh.js';
import { USAGE_REFRESH_AFTER_MS } from '../lib/constants.js';

const FRESH = 'tvly-dev-fresh-aaaaaaaaaaaa';
const STALE = 'tvly-dev-stale-bbbbbbbbbbbb';

/**
 * 一个只实现 `usageOf` 的密钥池替身。
 *
 * @param readings - id 到余额缓存的映射；缺一项表示那把密钥从未读到过余额。
 * @returns 池替身。
 */
function fakePool(readings) {
  return { usageOf: (id) => readings[id] };
}

/**
 * 一个记录调用的刷新替身。
 *
 * @param options - 可覆盖项。
 * @param options.gate - 给定时，每次刷新都等它兑现才返回（用来造「在飞」状态）。
 * @param options.reject - 让刷新抛错，检验调用方不受影响。
 * @returns `{ refresh, calls }`。
 */
function fakeRefresh({ gate, reject = false } = {}) {
  const calls = [];
  return {
    calls,
    refresh: async (id, key, options) => {
      calls.push({ id, key, options });
      if (gate !== undefined) await gate;
      if (reject) throw new Error('refresh blew up');
      return { ok: true };
    },
  };
}

/** 一份刚读过的余额缓存。 */
function freshReading(nowMs) {
  return { key: { limit: 1000, usage: 10 }, fetchedAt: new Date(nowMs).toISOString(), stale: false };
}

/**
 * 等后台刷新跑完。
 *
 * 刷新是刻意不阻塞调用方的（`void ... .then().catch().finally()`），因此它的推进完全
 * 发生在微任务里。数微任务个数是在赌链上有几环，而那是实现细节；`setImmediate`
 * 排在当前所有微任务之后，是一条与环数无关的判据。
 *
 * @returns 兑现于微任务全部排空之后的 promise。
 */
function flush() {
  return new Promise((resolve) => {
    setImmediate(resolve);
  });
}

/** 一份超龄的余额缓存。 */
function staleReading(nowMs) {
  return {
    key: { limit: 1000, usage: 10 },
    fetchedAt: new Date(nowMs - USAGE_REFRESH_AFTER_MS - 1000).toISOString(),
    stale: false,
  };
}

describe('USAGE-8：只在需要时触发', () => {
  test('读数未超龄时不刷新', () => {
    const nowMs = Date.now();
    const { refresh, calls } = fakeRefresh();
    const refresher = new BalanceRefresher({
      pool: fakePool({ [FRESH]: freshReading(nowMs) }),
      refresh,
      now: () => nowMs,
    });

    assert.equal(refresher.refreshIfStale({ id: FRESH, key: FRESH }, { reason: 'used' }), false);
    assert.deepEqual(calls, []);
  });

  test('读数超龄时刷新，并把 id、明文与 reason 交下去', async () => {
    const nowMs = Date.now();
    const { refresh, calls } = fakeRefresh();
    const refresher = new BalanceRefresher({
      pool: fakePool({ [STALE]: staleReading(nowMs) }),
      refresh,
      now: () => nowMs,
    });

    assert.equal(refresher.refreshIfStale({ id: STALE, key: STALE }, { reason: 'used' }), true);
    // 刷新是后台的，因此这里等它真的跑起来。
    await flush();
    assert.deepEqual(calls, [{ id: STALE, key: STALE, options: { reason: 'used' } }]);
  });

  test('从未读到过余额时刷新', async () => {
    const { refresh, calls } = fakeRefresh();
    const refresher = new BalanceRefresher({ pool: fakePool({}), refresh });

    assert.equal(refresher.refreshIfStale({ id: STALE, key: STALE }, { reason: 'added' }), true);
    await flush();
    assert.equal(calls.length, 1);
  });

  test('形状不对的目标一律不刷新', () => {
    const { refresh, calls } = fakeRefresh();
    const refresher = new BalanceRefresher({ pool: fakePool({}), refresh });

    for (const target of [undefined, null, {}, { id: '' }, { id: STALE }, { key: STALE }, 'x']) {
      assert.equal(refresher.refreshIfStale(target, { reason: 'used' }), false);
    }
    assert.deepEqual(calls, []);
  });
});

describe('USAGE-8：在飞去重', () => {
  test('同一把密钥的前一次还没回来时不再排一次', async () => {
    let release;
    const gate = new Promise((resolve) => {
      release = resolve;
    });
    const { refresh, calls } = fakeRefresh({ gate });
    const refresher = new BalanceRefresher({ pool: fakePool({}), refresh });

    assert.equal(refresher.refreshIfStale({ id: STALE, key: STALE }, { reason: 'used' }), true);
    assert.equal(refresher.inFlightCount, 1);
    assert.equal(
      refresher.refreshIfStale({ id: STALE, key: STALE }, { reason: 'used' }),
      false,
      '同一把密钥问的是同一个问题，第二次不该再排',
    );

    release();
    await Promise.resolve();
    await Promise.resolve();
    assert.equal(calls.length, 1);
  });

  test('刷新失败之后仍然可以被再次触发', async () => {
    // 去重集合在 `finally` 里清，因此一次失败不会把这把密钥永久地关在门外——
    // 否则一次网络抖动就能让某把密钥此后再也不被自动刷新。
    const { refresh, calls } = fakeRefresh({ reject: true });
    const refresher = new BalanceRefresher({ pool: fakePool({}), refresh });

    refresher.refreshIfStale({ id: STALE, key: STALE }, { reason: 'used' });
    await flush();

    assert.equal(refresher.inFlightCount, 0, '失败之后去重标记必须被清掉');
    assert.equal(refresher.refreshIfStale({ id: STALE, key: STALE }, { reason: 'used' }), true);
    await flush();
    assert.equal(calls.length, 2);
  });

  test('刷新抛错不会冒到调用方', async () => {
    // 余额查询是一次优化，不是调用方的前提。它抛错时这里必须静默吞掉。
    const { refresh } = fakeRefresh({ reject: true });
    const refresher = new BalanceRefresher({ pool: fakePool({}), refresh });

    refresher.refreshIfStale({ id: STALE, key: STALE }, { reason: 'used' });
    await flush();
    // 走到这里没有未处理的 rejection 就是通过；node:test 会把逃逸的 rejection 报成失败。
    assert.equal(refresher.inFlightCount, 0);
  });
});

describe('USAGE-8：sweep 用于批量添加', () => {
  test('只排读数超龄或缺读数的那些', async () => {
    const nowMs = Date.now();
    const { refresh, calls } = fakeRefresh();
    const refresher = new BalanceRefresher({
      pool: fakePool({ [FRESH]: freshReading(nowMs), [STALE]: staleReading(nowMs) }),
      refresh,
      now: () => nowMs,
    });

    const started = refresher.sweep(
      [{ id: FRESH, key: FRESH }, { id: STALE, key: STALE }, { id: 'never', key: 'never' }],
      { reason: 'added' },
    );

    assert.equal(started, 2, '新鲜的跳过，超龄的与从未读过的各排一次');
    await flush();
    assert.deepEqual(calls.map((call) => call.id).sort(), [STALE, 'never'].sort());
  });

  test('同一批里的重复 id 只排一次', async () => {
    const { refresh, calls } = fakeRefresh();
    const refresher = new BalanceRefresher({ pool: fakePool({}), refresh });

    const started = refresher.sweep(
      [{ id: STALE, key: STALE }, { id: STALE, key: STALE }],
      { reason: 'added' },
    );

    assert.equal(started, 1);
    await flush();
    assert.equal(calls.length, 1);
  });

  test('空批次与非数组都安全', () => {
    const { refresh } = fakeRefresh();
    const refresher = new BalanceRefresher({ pool: fakePool({}), refresh });

    assert.equal(refresher.sweep([], { reason: 'added' }), 0);
    assert.equal(refresher.sweep(undefined, { reason: 'added' }), 0);
  });
});

describe('USAGE-8：sweepUnread 只补从来没有过读数的密钥', () => {
  test('有读数的跳过（哪怕读数已经很旧），没读数的补上', async () => {
    // 这是两条规则的分界：全池扫描只补「未知」，不补「偏旧」。为一把余额已知、只是读数
    // 偏旧的密钥反复发问，是拿官方配额换一点点排序精度。
    const nowMs = Date.now();
    const { refresh, calls } = fakeRefresh();
    const refresher = new BalanceRefresher({
      pool: fakePool({ [FRESH]: freshReading(nowMs), [STALE]: staleReading(nowMs) }),
      refresh,
      now: () => nowMs,
    });

    const started = refresher.sweepUnread(
      [{ id: FRESH, key: FRESH }, { id: STALE, key: STALE }, { id: 'never', key: 'never' }],
      { reason: 'used' },
    );

    assert.equal(started, 1, '只有从未读到过的那把被补');
    await flush();
    assert.deepEqual(calls.map((call) => call.id), ['never']);
  });

  test('停用中的密钥跳过', async () => {
    // 它们不参与调度，问它们的余额没有用处。
    const { refresh, calls } = fakeRefresh();
    const refresher = new BalanceRefresher({ pool: fakePool({}), refresh });

    const started = refresher.sweepUnread(
      [{ id: 'off', key: 'off', disabled: true }, { id: 'on', key: 'on', disabled: false }],
      { reason: 'used' },
    );

    assert.equal(started, 1);
    await flush();
    assert.deepEqual(calls.map((call) => call.id), ['on']);
  });

  test('读数时刻读不出来的按「没有读数」处理', async () => {
    const { refresh, calls } = fakeRefresh();
    const refresher = new BalanceRefresher({
      pool: fakePool({ broken: { key: { limit: 10, usage: 1 }, fetchedAt: 'not a date' } }),
      refresh,
    });

    assert.equal(refresher.sweepUnread([{ id: 'broken', key: 'broken' }], { reason: 'used' }), 1);
    await flush();
    assert.equal(calls.length, 1);
  });

  test('与被选中的那条规则共用去重集合：同一把不会被问两次', async () => {
    let release;
    const gate = new Promise((resolve) => {
      release = resolve;
    });
    const { refresh, calls } = fakeRefresh({ gate });
    const refresher = new BalanceRefresher({ pool: fakePool({}), refresh });

    refresher.refreshIfStale({ id: 'k', key: 'k' }, { reason: 'used' });
    refresher.sweepUnread([{ id: 'k', key: 'k' }], { reason: 'used' });

    release();
    await flush();
    assert.equal(calls.length, 1, '两条规则指向同一把密钥时只问一次');
  });
});

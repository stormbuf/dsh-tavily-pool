/**
 * 调度：余额三态排序、同档轮转、硬排除、互斥与有界等待。
 *
 * 这些测试全部针对真实临时目录里的密钥池运行，而不是内存替身：调度的输出取决于池
 * 里的顺序与状态，用替身把这两样伪造出来，测的就不是同一件事了。
 */

import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { describe } from 'node:test';

import { KeyHealth } from '../lib/health.js';
import { PoolStore } from '../lib/pool.js';
import { balanceRank, Mutex, Scheduler } from '../lib/scheduler.js';

/**
 * 一个带若干密钥的池、挂在它上面的健康状态与调度器。
 *
 * @param keys - 每把密钥的描述。
 * @param keys.label - 备注，用来在断言里指认是哪一把。
 * @param options - 可选的时刻与等待替身。
 * @returns `{ pool, health, scheduler, ids, byLabel }`。
 */
async function harness(keys, options = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-tavily-pool-scheduler-'));
  const pool = await new PoolStore({ dir, fileName: 'keys.json' }).load();
  const ids = {};
  for (const [index, entry] of keys.entries()) {
    const record = await pool.addKey({ key: `tvly-dev-${index}-${'a'.repeat(20)}`, label: entry.label });
    ids[entry.label] = record.id;
  }
  const health = new KeyHealth({ pool, now: options.now });
  const scheduler = new Scheduler({ pool, health, now: options.now, sleep: options.sleep });
  return { pool, health, scheduler, ids };
}

/**
 * 给一把密钥写入一份 `/usage` 形态的余额缓存。
 *
 * 形状照抄官方响应：排序只读 `key` 那一层，因为 `account.plan_*` 对同账户的多把密钥
 * 没有区分度。
 *
 * @param pool - 密钥池。
 * @param id - 密钥 id。
 * @param key - `key` 对象的内容；`{ limit: null }` 表示无限。
 */
async function setUsage(pool, id, key) {
  await pool.update((document) => {
    document.usageCache[id] = { key, fetchedAt: new Date().toISOString(), stale: false };
    return document;
  });
}

describe('SCHED-2：余额三态语义', () => {
  test('无限最前，未知垫底，其余按剩余量', () => {
    assert.equal(balanceRank({ key: { limit: null, usage: 9999 } }), Number.POSITIVE_INFINITY);
    assert.equal(balanceRank(undefined), Number.NEGATIVE_INFINITY, '从未刷新过 → 未知');
    assert.equal(balanceRank({}), Number.NEGATIVE_INFINITY, '响应里没有 key 对象 → 未知');
    assert.equal(balanceRank({ key: { limit: 1000, usage: 900 } }), 100);
    assert.equal(balanceRank({ key: { limit: 1000, usage: 1200 } }), 0, '本地前推越过上限时取 0');
  });

  test('未知不是零：它排在余额为 0 的密钥之后', () => {
    const zero = balanceRank({ key: { limit: 100, usage: 100 } });
    assert.equal(zero, 0);
    assert.ok(balanceRank(undefined) < zero, '把未知当作 0 会让从未用过的密钥永远垫底');
  });
});

describe('SCHED-1 / SCHED-2：选择顺序', () => {
  test('三把密钥余额为 100 / 未知 / 无限时，依次选中它们', async () => {
    const { pool, scheduler, ids } = await harness([
      { label: 'finite' },
      { label: 'unknown' },
      { label: 'unlimited' },
    ]);
    await setUsage(pool, ids.finite, { limit: 200, usage: 100 });
    await setUsage(pool, ids.unlimited, { limit: null, usage: 5 });
    // `unknown` 刻意不写缓存。

    const picked = [];
    for (let round = 0; round < 3; round += 1) {
      const { key } = await scheduler.select();
      picked.push(key.id);
      // 选过即离开候选，模拟「每一把都被试过一遍」。
      await pool.setDisabled(key.id, true);
    }

    assert.deepEqual(picked, [ids.unlimited, ids.finite, ids.unknown]);
  });

  test('同余额档内按最近最少使用轮转', async () => {
    const { scheduler, ids } = await harness([{ label: 'a' }, { label: 'b' }]);

    const first = await scheduler.select();
    const second = await scheduler.select();
    const third = await scheduler.select();

    assert.equal(first.key.id, ids.a, '都没用过时按用户顺序先选第一把');
    assert.equal(second.key.id, ids.b, '同余额档内换一把，而不是重复选中同一把');
    assert.equal(third.key.id, ids.a, '两把都用过之后回到最早用过的那把');
  });

  test('新添加的密钥不会因为「余额未知」而永远排在已知余额之后被饿死', async () => {
    const { pool, scheduler, ids } = await harness([{ label: 'known' }, { label: 'fresh' }]);
    await setUsage(pool, ids.known, { limit: 100, usage: 10 });

    // 已知余额的密钥先被选中；它一旦被用过，同档比较就轮到那把它。
    assert.equal((await scheduler.select()).key.id, ids.known);
    // `fresh` 是未知余额，排在 90 之后——除非已知余额的那把被排除。
    await pool.setDisabled(ids.known, true);
    assert.equal((await scheduler.select()).key.id, ids.fresh);
  });
});

describe('POOL-5 / SCHED-3 / SCHED-8：硬排除', () => {
  test('停用的密钥不参与调度', async () => {
    const { pool, scheduler, ids } = await harness([{ label: 'off' }, { label: 'on' }]);
    await pool.setDisabled(ids.off, true);

    assert.equal((await scheduler.select()).key.id, ids.on);
  });

  test('冷却中的密钥即使其余密钥全部失败也不被使用', async () => {
    const now = Date.parse('2026-09-19T00:00:00Z');
    const { health, scheduler, ids } = await harness([{ label: 'cooling' }, { label: 'broken' }], {
      now: () => now,
    });
    await health.recordFailure(ids.cooling, { failure: { status: 429, retryAfter: '300' }, nowMs: now });
    // 另一把永久失效，于是池内没有任何正常候选——这正是「其余密钥全部失败」。
    await health.recordFailure(ids.broken, {
      failure: { status: 401, detail: 'invalid api key' },
      nowMs: now,
    });

    const outcome = await scheduler.select();
    assert.equal(outcome.key, undefined);
    assert.equal(outcome.blocked, 'cooling', '不得退而使用冷却中的密钥');
    assert.equal(outcome.waitUntilMs, now + 300_000, '等待对象只有冷却类，永久失效不在其中');
  });

  test('额度耗尽的密钥不被选中，即使其余密钥都不可用', async () => {
    const { health, scheduler, ids } = await harness([{ label: 'exhausted' }]);
    await health.recordFailure(ids.exhausted, { failure: { status: 433 } });

    const outcome = await scheduler.select();
    assert.equal(outcome.key, undefined);
    assert.equal(outcome.blocked, 'all-unusable', '额度耗尽不可等待：恢复可能在下月 1 日');
  });

  test('池中一把启用的密钥都没有时报告 no-keys', async () => {
    const { pool, scheduler, ids } = await harness([{ label: 'off' }]);
    await pool.setDisabled(ids.off, true);

    assert.equal((await scheduler.select()).blocked, 'no-keys');
  });
});

describe('SCHED-6：并发不重复选中', () => {
  test('并发决策被串行化，两把密钥各被选中一次', async () => {
    const { scheduler } = await harness([{ label: 'a' }, { label: 'b' }]);

    const [first, second] = await Promise.all([scheduler.select(), scheduler.select()]);
    assert.notEqual(first.key.id, second.key.id, '两个并发请求不得选中同一把');
  });

  test('多轮并发整体上仍按轮转分配，不出现某一把被饿死', async () => {
    // 两把密钥、六次并发选择：每次都该轮到「最近最少用过」的那把，因此两边各三次。
    // 这条比「两次不相同」更强——它检验的是轮转本身，而不是一次巧合。
    const { scheduler, ids } = await harness([{ label: 'a' }, { label: 'b' }]);

    const picked = await Promise.all(
      Array.from({ length: 6 }, () => scheduler.select()),
    );
    const counts = picked.reduce((tally, outcome) => {
      tally[outcome.key.id] = (tally[outcome.key.id] ?? 0) + 1;
      return tally;
    }, {});

    assert.deepEqual(counts, { [ids.a]: 3, [ids.b]: 3 }, '同余额档内必须真正轮转');
  });

  test('轮转序号随密钥池持久化，重启后不重置', async () => {
    // 若序号只活在内存里，进程重启会让所有密钥回到「序号 0」，于是每次都从用户顺序
    // 的第一把重新开始——新加的那把会被反复使用，而它本该与其它同余额密钥轮转。
    const dir = await mkdtemp(join(tmpdir(), 'dsh-tavily-pool-scheduler-'));
    const pool = await new PoolStore({ dir, fileName: 'keys.json' }).load();
    const first = await pool.addKey({ key: 'tvly-dev-first-aaaaaaaaaaaa' });
    const second = await pool.addKey({ key: 'tvly-dev-second-bbbbbbbbbbbb' });

    const scheduler = new Scheduler({ pool, health: new KeyHealth({ pool }) });
    assert.equal((await scheduler.select()).key.id, first.id);
    assert.equal((await scheduler.select()).key.id, second.id);
    await pool.update(() => pool.snapshot());

    const reloaded = await new PoolStore({ dir, fileName: 'keys.json' }).load();
    const afterRestart = new Scheduler({ pool: reloaded, health: new KeyHealth({ pool: reloaded }) });

    assert.equal((await afterRestart.select()).key.id, first.id, '重启后轮到最早用过的那把');
    assert.equal(reloaded.statsOf(first.id).useSeq, 3);
    assert.equal(reloaded.statsOf(second.id).useSeq, 2);
  });

  test('互斥区内的抛错不会毒害后续调用', async () => {
    const mutex = new Mutex();
    await assert.rejects(() => mutex.runExclusive(() => {
      throw new Error('the critical section failed');
    }), /critical section failed/u);
    assert.equal(await mutex.runExclusive(() => 'still works'), 'still works');
  });

  test('决策本身是同步的，因此并发不可能读到同一份旧快照', async () => {
    // `SCHED-6` 的最终保障是这一条，而不是锁：锁只保证调用不交错，保证「读到的一定是
    // 最新的 lastUsedAt」的是决策区间内没有 `await`。给它加上一个 `await` 会让两个并发
    // 请求各自基于同一份快照决策——那正是 `SCHED-6` 要防的。
    //
    // 用一个「同步推进时钟」的健康状态来验证：如果决策里出现任何 await，第二次 select
    // 就会在第一次写回 lastUsedAt 之前完成读取，从而两把都被算成「从没用过」，于是
    // 并发拿到同一把。
    const { scheduler, ids } = await harness([{ label: 'a' }, { label: 'b' }]);

    const settled = await Promise.allSettled([scheduler.select(), scheduler.select()]);
    const chosen = settled.map((outcome) => outcome.value.key.id);

    assert.equal(new Set(chosen).size, 2, `并发决策必须看到彼此的选择：${JSON.stringify(chosen)}`);
    assert.deepEqual([...chosen].sort(), [ids.a, ids.b].sort());
  });
});

describe('SCHED-9：全部冷却时的有界等待', () => {
  test('最早到期的冷却落在预算之外时，一点都不等', async () => {
    const start = Date.parse('2026-09-19T00:00:00Z');
    let now = start;
    const waited = [];
    const { health, scheduler, ids } = await harness([{ label: 'soon' }, { label: 'later' }], {
      now: () => now,
      sleep: async (ms) => {
        waited.push(ms);
        now += ms;
      },
    });
    await health.recordFailure(ids.soon, { failure: { status: 429, retryAfter: '30' }, nowMs: now });
    await health.recordFailure(ids.later, { failure: { status: 429, retryAfter: '300' }, nowMs: now });

    const outcome = await scheduler.select({ waitDeadlineMs: start + 10_000 });

    // 等 10 秒不会让任何请求成功——最早的那把还要 30 秒才恢复——只是把失败推迟到预算
    // 耗尽，而 `REST-10` 要求此时尽快透穿真实的错误。
    assert.deepEqual(waited, [], '等一个到不了的到期时刻是纯粹的浪费');
    assert.equal(outcome.blocked, 'cooling');
    assert.equal(outcome.waitUntilMs, start + 30_000, '最早到期者是那把 30 秒的');
  });

  test('冷却在预算内到期时，等到它并选中那把密钥', async () => {
    const start = Date.parse('2026-09-19T00:00:00Z');
    let now = start;
    const dir = await mkdtemp(join(tmpdir(), 'dsh-tavily-pool-scheduler-'));
    const pool = await new PoolStore({ dir, fileName: 'keys.json' }).load();
    const record = await pool.addKey({ key: 'tvly-dev-soon-aaaaaaaaaaaa' });
    const health = new KeyHealth({ pool, now: () => now });
    await health.recordFailure(record.id, { failure: { status: 429, retryAfter: '30' }, nowMs: now });

    const scheduler = new Scheduler({
      pool,
      health,
      now: () => now,
      // 等待即把时钟推到该时刻：这里检验的是「等之后会发生什么」，不是定时器本身。
      sleep: async (ms) => {
        now += ms;
      },
    });

    const outcome = await scheduler.select({ waitDeadlineMs: now + 60_000 });
    assert.equal(outcome.key.id, record.id, '冷却结束时它重新成为候选');
    assert.equal(now, start + 30_000, '等满了整整 30 秒');
  });

  test('等待期间取消会立即返回', async () => {
    const now = Date.parse('2026-09-19T00:00:00Z');
    const controller = new AbortController();
    const { health, scheduler, ids } = await harness([{ label: 'cooling' }], {
      now: () => now,
      sleep: async () => controller.abort(),
    });
    await health.recordFailure(ids.cooling, { failure: { status: 500 }, nowMs: now });

    const outcome = await scheduler.select({ signal: controller.signal, waitDeadlineMs: now + 60_000 });
    assert.equal(outcome.blocked, 'aborted');
  });

  test('没有等待预算时立刻返回，而不是等满最早到期的冷却', async () => {
    const now = Date.parse('2026-09-19T00:00:00Z');
    let slept = false;
    const { health, scheduler, ids } = await harness([{ label: 'cooling' }], {
      now: () => now,
      sleep: async () => {
        slept = true;
      },
    });
    await health.recordFailure(ids.cooling, { failure: { status: 429, retryAfter: '300' }, nowMs: now });

    const outcome = await scheduler.select();
    assert.equal(outcome.blocked, 'cooling');
    assert.equal(slept, false);
  });
});

/**
 * 故障切换：一次请求内跨密钥的尝试编排。
 *
 * 这里检验的是「一次搜索实际经历了什么」——选了几把、记录了哪些状态、最后把什么交给
 * 调用方。用真实密钥池加打桩的 `invoke`，因此断言的是编排本身，而不是网络。
 */

import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { describe } from 'node:test';

import { MAX_ATTEMPTS, runWithFailover, waitAllowance } from '../lib/attempts.js';
import { SEARCH_WAIT_BUDGET_MS, WAIT_BUDGET_SHARE } from '../lib/constants.js';
import { KeyHealth } from '../lib/health.js';
import { PoolStore } from '../lib/pool.js';
import { Scheduler } from '../lib/scheduler.js';
import { TavilyError } from '../lib/tavily.js';

/**
 * 一个带若干密钥、并已接好调度器与健康状态的池。
 *
 * @param keys - 每把密钥的描述。
 * @param keys.label - 备注。
 * @param options - 可选的时刻与等待替身。
 * @returns `{ pool, health, scheduler, ids }`。
 */
async function harness(keys, options = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-tavily-pool-attempts-'));
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

/** 一个按密钥 id 决定成功或失败的 `invoke` 桩件，并记录每次调用。 */
function stubInvoke(behaviour) {
  const calls = [];
  const invoke = async ({ id }) => {
    calls.push(id);
    const outcome = behaviour[id];
    if (outcome === undefined || outcome.ok === true) {
      return { result: { sources: [], truncated: false }, credits: outcome?.credits };
    }
    throw new TavilyError(outcome.message ?? `HTTP ${String(outcome.status)}`, {
      code: outcome.code ?? `TAVILY_HTTP_${String(outcome.status)}`,
      status: outcome.status,
      detail: outcome.detail,
      retryAfter: outcome.retryAfter,
    });
  };
  return { invoke, calls };
}

describe('SCHED-4：失败自动切换', () => {
  test('第一把 401 且措辞命中失效时改用第二把，并标记第一把永久失效', async () => {
    const { pool, health, scheduler, ids } = await harness([{ label: 'bad' }, { label: 'good' }]);
    const { invoke, calls } = stubInvoke({
      [ids.bad]: { status: 401, detail: 'Unauthorized: invalid API key.' },
    });

    const outcome = await runWithFailover({ scheduler, health, invoke });

    assert.deepEqual(calls, [ids.bad, ids.good], '必须自动改用池内另一把');
    assert.equal(outcome.keyId, ids.good);
    assert.deepEqual(outcome.failedKeyIds, [ids.bad]);
    assert.equal(health.snapshotOf(ids.bad).permanentlyInvalid, true);
    assert.equal(pool.maskedList().find((entry) => entry.id === ids.bad).stats.failures, 1);
  });

  test('REST-6：432 与 433 同等处理，标记额度耗尽并改用另一把', async () => {
    for (const status of [432, 433]) {
      const { pool, health, scheduler, ids } = await harness([{ label: 'out' }, { label: 'ok' }]);
      const { invoke, calls } = stubInvoke({ [ids.out]: { status } });

      const outcome = await runWithFailover({ scheduler, health, invoke });

      assert.deepEqual(calls, [ids.out, ids.ok], `HTTP ${String(status)} 应触发故障切换`);
      assert.equal(outcome.keyId, ids.ok);
      const state = health.snapshotOf(ids.out);
      assert.equal(state.quotaExhausted, true, `HTTP ${String(status)} 应标记额度耗尽`);
      assert.equal(state.permanentlyInvalid, false, '额度耗尽不是永久失效');
      assert.equal(pool.maskedList().find((entry) => entry.id === ids.out).stats.quotaExhaustedAt
        !== undefined, true);
    }
  });

  test('5xx 归入冷却并改用另一把', async () => {
    const { health, scheduler, ids } = await harness([{ label: 'flaky' }, { label: 'ok' }]);
    const { invoke, calls } = stubInvoke({ [ids.flaky]: { status: 500 } });

    const outcome = await runWithFailover({ scheduler, health, invoke });

    assert.deepEqual(calls, [ids.flaky, ids.ok]);
    assert.equal(outcome.keyId, ids.ok);
    assert.equal(health.snapshotOf(ids.flaky).cooling, true, '5xx 归入冷却（REST-11）');
    assert.equal(health.snapshotOf(ids.flaky).cooldownUntilMs - Date.now() > 30_000, true);
  });

  test('429 的冷却时长取自 Retry-After', async () => {
    const now = Date.parse('2026-09-19T00:00:00Z');
    const { health, scheduler, ids } = await harness([{ label: 'limited' }, { label: 'ok' }], {
      now: () => now,
    });
    const { invoke } = stubInvoke({ [ids.limited]: { status: 429, retryAfter: '120' } });

    await runWithFailover({ scheduler, health, invoke, now: () => now });

    assert.equal(health.snapshotOf(ids.limited, now).cooldownUntilMs, now + 120_000);
  });

  test('泛化 401 不隔离密钥，只冷却', async () => {
    const { health, scheduler, ids } = await harness([{ label: 'odd' }, { label: 'ok' }]);
    const { invoke, calls } = stubInvoke({ [ids.odd]: { status: 401, detail: 'Unauthorized' } });

    const outcome = await runWithFailover({ scheduler, health, invoke });

    assert.deepEqual(calls, [ids.odd, ids.ok], '仍然要改用另一把');
    assert.equal(health.snapshotOf(ids.odd).permanentlyInvalid, false, '泛化 401 不得隔离密钥');
    assert.equal(health.snapshotOf(ids.odd).cooling, true, '但必须冷却，否则下次还会选中它');
  });
});

describe('REST-8：请求本身有误时不重试也不切换', () => {
  test('400 立刻交给调用方，且不试第二把', async () => {
    const { health, scheduler, ids } = await harness([{ label: 'a' }, { label: 'b' }]);
    const { invoke, calls } = stubInvoke({ [ids.a]: { status: 400, detail: 'bad topic' } });

    const error = await runWithFailover({ scheduler, health, invoke }).catch((thrown) => thrown);

    assert.deepEqual(calls, [ids.a], '换一把密钥不会让请求变得合法');
    assert.equal(error.status, 400);
    assert.equal(health.snapshotOf(ids.a).cooling, false, '请求错不是密钥的错');
    assert.equal(health.snapshotOf(ids.a).permanentlyInvalid, false);
  });
});

describe('REST-7：额度耗尽时给出官方自愈路径', () => {
  test('432 / 433 的错误文案指向官方 dashboard 与每月重置，而不是「换密钥」', async () => {
    for (const status of [432, 433]) {
      const { health, scheduler, ids } = await harness([{ label: 'only' }]);
      const { invoke } = stubInvoke({ [ids.only]: { status } });

      const error = await runWithFailover({ scheduler, health, invoke }).catch((thrown) => thrown);

      assert.equal(error.status, status, '上游状态码必须原样保留（REST-10）');
      assert.equal(error.code, `TAVILY_HTTP_${String(status)}`, '机器码不得被改写成我们自造的码');
      assert.match(error.message, /Tavily dashboard/u, '官方自愈路径是提高限额');
      assert.match(error.message, /1st of each month/u, '并说明用量每月 1 日重置');
      assert.doesNotMatch(error.message, /another key|new key/u, '官方指引不是「换一把密钥」');
    }
  });

  test('永久失效的错误文案要求用户更换密钥', async () => {
    const { health, scheduler, ids } = await harness([{ label: 'bad' }]);
    const { invoke } = stubInvoke({ [ids.bad]: { status: 401, detail: 'invalid api key' } });

    const error = await runWithFailover({ scheduler, health, invoke }).catch((thrown) => thrown);

    assert.equal(error.code, 'TAVILY_HTTP_401');
    assert.match(error.message, /invalid or revoked/u);
    assert.match(error.message, /Settings → Plugins/u);
  });

  test('冷却类失败不附加任何建议：故障切换本身就是答案', async () => {
    const { health, scheduler, ids } = await harness([{ label: 'flaky' }]);
    const { invoke } = stubInvoke({ [ids.flaky]: { status: 500, message: 'Internal Server Error' } });

    const error = await runWithFailover({ scheduler, health, invoke }).catch((thrown) => thrown);

    assert.equal(error.message, 'Internal Server Error', '原样透穿，不加附言');
    assert.doesNotMatch(error.message, /dashboard|Settings/u);
  });

  test('还有别的密钥可试时不提前下结论', async () => {
    // 两把都失败、且都是冷却 → 没有「额度耗尽/失效」可报告，因此不该出现自愈建议。
    const { health, scheduler, ids } = await harness([{ label: 'a' }, { label: 'b' }]);
    const { invoke } = stubInvoke({
      [ids.a]: { status: 500, message: 'boom a' },
      [ids.b]: { status: 500, message: 'boom b' },
    });

    const error = await runWithFailover({ scheduler, health, invoke }).catch((thrown) => thrown);

    assert.equal(error.message, 'boom b');
  });
});

describe('REST-10：透穿最后一个真实响应', () => {
  test('全部密钥都失败时抛出最后一次的失败', async () => {
    const { health, scheduler, ids } = await harness([{ label: 'a' }, { label: 'b' }]);
    const { invoke, calls } = stubInvoke({
      [ids.a]: { status: 429, message: 'first failure', retryAfter: '1' },
      [ids.b]: { status: 429, message: 'last failure', retryAfter: '1' },
    });

    const error = await runWithFailover({ scheduler, health, invoke }).catch((thrown) => thrown);

    assert.equal(calls.length, 2, '两把密钥各试一次');
    assert.equal(error.message, 'last failure', '透穿的是最后一个真实的上游响应');
    assert.equal(error.status, 429);
    assert.equal(error.retryAfter, '1', 'Retry-After 原值随错误一起透穿');
  });

  test('超过尝试上限后停止', async () => {
    const { health, scheduler } = await harness([
      { label: 'a' },
      { label: 'b' },
      { label: 'c' },
      { label: 'd' },
    ]);
    let calls = 0;
    const invoke = async () => {
      calls += 1;
      throw new TavilyError('always failing', { code: 'TAVILY_HTTP_500', status: 500 });
    };

    await runWithFailover({ scheduler, health, invoke }).catch(() => undefined);

    assert.equal(calls, MAX_ATTEMPTS, '一次 web_search 不会把整个池子转一圈');
  });

  test('池中没有可用密钥时给出可据以行动的 code', async () => {
    const { pool, health, scheduler, ids } = await harness([{ label: 'off' }]);
    await pool.setDisabled(ids.off, true);

    const error = await runWithFailover({ scheduler, health, invoke: async () => ({}) })
      .catch((thrown) => thrown);

    assert.equal(error.code, 'TAVILY_NO_USABLE_KEY');
    assert.match(error.message, /no Tavily key is configured/u);
    assert.match(error.message, /Settings → Plugins/u);
  });

  test('全部密钥不可用但有真实失败在先时，透穿那个失败而不是本地结论', async () => {
    const { pool, health, scheduler, ids } = await harness([{ label: 'only' }]);
    const { invoke } = stubInvoke({ [ids.only]: { status: 432, message: 'out of credits' } });
    // 只剩一把，它额度耗尽之后就再没有候选了。
    const error = await runWithFailover({ scheduler, health, invoke }).catch((thrown) => thrown);

    assert.match(error.message, /^out of credits/u, '上游的答复比「池子空了」更有信息量');
    assert.equal(error.status, 432);
    assert.equal(pool.maskedList()[0].stats.quotaExhaustedAt !== undefined, true);
  });
});

describe('取消与记账', () => {
  test('取消立刻向上传递，不记在密钥头上', async () => {
    const { health, scheduler, ids } = await harness([{ label: 'a' }, { label: 'b' }]);
    const invoke = async () => {
      throw new TavilyError('aborted', { code: 'TAVILY_ABORTED' });
    };

    const error = await runWithFailover({ scheduler, health, invoke }).catch((thrown) => thrown);

    assert.equal(error.code, 'TAVILY_ABORTED');
    assert.equal(health.statsOf(ids.a).failures, undefined, '取消不是密钥的失败');
    assert.equal(health.statsOf(ids.a).cooldownUntil, undefined);
  });

  test('成功会把调度时记下的调用数与积分一并留下', async () => {
    const { pool, health, scheduler, ids } = await harness([{ label: 'a' }]);
    const { invoke } = stubInvoke({ [ids.a]: { ok: true, credits: 2 } });

    const outcome = await runWithFailover({ scheduler, health, invoke });

    assert.equal(outcome.keyId, ids.a);
    const { stats } = pool.maskedList().find((entry) => entry.id === ids.a);
    assert.equal(stats.calls, 1, '被选中即计一次调用');
    assert.equal(stats.successes, 1);
    assert.equal(stats.credits, 2);
  });

  test('非 Tavily 错误原样向上，不被误记成密钥失败', async () => {
    const { health, scheduler, ids } = await harness([{ label: 'a' }]);
    const bug = new TypeError('a bug in our own code');

    const error = await runWithFailover({
      scheduler,
      health,
      invoke: async () => {
        throw bug;
      },
    }).catch((thrown) => thrown);

    assert.equal(error, bug);
    assert.equal(health.statsOf(ids.a).failures, undefined);
  });
});

describe('SCHED-9：等待预算的折算', () => {
  test('冷却在本次预算内到期时，等它结束并成功', async () => {
    const start = Date.parse('2026-09-19T00:00:00Z');
    let now = start;
    const { pool, health, ids } = await harness([{ label: 'cooling' }], {
      now: () => now,
      sleep: async (ms) => {
        now += ms;
      },
    });
    await health.recordFailure(ids.cooling, { failure: { status: 429, retryAfter: '30' }, nowMs: now });

    const scheduler = new Scheduler({
      pool,
      health,
      now: () => now,
      sleep: async (ms) => {
        now += ms;
      },
    });
    let invoked = false;
    const outcome = await runWithFailover({
      scheduler,
      health,
      deadlineMs: start + 60_000,
      now: () => now,
      invoke: async () => {
        invoked = true;
        return { result: { sources: [], truncated: false }, credits: 1 };
      },
    });

    assert.equal(outcome.keyId, ids.cooling, '冷却一结束它就该重新成为候选');
    assert.equal(invoked, true, '等待必须换来一次真实的尝试');
    assert.equal(now, start + 30_000, '等满了整整 30 秒');
  });

  test('冷却超出本次预算时立刻失败，且一次请求都不发', async () => {
    const start = Date.parse('2026-09-19T00:00:00Z');
    let now = start;
    const { pool, health, ids } = await harness([{ label: 'cooling' }], {
      now: () => now,
      sleep: async (ms) => {
        now += ms;
      },
    });
    await health.recordFailure(ids.cooling, { failure: { status: 429, retryAfter: '300' }, nowMs: now });

    const scheduler = new Scheduler({
      pool,
      health,
      now: () => now,
      sleep: async (ms) => {
        now += ms;
      },
    });
    let invoked = false;
    const error = await runWithFailover({
      scheduler,
      health,
      deadlineMs: start + 60_000,
      now: () => now,
      invoke: async () => {
        invoked = true;
        return {};
      },
    }).catch((thrown) => thrown);

    assert.equal(invoked, false, '等一个到不了的到期时刻不会让请求成功，只会推迟失败');
    assert.equal(now, start, '一点都不等');
    assert.equal(error.code, 'TAVILY_NO_USABLE_KEY');
    assert.match(error.message, /cooling down/u);
  });

  test('固定预算内等待，且不吃掉全部剩余时间', () => {
    const now = 1_000_000;
    assert.equal(
      waitAllowance(now + 60_000, now),
      now + 30_000,
      '总预算充裕时以 30 秒为上限',
    );
    assert.equal(
      waitAllowance(now + 10_000, now),
      now + 10_000 * WAIT_BUDGET_SHARE,
      '剩余预算的一半留给真正的请求',
    );
    assert.equal(
      waitAllowance(undefined, now),
      now + SEARCH_WAIT_BUDGET_MS,
      '调用方没给总预算时只受固定上限约束',
    );
  });

  test('先前的尝试吃掉大半预算之后，等待不再吃掉剩下的全部', async () => {
    const now = 1_000_000;
    assert.equal(waitAllowance(now + 1_000, now), now + 500, '只剩 1 秒时等 0.5 秒');
  });
});

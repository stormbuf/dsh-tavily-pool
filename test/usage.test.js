/**
 * 余额刷新（`/usage`）与记账。
 *
 * `fetch`、时钟与睡眠全部注入，因此「10 次 / 10 分钟」「6 小时栅格」「48 小时窗口」
 * 这些时间相关的规则都能被确定地覆盖，而不必真的等。
 */

import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { describe } from 'node:test';

import { KeyHealth } from '../lib/health.js';
import { PoolStore } from '../lib/pool.js';
import { balanceRank } from '../lib/scheduler.js';
import {
  QUOTA_PROBE_INTERVAL_MS,
  QUOTA_PROBE_WINDOW_MS,
  TAVILY_USAGE_URL,
  USAGE_QUOTA_MAX_CALLS,
} from '../lib/constants.js';
import {
  UsageQuota,
  UsageRefresher,
  fetchUsage,
  hasPositiveBalance,
  needsQuotaProbe,
  shouldProbeAfterMonthStart,
  utcMonthStartAfter,
} from '../lib/usage.js';

/** 一份官方形状的 `/usage` 响应。`limit` 为 `null` 表示无限。 */
function usageBody({ usage = 10, limit = 100, planLimit = 1000 } = {}) {
  return {
    key: { usage, limit, search_usage: usage, extract_usage: 0, crawl_usage: 0, map_usage: 0, research_usage: 0 },
    account: { current_plan: 'Researcher', plan_usage: usage, plan_limit: planLimit, paygo_usage: 0, paygo_limit: null },
  };
}

/**
 * 一个真实密钥池 + 真实健康状态 + 可控 `fetch` 的刷新器。
 *
 * 用真实的 `PoolStore` 而不是替身：`USAGE-3` 关心的是「旧值有没有被污染」，而那
 * 只有真实的落盘往返才能证明。
 */
async function harness({ now = Date.now, respond } = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-tavily-pool-usage-'));
  const pool = new PoolStore({ dir, fileName: 'keys.json' });
  await pool.load();
  const record = await pool.addKey({ key: 'tvly-dev-aaaaaaaaaaaaaaaa' });
  const health = new KeyHealth({ pool, now });

  const calls = [];
  const quota = new UsageQuota({ now });
  const refresher = new UsageRefresher({
    pool,
    health,
    quota,
    now,
    fetchImpl: async (url, init) => {
      calls.push({ url, method: init?.method, authorization: init?.headers?.authorization });
      const outcome = respond?.(calls.length) ?? { status: 200, body: usageBody() };
      if (outcome.throw !== undefined) throw outcome.throw;
      return new Response(JSON.stringify(outcome.body ?? {}), { status: outcome.status ?? 200 });
    },
  });

  return { pool, health, quota, refresher, record, calls };
}

describe('USAGE-1：刷新覆盖本地缓存', () => {
  test('官方返回值整体覆盖缓存，并记下取回时刻', async () => {
    const now = Date.parse('2026-09-19T00:00:00Z');
    const { pool, refresher, record, calls } = await harness({
      now: () => now,
      respond: () => ({ status: 200, body: usageBody({ usage: 80, limit: 100 }) }),
    });

    const outcome = await refresher.refresh(record.id, record.key);

    assert.equal(outcome.ok, true);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].url, TAVILY_USAGE_URL);
    assert.equal(calls[0].method, 'GET', '官方把 /usage 定义成 GET；POST 会被 405 拒绝');
    assert.match(calls[0].authorization, /^Bearer tvly-dev-/u);

    const cached = pool.usageOf(record.id);
    assert.equal(cached.key.usage, 80, '缓存应被覆盖为官方值');
    assert.equal(cached.key.limit, 100);
    assert.equal(cached.account.current_plan, 'Researcher', 'account 那一层整个带回来，展示套餐用得上');
    assert.equal(cached.fetchedAt, '2026-09-19T00:00:00.000Z');
    assert.equal(cached.stale, false);
  });

  test('刷新覆盖上一次的余额，而不是与之合并', async () => {
    const { pool, refresher, record } = await harness({
      respond: (call) => ({ status: 200, body: call === 1 ? usageBody({ usage: 10 }) : usageBody({ usage: 3, limit: 50 }) }),
    });

    await refresher.refresh(record.id, record.key);
    await refresher.refresh(record.id, record.key);

    const cached = pool.usageOf(record.id);
    assert.equal(cached.key.usage, 3);
    assert.equal(cached.key.limit, 50, '旧值不得残留：这是镜像，不是累计');
  });
});

describe('USAGE-2：配额预占避免触发官方限流', () => {
  test('窗口内第 11 次被跳过，且不发请求', async () => {
    const { refresher, record, calls } = await harness();

    for (let index = 0; index < USAGE_QUOTA_MAX_CALLS; index += 1) {
      assert.equal((await refresher.refresh(record.id, record.key)).ok, true, `第 ${String(index + 1)} 次应当放行`);
    }
    assert.equal(calls.length, USAGE_QUOTA_MAX_CALLS);

    const skipped = await refresher.refresh(record.id, record.key);

    assert.equal(skipped.ok, false);
    assert.equal(skipped.skipped, 'quota');
    assert.equal(calls.length, USAGE_QUOTA_MAX_CALLS, '超配额时绝不能发出请求');
  });

  test('窗口滚过之后重新放行', async () => {
    let now = Date.parse('2026-09-19T00:00:00Z');
    const { refresher, record } = await harness({ now: () => now });

    for (let index = 0; index < USAGE_QUOTA_MAX_CALLS; index += 1) {
      await refresher.refresh(record.id, record.key);
    }
    assert.equal((await refresher.refresh(record.id, record.key)).skipped, 'quota');

    now += 601_000;

    assert.equal((await refresher.refresh(record.id, record.key)).ok, true, '窗口滚过之后该放行');
  });

  test('配额按密钥分别计算，互不挤占', async () => {
    const now = Date.parse('2026-09-19T00:00:00Z');
    const quota = new UsageQuota({ now: () => now });

    for (let index = 0; index < USAGE_QUOTA_MAX_CALLS; index += 1) quota.tryAcquire('a');

    assert.equal(quota.tryAcquire('a'), false, 'a 已满');
    assert.equal(quota.tryAcquire('b'), true, 'b 是另一把密钥，不该被 a 的用量影响');
  });

  test('被跳过的刷新不消耗配额，窗口滚过之后重新放行', async () => {
    let now = Date.parse('2026-09-19T00:00:00Z');
    const quota = new UsageQuota({ now: () => now });

    for (let index = 0; index < USAGE_QUOTA_MAX_CALLS; index += 1) assert.equal(quota.tryAcquire('a'), true);
    // 又试 50 次，全部被拒——被拒的不该把窗口再往后推。
    for (let index = 0; index < 50; index += 1) assert.equal(quota.tryAcquire('a'), false);

    now += 601_000;
    assert.equal(quota.tryAcquire('a'), true, '窗口滚过之后放行；先前的 50 次拒绝不该延长封禁');
  });
});

describe('USAGE-3：刷新失败不污染缓存', () => {
  test('网络错误时旧值原样保留，只被标成陈旧', async () => {
    const { pool, refresher, record } = await harness({
      respond: (call) => (call === 1
        ? { status: 200, body: usageBody({ usage: 100, limit: 200 }) }
        : { throw: new TypeError('network down') }),
    });

    await refresher.refresh(record.id, record.key);
    const outcome = await refresher.refresh(record.id, record.key);

    assert.equal(outcome.ok, false);
    assert.equal(outcome.stale, true);

    const cached = pool.usageOf(record.id);
    assert.equal(cached.key.usage, 100, '失败绝不能用 0 或 null 覆盖旧值');
    assert.equal(cached.key.limit, 200);
    assert.equal(cached.stale, true, '但该值必须被标记为不再可信');
  });

  test('上游 429 同样只标陈旧，不动旧值', async () => {
    const { pool, refresher, record } = await harness({
      respond: (call) => (call === 1
        ? { status: 200, body: usageBody({ usage: 42 }) }
        : { status: 429, body: { detail: { error: 'rate limited' } } }),
    });

    await refresher.refresh(record.id, record.key);
    const outcome = await refresher.refresh(record.id, record.key);

    assert.equal(outcome.ok, false);
    assert.equal(pool.usageOf(record.id).key.usage, 42);
    assert.equal(pool.usageOf(record.id).stale, true);
  });

  test('从未成功刷新过时不凭空造一份「陈旧的空余额」', async () => {
    const { pool, refresher, record } = await harness({ respond: () => ({ throw: new Error('boom') }) });

    const outcome = await refresher.refresh(record.id, record.key);

    assert.equal(outcome.ok, false);
    assert.equal(pool.usageOf(record.id), undefined, '没有旧值可标记，就不要造一个出来');
  });

  test('刷新失败不会抛出，调用方拿到的始终是一个结果对象', async () => {
    const { refresher, record } = await harness({ respond: () => ({ throw: new Error('boom') }) });

    await assert.doesNotReject(() => refresher.refresh(record.id, record.key));
  });
});

describe('SCHED-8：只有官方确认余额回升才恢复', () => {
  test('余额为正时清掉额度耗尽标记', async () => {
    const { health, refresher, record } = await harness({
      respond: () => ({ status: 200, body: usageBody({ usage: 5, limit: 100 }) }),
    });
    await health.recordFailure(record.id, { failure: { status: 432 } });
    assert.equal(health.snapshotOf(record.id).quotaExhausted, true);

    const outcome = await refresher.refresh(record.id, record.key);

    assert.equal(outcome.recovered, true);
    assert.equal(health.snapshotOf(record.id).quotaExhausted, false, '官方确认余额为正，恢复候选资格');
  });

  test('余额仍为零时保持排除', async () => {
    const { health, refresher, record } = await harness({
      respond: () => ({ status: 200, body: usageBody({ usage: 100, limit: 100 }) }),
    });
    await health.recordFailure(record.id, { failure: { status: 432 } });

    const outcome = await refresher.refresh(record.id, record.key);

    assert.equal(outcome.recovered, false);
    assert.equal(health.snapshotOf(record.id).quotaExhausted, true, '没恢复就继续排除');
  });

  test('两侧都没有上限（真·无限）时，余额必然为正', async () => {
    const { health, refresher, record } = await harness({
      respond: () => ({ status: 200, body: usageBody({ usage: 999_999, limit: null, planLimit: null }) }),
    });
    await health.recordFailure(record.id, { failure: { status: 432 } });

    assert.equal((await refresher.refresh(record.id, record.key)).recovered, true);
    assert.equal(health.snapshotOf(record.id).quotaExhausted, false);
  });

  test('免费账号的 key.limit 也是 null，额度用尽时**不算**恢复（ticket 20）', async () => {
    // 实测的官方响应：`key.limit` 为 `null`、`account.plan_limit` 为 1000。修之前这把额度
    // 已经用尽的密钥会被判成「余额回升」，于是下一次搜索白撞一次 432。
    const { health, refresher, record } = await harness({
      respond: () => ({ status: 200, body: usageBody({ usage: 1000, limit: null, planLimit: 1000 }) }),
    });
    await health.recordFailure(record.id, { failure: { status: 432 } });

    assert.equal((await refresher.refresh(record.id, record.key)).recovered, false);
    assert.equal(health.snapshotOf(record.id).quotaExhausted, true, '没恢复就继续排除');
  });
});

describe('failure-paths-3：永久失效有可用的复位路径', () => {
  test('一次成功的 /usage 撤销永久失效标记', async () => {
    const { health, refresher, record } = await harness({
      respond: () => ({ status: 200, body: usageBody({ usage: 5, limit: 100 }) }),
    });
    await health.recordFailure(record.id, { failure: { status: 401, detail: 'invalid api key' } });
    assert.equal(health.snapshotOf(record.id).permanentlyInvalid, true, '先把它移出池子');

    const outcome = await refresher.refresh(record.id, record.key);

    assert.equal(outcome.ok, true);
    assert.equal(
      health.snapshotOf(record.id).permanentlyInvalid,
      false,
      '官方读通了这次 /usage，而它是带着这把密钥的 Authorization 读通的——「凭据不可再用」这条结论被反驳',
    );
    assert.equal(health.statsOf(record.id).invalidReason, undefined, '注解随标记一并清掉');
  });

  test('余额为零也照样撤销：额度耗尽是另一个标记', async () => {
    // 撤销与余额无关。余额用尽的 200 响应说的是「这把密钥没量了」，而不是「这把密钥
    // 不可用」——后者才是永久失效标记的全部内容。
    const { health, refresher, record } = await harness({
      respond: () => ({ status: 200, body: usageBody({ usage: 100, limit: 100 }) }),
    });
    await health.recordFailure(record.id, { failure: { status: 432 } });
    await health.recordFailure(record.id, { failure: { status: 401, detail: 'invalid api key' } });

    await refresher.refresh(record.id, record.key);

    assert.equal(health.snapshotOf(record.id).permanentlyInvalid, false);
    assert.equal(health.snapshotOf(record.id).quotaExhausted, true, '额度耗尽只认余额为正，不因这次读数解除');
  });

  test('刷新失败时标记原样保留：没读到官方读数就什么也没被确认', async () => {
    const { health, refresher, record } = await harness({
      respond: () => ({ status: 500, body: { detail: { error: 'boom' } } }),
    });
    await health.recordFailure(record.id, { failure: { status: 401, detail: 'invalid api key' } });

    const outcome = await refresher.refresh(record.id, record.key);

    assert.equal(outcome.ok, false);
    assert.equal(health.snapshotOf(record.id).permanentlyInvalid, true);
  });
});

describe('hasPositiveBalance：读不出余额一律不算「恢复」', () => {
  test('两侧都没有上限时为正', () => {
    assert.equal(hasPositiveBalance({ key: { usage: 1, limit: null }, account: { plan_limit: null } }), true);
  });

  test('免费账号按 account.plan_limit 判断（ticket 20）', () => {
    const free = (usage) => ({ key: { usage, limit: null }, account: { current_plan: 'Researcher', plan_limit: 1000 } });
    assert.equal(hasPositiveBalance(free(999)), true);
    assert.equal(hasPositiveBalance(free(1000)), false, '用尽就是没有余额，哪怕 key.limit 写着 null');
  });

  test('用量小于上限为正', () => {
    assert.equal(hasPositiveBalance({ key: { usage: 1, limit: 10 } }), true);
  });

  test('用量达到上限不为正', () => {
    assert.equal(hasPositiveBalance({ key: { usage: 10, limit: 10 } }), false);
  });

  test('缺字段、形状不对一律不为正', () => {
    for (const entry of [
      undefined,
      {},
      { key: null },
      { key: { usage: 1 } },
      { key: { limit: 10 } },
      { key: { usage: 'x', limit: 10 } },
    ]) {
      assert.equal(hasPositiveBalance(entry), false, `${JSON.stringify(entry)} 不能确认为正`);
    }
  });
});

describe('SCHED-10：月起始探测窗口', () => {
  // 标记发生在 3 月 20 日，因此第一个月起始是 4 月 1 日 00:00 UTC。
  const markedAt = Date.parse('2026-03-20T10:00:00Z');
  const monthStart = Date.parse('2026-04-01T00:00:00Z');

  test('月起始之后的第一个 UTC 月起始', () => {
    assert.equal(utcMonthStartAfter(markedAt), monthStart);
    assert.equal(
      utcMonthStartAfter(Date.parse('2026-12-05T00:00:00Z')),
      Date.parse('2027-01-01T00:00:00Z'),
      '12 月要进位到下一年',
    );
  });

  test('尚未跨过月起始时不探测', () => {
    const { probe } = shouldProbeAfterMonthStart({ quotaExhaustedAt: markedAt, nowMs: markedAt + 3600_000 });
    assert.equal(probe, false, '月中去问只会浪费配额');
  });

  test('跨过月起始后立刻探测一次', () => {
    const { probe } = shouldProbeAfterMonthStart({ quotaExhaustedAt: markedAt, nowMs: monthStart });
    assert.equal(probe, true);
  });

  test('探测过之后要等满 6 小时才再探测', () => {
    const at = monthStart + 3600_000;
    assert.equal(
      shouldProbeAfterMonthStart({ quotaExhaustedAt: markedAt, nowMs: at, lastProbeAt: monthStart }).probe,
      false,
      '1 小时后不该再问',
    );
    assert.equal(
      shouldProbeAfterMonthStart({
        quotaExhaustedAt: markedAt,
        nowMs: monthStart + QUOTA_PROBE_INTERVAL_MS,
        lastProbeAt: monthStart,
      }).probe,
      true,
      '满 6 小时才问下一次',
    );
  });

  test('48 小时窗口内恰好探测 8 次', () => {
    // 下界写死成 8 而不是「≤9」：`≤9` 拦不住一个退化成 9 次（甚至更多）的回归，而探测
    // 花的是 `/usage` 的官方配额——那正是恢复所需要的那份。栅格是月起始后的
    // 0/6/12/…/42 小时；第 48 小时那个点落在半开窗口之外。
    let lastProbeAt;
    const probes = [];
    for (let elapsed = 0; elapsed <= QUOTA_PROBE_WINDOW_MS; elapsed += 60_000) {
      const nowMs = monthStart + elapsed;
      if (shouldProbeAfterMonthStart({ quotaExhaustedAt: markedAt, nowMs, lastProbeAt }).probe) {
        probes.push(elapsed / 3600_000);
        lastProbeAt = nowMs;
      }
    }

    assert.deepEqual(probes, [0, 6, 12, 18, 24, 30, 36, 42], '探测时刻必须落在 6 小时栅格上');
    assert.ok(probes.length < 10, '必须远低于官方「10 次 / 10 分钟」的配额');
  });

  test('48 小时之后停止自动探测', () => {
    const { probe } = shouldProbeAfterMonthStart({
      quotaExhaustedAt: markedAt,
      nowMs: monthStart + QUOTA_PROBE_WINDOW_MS,
    });
    assert.equal(probe, false, '仍无恢复说明要用户提额，而不是还没到重置时刻');
  });

  test('上次探测发生在上一个窗口时不影响本窗口的第一格', () => {
    const { probe } = shouldProbeAfterMonthStart({
      quotaExhaustedAt: markedAt,
      nowMs: monthStart + 1000,
      lastProbeAt: markedAt,
    });
    assert.equal(probe, true);
  });

  test('needsQuotaProbe 从密钥统计里取事实', () => {
    assert.equal(
      needsQuotaProbe({ stats: { quotaExhaustedAt: new Date(markedAt).toISOString() }, nowMs: monthStart }),
      true,
    );
    assert.equal(
      needsQuotaProbe({ stats: { quotaExhaustedAt: new Date(markedAt).toISOString() }, nowMs: markedAt }),
      false,
    );
    assert.equal(needsQuotaProbe({ stats: {}, nowMs: monthStart }), false, '没标记过就无所谓探测');
  });
});

describe('USAGE-4：不在本地推断计费周期', () => {
  test('跨过自然月且未再次刷新时，缓存值原样留着，不被本地重置', async () => {
    // 这是 spec 里那条 Gherkin 场景（「不推断计费周期」）的直接覆盖。重置只能由
    // `/usage` 的实际返回值确认，时间只用来决定「该不该去问一次」。
    let now = Date.parse('2026-03-20T00:00:00Z');
    const { pool, refresher, record } = await harness({
      now: () => now,
      respond: () => ({ status: 200, body: usageBody({ usage: 40, limit: 100 }) }),
    });

    await refresher.refresh(record.id, record.key);
    const before = pool.usageOf(record.id);

    // 跨过一个自然月，期间一次刷新也不做。
    now = Date.parse('2026-05-15T00:00:00Z');

    const after = pool.usageOf(record.id);
    assert.deepEqual(after, before, '时间流逝不得改动缓存里的任何一个字节');
    assert.equal(after.key.usage, 40, '尤其不得把 usage 归零');
    assert.equal(after.fetchedAt, before.fetchedAt, 'fetchedAt 也必须还是上一次真实刷新的时刻');
  });

  test('余额排序不读时间：冷却/月起始都不参与余额计算', async () => {
    const { pool, record } = await harness();

    await pool.setUsage(record.id, usageBody({ usage: 10, limit: 100 }));

    assert.equal(balanceRank(pool.usageOf(record.id)), 90, '余额就是 limit - usage，与任何时刻无关');
  });
});

describe('USAGE-5：搜索成功后按**估算**前推余额', () => {
  test('一次 basic 成功搜索把缓存余额减掉 1（估算是本地算的，不是上游回传的）', async () => {
    // 官方回传多少积分与本插件无关了（2026-09-20 决定）：插件不再统计自身消耗，前推用的是
    // `estimateSearchCredits` 给出的固定估算——`basic` 记 1、`advanced` 记 2。
    const { pool, health, record } = await harness();

    await pool.setUsage(record.id, usageBody({ usage: 0, limit: 100 }));
    assert.equal(balanceRank(pool.usageOf(record.id)), 100, '先有 100');

    await health.recordSuccess(record.id, { searchDepth: 'basic' });

    assert.equal(balanceRank(pool.usageOf(record.id)), 99, '前推之后是 99');
    assert.equal(pool.usageOf(record.id).key.usage, 1, '前推的是 usage 那一项');
  });

  test('advanced 搜索前推 2，fast / ultra-fast 与 basic 同样前推 1', async () => {
    const { pool, health, record } = await harness();

    await pool.setUsage(record.id, usageBody({ usage: 0, limit: 100 }));
    await health.recordSuccess(record.id, { searchDepth: 'advanced' });
    assert.equal(pool.usageOf(record.id).key.usage, 2, 'advanced 每次估 2 积分');

    await health.recordSuccess(record.id, { searchDepth: 'fast' });
    await health.recordSuccess(record.id, { searchDepth: 'ultra-fast' });
    assert.equal(pool.usageOf(record.id).key.usage, 4, '另两档各估 1 积分');
  });

  test('前推改变的是**调度真正读的那份**余额', async () => {
    // 这一条是早先审查抓到的真问题：只累加本地流水而不前推 usageCache，等于
    // 「记了个数，却没有任何东西读它」——余额排序仍按上一次 /usage 的旧数字来。
    const { pool, health, record } = await harness();

    await pool.setUsage(record.id, usageBody({ usage: 90, limit: 100 }));
    assert.equal(balanceRank(pool.usageOf(record.id)), 10, '官方读数：还剩 10');

    await health.recordSuccess(record.id, { searchDepth: 'advanced' });

    assert.equal(
      balanceRank(pool.usageOf(record.id)),
      8,
      'balanceRank 读的是 usageCache.key，因此前推必须落在那里，而不是只落在 stats 上',
    );
  });

  test('估算值总是已知的：深度缺席也照样前推 1，不再有「消耗未知」这一态', async () => {
    // 旧口径下「上游没回传 credits」会被记成未知并放弃前推（`REST-3`）。现在没有记账、
    // 只有估算，而估算总有值——缺席的深度按默认档 `basic` 处理。
    const { pool, health, record } = await harness();

    await pool.setUsage(record.id, usageBody({ usage: 10, limit: 100 }));
    await health.recordSuccess(record.id, {});

    assert.equal(pool.usageOf(record.id).key.usage, 11, '估算是本地算的，不会因为上游没给就缺席');
    assert.equal('creditsUnknown' in health.statsOf(record.id), false, '「消耗未知」这一态已不存在');
  });

  test('抓取按累计档位前推：跨过第 5 个成功 URL 时才推 1', async () => {
    const { pool, health, record } = await harness();

    await pool.setUsage(record.id, usageBody({ usage: 0, limit: 100 }));

    for (let call = 1; call <= 4; call += 1) {
      await health.recordSuccess(record.id, { successfulUrls: 1, extractDepth: 'basic' });
    }
    assert.equal(pool.usageOf(record.id).key.usage, 0, '前四次各 1 个 URL，都还没跨档');

    await health.recordSuccess(record.id, { successfulUrls: 1, extractDepth: 'basic' });
    assert.equal(pool.usageOf(record.id).key.usage, 1, '第五次跨过档位，估 1 积分');
  });

  test('真·无限的密钥不前推：没有有限的余额可供减少', async () => {
    const { pool, health, record } = await harness();

    await pool.setUsage(record.id, usageBody({ usage: 500, limit: null, planLimit: null }));
    await health.recordSuccess(record.id, { searchDepth: 'advanced' });

    assert.equal(pool.usageOf(record.id).key.usage, 500, '无限额度前推不改变任何排序决策，却会污染官方读数');
  });

  test('免费账号的密钥会前推：上限在 account.plan_limit，本地估计因此有意义（ticket 20）', async () => {
    const { pool, health, record } = await harness();

    await pool.setUsage(record.id, usageBody({ usage: 500, limit: null, planLimit: 1000 }));
    await health.recordSuccess(record.id, { searchDepth: 'advanced' });

    assert.equal(
      pool.usageOf(record.id).key.usage,
      502,
      '修之前这里也不前推（`key.limit` 是 null），于是排序一直停在官方读数上',
    );
  });

  test('从未刷新过余额的密钥不前推：不凭空造一份本地估计', async () => {
    const { pool, health, record } = await harness();

    await health.recordSuccess(record.id, { searchDepth: 'advanced' });

    assert.equal(pool.usageOf(record.id), undefined, '上限只能来自官方，本地不知道它');
  });

  test('前推不改变 fetchedAt 与 stale：它们谈的是「上一次官方读数」', async () => {
    const now = Date.parse('2026-09-19T00:00:00Z');
    const { pool, health, record } = await harness({ now: () => now });

    await pool.setUsage(record.id, usageBody({ usage: 0, limit: 100 }));
    const before = pool.usageOf(record.id);

    await health.recordSuccess(record.id, { searchDepth: 'advanced' });

    const after = pool.usageOf(record.id);
    assert.equal(after.fetchedAt, before.fetchedAt, '前推不是一次官方读数');
    assert.equal(after.stale, before.stale, '也不该把一份新鲜读数标成陈旧');
  });

  test('一次刷新整体覆盖前推的结果，本地估计不会盖过官方值', async () => {
    const { pool, health, refresher, record } = await harness({
      respond: () => ({ status: 200, body: usageBody({ usage: 10, limit: 100 }) }),
    });

    await pool.setUsage(record.id, usageBody({ usage: 10, limit: 100 }));
    await health.recordSuccess(record.id, { searchDepth: 'basic' });
    assert.equal(pool.usageOf(record.id).key.usage, 11, '本地估计');

    await refresher.refresh(record.id, record.key);

    assert.equal(pool.usageOf(record.id).key.usage, 10, '官方值压倒本地估计：权威永远在官方那边');
  });
});

/** 从密钥池里读出某把密钥的余额排名。 */
function balanceRankOf(pool, id) {
  return balanceRank(pool.usageOf(id));
}

describe('官方 /usage 响应的三态语义', () => {
  test('key.limit 为 null 的无限额度被如实带进缓存', async () => {
    const { pool, refresher, record } = await harness({
      respond: () => ({ status: 200, body: usageBody({ limit: null }) }),
    });
    await refresher.refresh(record.id, record.key);

    assert.equal(pool.usageOf(record.id).key.limit, null, 'null 是「无限」，不是「读不到」');
  });

  test('account 下的 paygo_* 字段原样保留', async () => {
    const { pool, refresher, record } = await harness({
      respond: () => ({
        status: 200,
        body: { ...usageBody(), account: { ...usageBody().account, paygo_usage: 25, paygo_limit: 100 } },
      }),
    });

    await refresher.refresh(record.id, record.key);

    assert.equal(pool.usageOf(record.id).account.paygo_usage, 25);
    assert.equal(pool.usageOf(record.id).account.paygo_limit, 100);
  });
});

describe('fetchUsage 的错误面', () => {
  test('非 2xx 带上状态码与上游文本', async () => {
    const error = await fetchUsage({
      apiKey: 'k',
      fetchImpl: async () => new Response(JSON.stringify({ detail: { error: 'Unauthorized' } }), { status: 401 }),
    }).catch((thrown) => thrown);

    assert.equal(error.status, 401);
    assert.equal(error.detail, 'Unauthorized');
    assert.match(error.message, /HTTP 401/u);
  });

  test('保留上游的 request_id', async () => {
    const error = await fetchUsage({
      apiKey: 'k',
      fetchImpl: async () => new Response(JSON.stringify({ detail: { error: 'x' }, request_id: 'req-1' }), { status: 500 }),
    }).catch((thrown) => thrown);

    assert.equal(error.requestId, 'req-1', '排障时要能把它交给 Tavily 支持');
  });

  test('响应体不是 JSON 时按不可解码处理', async () => {
    const error = await fetchUsage({
      apiKey: 'k',
      fetchImpl: async () => new Response('<html>', { status: 200 }),
    }).catch((thrown) => thrown);

    assert.equal(error.code, 'TAVILY_UNPROCESSABLE_RESPONSE');
  });
});

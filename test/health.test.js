/**
 * 失败分类与冷却，针对纯函数与内存状态检验。
 *
 * 这些测试 pin 住的是「上游的一次失败意味着这把密钥接下来怎样」，而它是本插件里最
 * 容易写错、也最难从症状反推的一层：分类错了，症状是「明明还有密钥可用却回落了」
 * 或「一把坏密钥被反复选中」。
 */

import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { describe } from 'node:test';

import {
  clampCooldownSeconds,
  classifyFailure,
  DEFAULT_COOLDOWN_SECONDS,
  FAILURE_ACTIONS,
  isPermanentInvalidDetail,
  KeyHealth,
  MAX_COOLDOWN_SECONDS,
  MIN_COOLDOWN_SECONDS,
  QUOTA_ADVICE,
  parseRetryAfter,
} from '../lib/health.js';
import { PoolStore } from '../lib/pool.js';

/** 一个以全新临时目录为后端的密钥池。 */
async function temporaryPool() {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-tavily-pool-health-'));
  return new PoolStore({ dir, fileName: 'keys.json' }).load();
}

/** 一个带一把密钥的池，外加挂在它上面的健康状态。 */
async function poolWithKey(key = 'tvly-dev-aaaaaaaaaaaaaaaa') {
  const pool = await temporaryPool();
  const record = await pool.addKey({ key });
  return { pool, record, health: new KeyHealth({ pool }) };
}

describe('REST-4：Retry-After 的解析', () => {
  test('接受官方形式的整数秒', () => {
    assert.equal(parseRetryAfter('120'), 120);
    assert.equal(parseRetryAfter('  60  '), 60);
    assert.equal(parseRetryAfter('0'), 0);
  });

  test('接受 HTTP-date 并换算成相对秒数', () => {
    const now = Date.parse('2026-09-19T00:00:00Z');
    assert.equal(parseRetryAfter('Sat, 19 Sep 2026 00:01:00 GMT', now), 60);
  });

  test('已经过去的 HTTP-date 得到负数，交由 clamp 收口', () => {
    const now = Date.parse('2026-09-19T00:01:00Z');
    assert.equal(parseRetryAfter('Sat, 19 Sep 2026 00:00:00 GMT', now), -60);
    assert.equal(clampCooldownSeconds(-60), MIN_COOLDOWN_SECONDS);
  });

  test('缺失或不可解析时返回 undefined，而不是猜一个数', () => {
    assert.equal(parseRetryAfter(undefined), undefined);
    assert.equal(parseRetryAfter(''), undefined);
    assert.equal(parseRetryAfter('soon'), undefined);
  });
});

describe('REST-4 / REST-11：冷却时长被 clamp', () => {
  test('两端都 clamp：0 不至于让冷却失效，86400 不至于冻一整天', () => {
    assert.equal(clampCooldownSeconds(0), MIN_COOLDOWN_SECONDS);
    assert.equal(clampCooldownSeconds(86_400), MAX_COOLDOWN_SECONDS);
    assert.equal(clampCooldownSeconds(120), 120);
  });

  test('缺失时用本地默认值', () => {
    assert.equal(clampCooldownSeconds(undefined), DEFAULT_COOLDOWN_SECONDS);
    assert.equal(DEFAULT_COOLDOWN_SECONDS, 60);
  });
});

describe('REST-5：401 / 403 必须结合响应体措辞', () => {
  test('命中失效措辞才永久失效', () => {
    assert.equal(isPermanentInvalidDetail('Unauthorized: invalid API key.'), true);
    assert.equal(isPermanentInvalidDetail('This key has been revoked'), true);
    assert.equal(isPermanentInvalidDetail('account deactivated'), true);
  });

  test('泛化措辞不判定永久失效', () => {
    assert.equal(isPermanentInvalidDetail('Unauthorized'), false);
    assert.equal(isPermanentInvalidDetail('Forbidden'), false);
    assert.equal(isPermanentInvalidDetail(undefined), false);
  });

  test('泛化 401 归入冷却，而不是永久失效', () => {
    const classification = classifyFailure({ status: 401, detail: 'Unauthorized' });
    assert.equal(classification.action, FAILURE_ACTIONS.COOLDOWN);
    assert.equal(classification.cooldownSeconds, DEFAULT_COOLDOWN_SECONDS);
  });

  test('带失效措辞的 401 判定永久失效', () => {
    const classification = classifyFailure({ status: 401, detail: 'invalid api key' });
    assert.equal(classification.action, FAILURE_ACTIONS.INVALID);
  });
});

describe('状态码分类', () => {
  test('429 的冷却时长取自 Retry-After', () => {
    assert.equal(classifyFailure({ status: 429, retryAfter: '120' }).cooldownSeconds, 120);
  });

  test('429 缺失 Retry-After 时用被 clamp 的默认值', () => {
    assert.equal(classifyFailure({ status: 429 }).cooldownSeconds, DEFAULT_COOLDOWN_SECONDS);
    assert.equal(classifyFailure({ status: 429, retryAfter: 'oops' }).cooldownSeconds, DEFAULT_COOLDOWN_SECONDS);
  });

  test('432 与 433 同等处理，都不区分账号级与密钥级', () => {
    for (const status of [432, 433]) {
      const classification = classifyFailure({ status, detail: 'limit exceeded' });
      assert.equal(classification.action, FAILURE_ACTIONS.EXHAUSTED, `HTTP ${String(status)}`);
      assert.equal(classification.status, status);
    }
  });

  test('REST-7：自愈文案由 QUOTA_ADVICE 单点给出，指向官方 dashboard 而非换密钥', () => {
    // 文案是导出常量而不是分类结果里的字段：分类回答「这把密钥怎样了」，而「该做什么」
    // 由编排层在判定全部候选耗尽后取用。断言压在常量上，因此它一旦漂移就会被发现——
    // 这也正是它保持唯一副本的意义。
    assert.match(QUOTA_ADVICE, /Tavily dashboard/u);
    assert.match(QUOTA_ADVICE, /1st of each month/u);
    assert.doesNotMatch(QUOTA_ADVICE, /another key|new key/u, '官方指引不是「换一把密钥」');
  });

  test('5xx 归入冷却并取本地默认值', () => {
    const classification = classifyFailure({ status: 500 });
    assert.equal(classification.action, FAILURE_ACTIONS.COOLDOWN);
    assert.equal(classification.cooldownSeconds, DEFAULT_COOLDOWN_SECONDS, '5xx 不带 Retry-After');
  });

  test('400 是请求本身有误，不重试也不切换', () => {
    assert.equal(classifyFailure({ status: 400, detail: 'bad topic' }).action, FAILURE_ACTIONS.FATAL);
  });

  test('没有状态码的失败（超时、传输错误）归入冷却', () => {
    assert.equal(classifyFailure({ code: 'TAVILY_TIMEOUT' }).action, FAILURE_ACTIONS.COOLDOWN);
    assert.equal(classifyFailure({ code: 'TAVILY_NETWORK_ERROR' }).action, FAILURE_ACTIONS.COOLDOWN);
  });

  test('取消不是失败', () => {
    assert.equal(classifyFailure({ code: 'TAVILY_ABORTED' }).action, FAILURE_ACTIONS.ABORTED);
  });
});

describe('SCHED-3 / SCHED-8：状态机的硬排除', () => {
  test('冷却期内的密钥被硬排除，到期后自动恢复', async () => {
    const { health, record } = await poolWithKey();
    let now = Date.parse('2026-09-19T00:00:00Z');

    health.recordFailure(record.id, {
      failure: { status: 429, retryAfter: '60' },
      nowMs: now,
    });
    assert.equal(health.snapshotOf(record.id, now).cooling, true, '冷却中');

    now += 59_000;
    assert.equal(health.snapshotOf(record.id, now).cooling, true, '59 秒时仍在冷却');

    now += 2_000;
    assert.equal(health.snapshotOf(record.id, now).cooling, false, '到点自动恢复，无需任何定时器');
  });

  test('冷却只延长不缩短', async () => {
    const { health, record } = await poolWithKey();
    const now = Date.parse('2026-09-19T00:00:00Z');

    health.recordFailure(record.id, { failure: { status: 429, retryAfter: '300' }, nowMs: now });
    health.recordFailure(record.id, { failure: { status: 500 }, nowMs: now });

    assert.equal(
      health.snapshotOf(record.id, now).cooldownUntilMs,
      now + 300_000,
      '后到的较短冷却不得把已经承诺的等待缩短',
    );
  });

  test('成功即清除冷却', async () => {
    const { health, record } = await poolWithKey();
    const now = Date.parse('2026-09-19T00:00:00Z');

    health.recordFailure(record.id, { failure: { status: 500 }, nowMs: now });
    assert.equal(health.snapshotOf(record.id, now).cooling, true);

    health.recordSuccess(record.id, { credits: 1, nowMs: now + 1000 });
    assert.equal(health.snapshotOf(record.id, now + 1000).cooling, false, '上游刚接受了它');
  });

  test('额度耗尽一直保持，直到别处确认恢复', async () => {
    const { health, record } = await poolWithKey();
    const now = Date.parse('2026-09-19T00:00:00Z');

    health.recordFailure(record.id, { failure: { status: 432 }, nowMs: now });
    assert.equal(health.snapshotOf(record.id, now).quotaExhausted, true);

    // 时间过去再久也不会自己恢复：恢复信号只能来自 /usage 的实际返回值
    // （`USAGE-4`）。
    const later = now + 40 * 24 * 3600 * 1000;
    assert.equal(health.snapshotOf(record.id, later).quotaExhausted, true, '时间不是恢复依据');

    health.recordSuccess(record.id, { credits: 2, nowMs: later });
    assert.equal(health.snapshotOf(record.id, later).quotaExhausted, true, '一次成功也不解除额度耗尽');
  });

  test('永久失效与额度耗尽是两回事', async () => {
    const { health, record } = await poolWithKey();
    const now = Date.parse('2026-09-19T00:00:00Z');

    health.recordFailure(record.id, { failure: { status: 401, detail: 'invalid api key' }, nowMs: now });
    const state = health.snapshotOf(record.id, now);
    assert.equal(state.permanentlyInvalid, true);
    assert.equal(state.quotaExhausted, false);
  });

  test('最早到期的冷却只统计冷却类失败', async () => {
    const pool = await temporaryPool();
    const first = await pool.addKey({ key: 'tvly-dev-first-aaaaaaaaaaaa' });
    const second = await pool.addKey({ key: 'tvly-dev-second-bbbbbbbbbbbb' });
    const health = new KeyHealth({ pool });
    const now = Date.parse('2026-09-19T00:00:00Z');

    health.recordFailure(first.id, { failure: { status: 429, retryAfter: '120' }, nowMs: now });
    health.recordFailure(second.id, { failure: { status: 432 }, nowMs: now });

    assert.equal(
      health.earliestCooldownExpiry([first.id, second.id], now),
      now + 120_000,
      '额度耗尽不是等待对象：它可能要到下月 1 日',
    );
  });
});

describe('USAGE-7：统计落在密钥池文件里', () => {
  test('调用数、成功/失败、积分与最近错误都被记录', async () => {
    const { pool, record, health } = await poolWithKey();

    await health.markSelected(record.id);
    await health.recordSuccess(record.id, { credits: 1, durationMs: 42 });
    await health.recordFailure(record.id, {
      failure: { status: 500, detail: 'boom' },
      message: 'Tavily returned HTTP 500: boom',
      durationMs: 7,
    }).persisted;

    const entry = pool.maskedList()[0];
    assert.equal(entry.stats.calls, 1);
    assert.equal(entry.stats.successes, 1);
    assert.equal(entry.stats.failures, 1);
    assert.equal(entry.stats.credits, 1);
    assert.equal(entry.stats.lastDurationMs, 7);
    assert.equal(entry.stats.lastError.status, 500);
    assert.equal(entry.stats.lastError.message, 'Tavily returned HTTP 500: boom');
  });

  test('缺失 credits 记「未知」而不是 0', async () => {
    const { pool, record, health } = await poolWithKey();

    await health.recordSuccess(record.id, { durationMs: 10 });

    const { stats } = pool.maskedList()[0];
    assert.equal(stats.creditsUnknown, 1, '不知道消耗了多少，与「没消耗」必须区分得开');
    assert.equal(stats.credits, undefined, '不能记成 0');
  });

  test('状态经池文件往返：重新加载后冷却仍在', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'dsh-tavily-pool-health-'));
    const pool = await new PoolStore({ dir, fileName: 'keys.json' }).load();
    const record = await pool.addKey({ key: 'tvly-dev-aaaaaaaaaaaaaaaa' });
    const health = new KeyHealth({ pool });
    const now = Date.parse('2026-09-19T00:00:00Z');
    await health.recordFailure(record.id, { failure: { status: 500 }, nowMs: now }).persisted;

    const reloaded = new KeyHealth({ pool: await new PoolStore({ dir, fileName: 'keys.json' }).load() });
    assert.equal(reloaded.snapshotOf(record.id, now + 1000).cooling, true);
  });
});

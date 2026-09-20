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

import { runWithFailover } from '../lib/attempts.js';
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
import { Scheduler } from '../lib/scheduler.js';
import { TavilyError, extractTavily, searchTavily } from '../lib/tavily.js';

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

  test('408 与 425 是中间层的瞬时失败，归入冷却而不是致命', () => {
    // 408 常由出口代理/负载均衡在等源站超时之后**自己**发出（上游可能根本没收到这次
    // 请求），425（RFC 8470）的语义就是「稍后重试」。判 FATAL 会让整次请求在**第一把**
    // 密钥上终结，池内其余健康密钥一次都不被尝试，而该密钥还不进冷却——同一个 4xx 却比
    // 5xx 更狠，这是判据放错了地方。
    for (const endpoint of ['search', 'extract']) {
      for (const status of [408, 425]) {
        const classification = classifyFailure({ status, endpoint });
        assert.equal(classification.action, FAILURE_ACTIONS.COOLDOWN, `HTTP ${String(status)} on ${endpoint}`);
        assert.equal(classification.cooldownSeconds, DEFAULT_COOLDOWN_SECONDS);
      }
    }
  });

  test('408 / 425 的冷却时长同样取自 Retry-After', () => {
    assert.equal(classifyFailure({ status: 425, retryAfter: '120' }).cooldownSeconds, 120);
    assert.equal(classifyFailure({ status: 408, retryAfter: 'oops' }).cooldownSeconds, DEFAULT_COOLDOWN_SECONDS);
  });

  test('表外其余 4xx 仍然致命：换一把密钥不会让这个请求变得可接受', () => {
    for (const status of [404, 405, 409, 410, 411, 413, 414, 415, 416, 417, 418, 426, 451]) {
      assert.equal(
        classifyFailure({ status }).action,
        FAILURE_ACTIONS.FATAL,
        `HTTP ${String(status)} 不在官方错误表里，但它也不是瞬时失败`,
      );
    }
  });

  test('没有状态码的失败（超时、传输错误）归入冷却', () => {
    assert.equal(classifyFailure({ code: 'TAVILY_TIMEOUT' }).action, FAILURE_ACTIONS.COOLDOWN);
    assert.equal(classifyFailure({ code: 'TAVILY_NETWORK_ERROR' }).action, FAILURE_ACTIONS.COOLDOWN);
  });

  test('取消不是失败', () => {
    assert.equal(classifyFailure({ code: 'TAVILY_ABORTED' }).action, FAILURE_ACTIONS.ABORTED);
  });
});

describe('failure-paths-2：408 / 425 不再在第一把密钥上终结整个请求', () => {
  /**
   * 让池内每把密钥都返回同一个状态码，看编排层试了几把、留下了什么状态。
   *
   * @param status - 每次尝试收到的 HTTP 状态码。
   * @returns `{ caught, invoked, pool, records }`。
   */
  async function failoverWithStatus(status) {
    const pool = await temporaryPool();
    const records = [];
    for (const label of ['A', 'B', 'C']) {
      records.push(await pool.addKey({ key: `tvly-${label.repeat(20)}`, label }));
    }
    const health = new KeyHealth({ pool });
    const scheduler = new Scheduler({ pool, health });
    const invoked = [];
    let caught;
    try {
      await runWithFailover({
        scheduler,
        health,
        invoke: async () => {
          invoked.push(1);
          throw new TavilyError(`Tavily returned HTTP ${String(status)}: proxy gave up on the origin`, {
            code: `TAVILY_HTTP_${String(status)}`,
            status,
          });
        },
        deadlineMs: Date.now() + 60_000,
        maxAttempts: 3,
      });
    } catch (error) {
      caught = error;
    }
    return { caught, invoked, pool, records };
  }

  test('池内每一把都被试过，各自进冷却，透穿的仍是上游状态', async () => {
    for (const status of [408, 425]) {
      const { caught, invoked, pool, records } = await failoverWithStatus(status);

      assert.equal(invoked.length, 3, `HTTP ${String(status)} 必须换密钥，而不是在第一把上终结`);
      assert.equal(caught.status, status, '最后一次的真实失败仍要如实透穿');
      for (const record of records) {
        assert.notEqual(pool.statsOf(record.id).cooldownUntil, undefined, '瞬时失败要进冷却');
      }
    }
  });

  test('对照：表内 400 仍然在第一把上终结（换密钥不修复请求本身）', async () => {
    const { invoked } = await failoverWithStatus(400);
    assert.equal(invoked.length, 1, '400 是请求本身有误，重试与换密钥都不会改变结果');
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

describe('FETCH-5：/extract 的错误表与 /search 不同', () => {
  test('/search 上 403 加失效措辞 → 永久失效；/extract 上没有 403 这一档', () => {
    // 官方 OpenAPI 机器核验：`/extract` 的状态码全集是 400/401/429/432/433/500——**没有 403**。
    // 抓取路径上的一个 403（多半来自代理或 WAF，而不是 Tavily）套用 `/search` 的「措辞命中即
    // 永久失效」，会把一把好密钥白扔掉。这正是 spec 的 Gherkin 点名禁止的事。
    const detail = 'Unauthorized: invalid API key.';

    assert.deepEqual(
      classifyFailure({ status: 403, detail, endpoint: 'search' }),
      { action: 'invalid', status: 403, detail },
    );
    assert.deepEqual(
      classifyFailure({ status: 403, detail, endpoint: 'extract' }),
      { action: 'fatal', status: 403 },
      '/extract 的表里没有 403，因此走通用分支',
    );
  });

  test('/extract 上的 422 也走通用分支（那张表里没有它）', () => {
    assert.deepEqual(classifyFailure({ status: 422, endpoint: 'search' }), { action: 'fatal', status: 422 });
    assert.deepEqual(
      classifyFailure({ status: 422, endpoint: 'extract' }),
      { action: 'fatal', status: 422 },
      '两条路径最终都归入 FATAL，但判据不同：一个是「表里的 422」，一个是「表外的 4xx」',
    );
  });

  test('两个端点共有的那些码，语义完全一致', () => {
    // 401/429/432/433/500/400 在两张表里同名同义，分流不该把它们也改掉。
    const shared = [
      { status: 400 },
      { status: 401 },
      { status: 429, retryAfter: '60' },
      { status: 432 },
      { status: 433 },
      { status: 500 },
    ];

    for (const failure of shared) {
      assert.deepEqual(
        classifyFailure({ ...failure, endpoint: 'extract' }),
        classifyFailure({ ...failure, endpoint: 'search' }),
        `HTTP ${String(failure.status)} 在两个端点上的分类必须一致`,
      );
    }
  });

  test('端点缺席时按 search 处理——那是既有的默认，不是新行为', () => {
    assert.deepEqual(
      classifyFailure({ status: 403, detail: 'invalid api key' }),
      classifyFailure({ status: 403, detail: 'invalid api key', endpoint: 'search' }),
    );
  });
});

describe('failure-paths-3：永久失效只认上游信封里的措辞', () => {
  /**
   * 一个返回固定状态码与正文的 `fetch` 桩件。
   *
   * @param options - 固定响应。
   * @returns `fetch` 实现。
   */
  function respondWith({ status, body, contentType }) {
    return async () => new Response(body, {
      status,
      headers: contentType === undefined ? {} : { 'content-type': contentType },
    });
  }

  /** 三段中间层（代理/WAF/CDN）自己生成的 403 HTML，各含一个失效措辞。 */
  const PROXY_HTML_403 = [
    '<!doctype html><html><head><title>403 Forbidden</title></head>'
      + '<body><h1>Access denied</h1><p>your session has expired</p></body></html>',
    '<html><body><h1>403</h1><p>access to this resource has been disabled</p></body></html>',
    '<html><body><h1>403</h1><p>the requested resource was deleted</p></body></html>',
  ];

  test('中间层 HTML 里的 expired / disabled / deleted 都不判成永久失效，但至少冷却', async () => {
    // 这段文本曾经冒充 `detail`，于是**一次中间层 403 就能把一把健康密钥永久移出池子**
    // ——而那个标记在代码里没有任何清除路径，唯一的复位是删掉密钥再加回来。
    for (const html of PROXY_HTML_403) {
      const error = await searchTavily({
        apiKey: 'k',
        query: 'q',
        fetchImpl: respondWith({ status: 403, contentType: 'text/html', body: html }),
      }).catch((thrown) => thrown);

      assert.equal(error.detail, undefined, '代理自己生成的 HTML 不是上游给的，不能冒充 detail');
      assert.equal(error.bodyExcerpt, html.slice(0, 300), '原始片段走在 bodyExcerpt 上，与 detail 各归各位');
      assert.match(error.message, /403/u, '排障线索不能丢：它仍要出现在消息里');
      assert.equal(
        classifyFailure({ status: 403, detail: error.detail }).action,
        FAILURE_ACTIONS.COOLDOWN,
        '一次中间层 403 至少要冷却该密钥，而不是把它隔离',
      );
    }
  });

  test('上游信封里的措辞仍然判定永久失效', async () => {
    const error = await searchTavily({
      apiKey: 'k',
      query: 'q',
      fetchImpl: respondWith({
        status: 401,
        contentType: 'application/json',
        body: JSON.stringify({ detail: { error: 'Unauthorized: invalid API key.' } }),
      }),
    }).catch((thrown) => thrown);

    assert.equal(error.detail, 'Unauthorized: invalid API key.');
    assert.deepEqual(classifyFailure({ status: 401, detail: error.detail }), {
      action: FAILURE_ACTIONS.INVALID,
      status: 401,
      detail: 'Unauthorized: invalid API key.',
    });
  });

  test('JSON 体里读不出错误文本时同样不冒充 detail', async () => {
    // 判据的方向是「只有我们认得的信封字段才算上游的话」：一张没见过的 JSON 结构
    // 与一段 HTML 一样，都不足以把一把密钥永久移出池子。
    const error = await searchTavily({
      apiKey: 'k',
      query: 'q',
      fetchImpl: respondWith({
        status: 403,
        contentType: 'application/json',
        body: JSON.stringify({ message: 'this api key has been revoked' }),
      }),
    }).catch((thrown) => thrown);

    assert.equal(error.detail, undefined);
    assert.equal(classifyFailure({ status: 403, detail: error.detail }).action, FAILURE_ACTIONS.COOLDOWN);
  });

  test('抓取路径同理：信封里的逐 URL 原因算 detail，HTML 不算', async () => {
    const envelope = await extractTavily({
      apiKey: 'k',
      url: 'https://example.com',
      fetchImpl: respondWith({
        status: 400,
        contentType: 'application/json',
        body: JSON.stringify({ detail: { failed_results: [{ url: 'nope', error: 'invalid url' }] } }),
      }),
    }).catch((thrown) => thrown);
    assert.equal(envelope.detail, 'nope: invalid url', '逐 URL 的失败原因是上游信封的一部分');

    const html = await extractTavily({
      apiKey: 'k',
      url: 'https://example.com',
      fetchImpl: respondWith({ status: 401, contentType: 'text/html', body: PROXY_HTML_403[0] }),
    }).catch((thrown) => thrown);
    assert.equal(html.detail, undefined, '抓取路径上的中间层 HTML 同样不参与措辞判定');
  });
});

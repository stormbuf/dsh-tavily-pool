/**
 * 调用历史：追加、裁剪、原子落盘与容错（`14`）。
 *
 * 裁剪策略是这张票当初唯一的「未决」，因此它被写成一个纯函数（`pruneHistory`）并在这里
 * 单独钉死；存储部分跑在真实临时目录上，因为「条数受上限约束、超出后裁剪最旧记录」这条验收
 * 只有在真的写盘、真的读回之后才算数。
 */

import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { describe } from 'node:test';

import { HISTORY_MAX_ENTRIES, HISTORY_RETENTION_MS } from '../lib/constants.js';
import {
  CallHistory,
  HISTORY_SCHEMA_VERSION,
  emptyHistory,
  normalizeRecord,
  pruneHistory,
  validateHistory,
} from '../lib/history.js';

/** 一个落在全新临时目录上的历史存储。 */
async function temporaryHistory(options = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-tavily-history-'));
  return { dir, history: new CallHistory({ dir, fileName: 'history.json', ...options }) };
}

/** 一分钟，用来把记录拉开。 */
const MINUTE = 60_000;

/** 一条记录；`at` 由调用方给的基准时刻决定。 */
function entry(offsetMs, overrides = {}) {
  return {
    at: new Date(Date.parse('2026-09-19T00:00:00.000Z') + offsetMs).toISOString(),
    endpoint: 'search',
    keyId: 'key-1',
    keyMasked: 'tvly-dev-…iJWq',
    outcome: 'ok',
    durationMs: 120,
    ...overrides,
  };
}

describe('14：裁剪策略（票里那条未决）', () => {
  test('条数超上限时裁掉最旧的', () => {
    const entries = Array.from({ length: 10 }, (unused, index) => entry(index * MINUTE));
    const kept = pruneHistory(entries, { maxEntries: 4, retentionMs: 365 * 24 * 3600 * 1000 });

    assert.equal(kept.length, 4);
    assert.deepEqual(
      kept.map((item) => item.at),
      entries.slice(-4).map((item) => item.at),
      '裁掉的必须是最旧的，留下的必须保持时间顺序',
    );
  });

  test('超出时间窗口的记录被丢掉，即使条数还没到上限', () => {
    const entries = [
      entry(0),
      entry(50 * 24 * 3600 * 1000),
      entry(51 * 24 * 3600 * 1000),
    ];
    const kept = pruneHistory(entries, { maxEntries: 500, retentionMs: 30 * 24 * 3600 * 1000 });

    assert.deepEqual(kept.map((item) => item.at), entries.slice(1).map((item) => item.at));
  });

  test('两条约束取更严的那个', () => {
    const entries = Array.from({ length: 10 }, (unused, index) => entry(index * MINUTE));
    assert.equal(pruneHistory(entries, { maxEntries: 3, retentionMs: 365 * 24 * 3600 * 1000 }).length, 3);
    assert.equal(pruneHistory(entries, { maxEntries: 500, retentionMs: 5 * MINUTE }).length, 6);
  });

  test('窗口按**最新一条**而不是 now 计算', () => {
    // 用 now 做基准时，一份从别处复制来的、或系统时钟被改过之后留下的历史会被一次清空——
    // 而用户只是想把文件挪个地方。
    const old = [entry(0), entry(MINUTE)];
    assert.equal(pruneHistory(old, { maxEntries: 500, retentionMs: HISTORY_RETENTION_MS }).length, 2);
  });

  test('空数组是空数组', () => {
    assert.deepEqual(pruneHistory([]), []);
  });
});

describe('14：记录形状', () => {
  test('未知消耗不写成 0（REST-3）', () => {
    const record = normalizeRecord({ endpoint: 'search', keyId: 'k', durationMs: 5 });
    assert.equal('credits' in record, false, '未知就没有这个键，而不是 credits: 0');
  });

  test('已知的 0 保留为 0', () => {
    const record = normalizeRecord({ endpoint: 'extract', keyId: 'k', durationMs: 5, credits: 0 });
    assert.equal(record.credits, 0);
  });

  test('只带白名单字段，调用方多给的东西不落盘', () => {
    const record = normalizeRecord({ endpoint: 'search', keyId: 'k', durationMs: 5, secret: 'tvly-leak' });
    assert.equal('secret' in record, false);
  });

  test('request_id 被留下，供排障时向上游追问', () => {
    const record = normalizeRecord({ endpoint: 'search', keyId: 'k', durationMs: 5, requestId: 'req-1' });
    assert.equal(record.requestId, 'req-1');
  });

  test('未知端点和未知结果被收敛到词表内', () => {
    const record = normalizeRecord({ endpoint: 'teleport', keyId: 'k', durationMs: 5, outcome: 'maybe' });
    assert.equal(record.endpoint, 'search');
    assert.equal(record.outcome, 'failed');
  });
});

describe('14：文档校验', () => {
  test('坏掉的条目被丢掉，其余照常保留', () => {
    // 一条读不出来的记录不该让用户丢掉其余几百条。
    const decoded = validateHistory({
      version: HISTORY_SCHEMA_VERSION,
      entries: [
        entry(0),
        { at: 'not a date', endpoint: 'search', keyId: 'k' },
        { at: entry(MINUTE).at, endpoint: 'teleport', keyId: 'k' },
        { at: entry(2 * MINUTE).at, endpoint: 'extract', keyId: 'k' },
      ],
    });

    assert.equal(decoded.entries.length, 2);
    assert.deepEqual(decoded.entries.map((item) => item.endpoint), ['search', 'extract']);
  });

  test('整体形状不对时抛错，由调用方退到空历史', () => {
    assert.throws(() => validateHistory([]), /must be a JSON object/u);
    assert.throws(() => validateHistory({ version: 99, entries: [] }), /version/u);
    assert.throws(() => validateHistory({ version: HISTORY_SCHEMA_VERSION }), /entries/u);
  });

  test('全新文档的形状', () => {
    assert.deepEqual(emptyHistory(), { version: HISTORY_SCHEMA_VERSION, entries: [] });
  });
});

describe('14：落盘与读回', () => {
  test('追加之后能读回来，且顺序是时间升序', async () => {
    const { history } = await temporaryHistory();
    await history.append({ endpoint: 'search', keyId: 'a', keyMasked: 'x', durationMs: 10, credits: 1 });
    await history.append({ endpoint: 'extract', keyId: 'b', keyMasked: 'y', durationMs: 20, credits: 2 });

    const entries = await history.read();
    assert.equal(entries.length, 2);
    assert.deepEqual(entries.map((item) => item.endpoint), ['search', 'extract']);
  });

  test('recent() 最新的在前，且尊重条数上限', async () => {
    const { history } = await temporaryHistory();
    for (let index = 0; index < 5; index += 1) {
      await history.append({ endpoint: 'search', keyId: `k${String(index)}`, durationMs: index });
    }

    const recent = await history.recent(2);
    assert.deepEqual(recent.map((item) => item.keyId), ['k4', 'k3']);
  });

  test('条数上限在写入时生效，文件里不会超过它（验收：超出后裁剪最旧）', async () => {
    const { dir, history } = await temporaryHistory({ maxEntries: 3 });

    for (let index = 0; index < 6; index += 1) {
      await history.append({ endpoint: 'search', keyId: `k${String(index)}`, durationMs: index });
    }

    const entries = await history.read();
    assert.deepEqual(entries.map((item) => item.keyId), ['k3', 'k4', 'k5'], '留下的是最新的三条');

    // 文件本身也守着同一个上限——验收说的是「历史记录条数受上限约束」，而不是「读的时候
    // 截一下」。
    const onDisk = JSON.parse(await readFile(join(dir, 'history.json'), 'utf8'));
    assert.equal(onDisk.entries.length, 3);
  });

  test('没有文件时读回空数组，且不报告错误', async () => {
    const { history } = await temporaryHistory();
    assert.deepEqual(await history.read(), []);
    assert.equal(history.readError, undefined, '从未调用过不是一种错误');
  });

  test('文件损坏时读回空数组并报告原因', async () => {
    const { dir, history } = await temporaryHistory();
    await writeFile(join(dir, 'history.json'), '{ not json', 'utf8');

    assert.deepEqual(await history.read(), []);
    assert.notEqual(history.readError, undefined, '读不出来与本来就是空的必须区分得开');
  });

  test('写盘失败不抛错，而是记在 lastWriteError 上', async () => {
    // 历史是记录而不是正确性前提：写不进去只该让面板少一段曲线。
    const { history } = await temporaryHistory({
      fs: {
        readFile: async () => JSON.stringify(emptyHistory()),
        mkdir: async () => undefined,
        writeFile: async () => {
          throw new Error('EACCES: simulated');
        },
        rename: async () => undefined,
        unlink: async () => undefined,
      },
    });

    assert.equal(await history.append({ endpoint: 'search', keyId: 'k', durationMs: 1 }), false);
    assert.match(String(history.lastWriteError), /EACCES/u);
  });

  test('没有 keyId 的记录被拒绝，不会写出半条记录', async () => {
    const { history } = await temporaryHistory();
    assert.equal(await history.append({ endpoint: 'search', durationMs: 1 }), false);
    assert.deepEqual(await history.read(), []);
  });

  test('并发追加不会交错成一份只写了一半的文件', async () => {
    const { history } = await temporaryHistory();
    await Promise.all(Array.from({ length: 10 }, (unused, index) => (
      history.append({ endpoint: index % 2 === 0 ? 'search' : 'extract', keyId: `k${String(index)}`, durationMs: index })
    )));

    const entries = await history.read();
    assert.equal(entries.length, 10, '十次并发追加必须一条不少');
    assert.equal(new Set(entries.map((item) => item.keyId)).size, 10);
  });

  test('默认上限与默认窗口来自 constants，不是散落的字面量', async () => {
    const { history } = await temporaryHistory();
    assert.equal(history.maxEntries, HISTORY_MAX_ENTRIES);
    assert.equal(history.retentionMs, HISTORY_RETENTION_MS);
  });
});

describe('14：裁剪与输入顺序无关', () => {
  test('输入不是升序时，窗口仍按**最新一条**算', () => {
    // 正常路径上 `append` 追加在尾部，因此输入总是升序；但一份被外部编辑过、或由别的工具写出
    // 的历史文件可以不是。若不排序，窗口会按「数组最后一个元素」算，于是这里会保留 2 条而不是 1 条
    // ——即一条 100 天前的记录被判成「在窗口内」。
    const recent = entry(0);
    const ancient = entry(-100 * 24 * 3600 * 1000);
    const kept = pruneHistory([recent, ancient], { maxEntries: 500, retentionMs: 30 * 24 * 3600 * 1000 });

    assert.deepEqual(kept.map((item) => item.at), [recent.at]);
  });

  test('输出总是按时间升序，无论输入顺序', () => {
    const entries = [entry(2 * MINUTE), entry(0), entry(MINUTE)];
    assert.deepEqual(
      pruneHistory(entries, { maxEntries: 500, retentionMs: 365 * 24 * 3600 * 1000 }).map((item) => item.at),
      [entry(0).at, entry(MINUTE).at, entry(2 * MINUTE).at],
    );
  });
});

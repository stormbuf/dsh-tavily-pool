/**
 * 调用历史：追加、裁剪、原子落盘与容错（`14`）。
 *
 * 裁剪策略是这张票当初唯一的「未决」，因此它被写成一个纯函数（`pruneHistory`）并在这里
 * 单独钉死；存储部分跑在真实临时目录上，因为「条数受上限约束、超出后裁剪最旧记录」这条验收
 * 只有在真的写盘、真的读回之后才算数。
 */

import assert from 'node:assert/strict';
import { mkdtemp, readdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { describe } from 'node:test';

import { HISTORY_MAX_ENTRIES, HISTORY_RETENTION_MS, STATE_DIR_NAME } from '../lib/constants.js';
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
  test('记录里没有 credits 字段——插件不再统计自身消耗', () => {
    // 积分规则由上游随时可能更改，任何自算的数字都可能在某次规则调整后变成误导，
    // 因此历史只记「发生了一次调用」这个事实（2026-09-20 决定）。
    const record = normalizeRecord({ endpoint: 'search', keyId: 'k', durationMs: 5 });
    assert.equal('credits' in record, false, '搜索记录不带任何积分数字');
  });

  test('调用方硬塞 credits 也不会落盘：白名单式重建把它丢掉', () => {
    // 旧版本会写 `credits`，升级后若原样保留，一份旧文件会在每次追加时把那个字段带回来，
    // 迁移永远不会发生。
    const record = normalizeRecord({ endpoint: 'extract', keyId: 'k', durationMs: 5, credits: 0 });
    assert.equal('credits' in record, false, '连已知的 0 也不再保留——那个概念已经不存在');
  });

  test('抓取记录保留 successfulUrls：它是关于这次调用的事实，不是估算的产物', () => {
    const record = normalizeRecord({ endpoint: 'extract', keyId: 'k', durationMs: 5, successfulUrls: 3 });
    assert.equal(record.successfulUrls, 3);
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

  test('旧文件里的 credits 在下次写盘时被丢弃——校验层做白名单重建', () => {
    // 旧版本写下的 `credits` 不该随读盘回到内存：`validateHistory` 逐字段重建记录，
    // 白名单之外的键（含已废弃的 `credits`）在这里被丢掉，迁移因此自动完成。
    const decoded = validateHistory({
      version: HISTORY_SCHEMA_VERSION,
      entries: [{ ...entry(0), credits: 7 }],
    });

    assert.equal(decoded.entries.length, 1, '多带一个旧字段不该让整条记录失效');
    assert.equal('credits' in decoded.entries[0], false, '已废弃的字段被丢掉');
    assert.equal(decoded.entries[0].endpoint, 'search', '其余字段照常保留');
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
    await history.append({ endpoint: 'search', keyId: 'a', keyMasked: 'x', durationMs: 10 });
    await history.append({ endpoint: 'extract', keyId: 'b', keyMasked: 'y', durationMs: 20, successfulUrls: 1 });

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

describe('22 C2：跨实例的追加不能互相覆盖', () => {
  /** 一份已含一条记录的磁盘状态；两个实例的用例都从它开始。 */
  test('状态目录还不存在时，第一次追加必须自己把目录建出来（真机实测发现）', async () => {
    // 抢锁发生在 `#persist` 之前，而建目录原本是 `#persist` 的事——于是在一个**全新的**
    // 状态目录上，第一次追加会以 `ENOENT` 失败，而那次 `mkdir` 从来没机会跑到。真机上的
    // 症状是「一次真实搜索之后历史是空的」，面板上少一段曲线且没有任何解释。
    const root = await mkdtemp(join(tmpdir(), 'dsh-tavily-history-fresh-'));
    const dir = join(root, 'nested', STATE_DIR_NAME);
    const history = new CallHistory({ dir, fileName: 'history.json' });

    const appended = await history.append({ endpoint: 'search', keyId: 'key-1', outcome: 'ok', durationMs: 5 });

    assert.equal(appended, true, `追加必须成功，实际 lastWriteError=${String(history.lastWriteError)}`);
    assert.equal((await history.recent(10)).length, 1);
    assert.equal(
      (await readdir(dir)).includes('history.json.lock'),
      false,
      '写完之后锁文件必须已经释放',
    );
  });

  async function seededHistory(overrides = {}) {
    const dir = await mkdtemp(join(tmpdir(), 'dsh-tavily-history-race-'));
    const filePath = join(dir, 'history.json');
    const document = { version: HISTORY_SCHEMA_VERSION, entries: [entry(0, { keyId: 'seed-0' })] };
    await writeFile(filePath, `${JSON.stringify(document, null, 2)}\n`, 'utf8');
    return { dir, filePath, ...overrides };
  }

  test('两个实例的窗口重叠时两条新记录都留存', async () => {
    // 复现的是「读盘 ↔ rename 两个窗口重叠」：左实例读到盘之后、rename 之前，右实例走完
    // 自己的一轮读改写。没有排他锁时后一次 rename 会盖掉前一次——审计实测 5/5 丢一条，
    // 而两边都返回 true。
    //
    // 这里用注入的 fs 把那个窗口**固定**下来（不靠赛跑碰运气）：右实例的操作从左边 rename
    // 的那一刻开始，且这里只等它「读到盘」为止——真的拿到锁时它根本读不到，于是等到退避
    // 上限继续；左实例写完释放锁之后，它才读到含左实例记录的那份文件。
    const { dir, filePath } = await seededHistory();
    const real = await import('node:fs/promises');

    let rightRead;
    const rightReadHappened = new Promise((resolve) => {
      rightRead = resolve;
    });
    let pendingRight;

    const left = new CallHistory({
      dir,
      fileName: 'history.json',
      fs: {
        ...real,
        rename: async (from, to) => {
          if (to === filePath && pendingRight === undefined) {
            pendingRight = right.append({ endpoint: 'extract', keyId: 'right-1', durationMs: 6 });
            await Promise.race([
              rightReadHappened,
              new Promise((resolve) => {
                setTimeout(resolve, 150);
              }),
            ]);
          }
          return real.rename(from, to);
        },
      },
    });
    const right = new CallHistory({
      dir,
      fileName: 'history.json',
      fs: {
        ...real,
        readFile: async (...args) => {
          const raw = await real.readFile(...args);
          if (args[0] === filePath) rightRead();
          return raw;
        },
      },
    });

    const leftWritten = await left.append({ endpoint: 'search', keyId: 'left-1', durationMs: 5 });
    const rightWritten = await pendingRight;

    const entries = await new CallHistory({ dir, fileName: 'history.json' }).read();
    const appended = entries.map((item) => item.keyId).filter((id) => id === 'left-1' || id === 'right-1');
    assert.deepEqual(appended.slice().sort(), ['left-1', 'right-1'], '两条新记录都必须留存');
    assert.equal(leftWritten && rightWritten, true, '两边都真的写进去了：这一次谁都没有丢数据');
    assert.deepEqual((await real.readdir(dir)).sort(), ['history.json'], '锁必须被释放，不留残余文件');
  });

  test('拿不到锁时如实返回 false，绝不谎报成功', async () => {
    // 缺陷的判据就是「两边都报成功」。锁被一个活着的写者持有时，本次追加**没有发生**，
    // 因此它必须返回 false 并把原因记在 lastWriteError 上。
    const { dir, filePath } = await seededHistory();
    const { readdir } = await import('node:fs/promises');
    // 另一个实例正持着锁：时间戳是刚刚，因此它不陈旧、不该被抢走。
    await writeFile(`${filePath}.lock`, `${JSON.stringify({ pid: 4242, at: new Date().toISOString() })}\n`, 'utf8');
    const history = new CallHistory({ dir, fileName: 'history.json', lockTimeoutMs: 40 });

    const startedAt = Date.now();
    const written = await history.append({ endpoint: 'search', keyId: 'blocked-1', durationMs: 3 });

    assert.equal(written, false, '一次没有写进去的追加绝不能报成功');
    assert.equal(history.lastWriteError.code, 'ELOCKED');
    assert.match(String(history.lastWriteError), /could not acquire/u);
    assert.ok(Date.now() - startedAt < 1000, '等待必须有界：不能把调用方挂在这里');
    assert.deepEqual(
      JSON.parse(await readFile(filePath, 'utf8')).entries.map((item) => item.keyId),
      ['seed-0'],
      '文件必须原样未动',
    );
    assert.deepEqual((await readdir(dir)).sort(), ['history.json', 'history.json.lock'], '不许去删一个活着的锁');
  });

  test('崩溃留下的陈旧锁会被接管，而不是让此后每一次追加都永远失败', async () => {
    const { dir, filePath } = await seededHistory();
    const { readdir } = await import('node:fs/promises');
    await writeFile(
      `${filePath}.lock`,
      `${JSON.stringify({ pid: 999_999, at: new Date(Date.now() - 60_000).toISOString() })}\n`,
      'utf8',
    );
    const history = new CallHistory({ dir, fileName: 'history.json', lockTimeoutMs: 100 });

    const written = await history.append({ endpoint: 'search', keyId: 'after-crash', durationMs: 3 });

    assert.equal(written, true, '陈旧锁必须被接管，否则一次崩溃等于历史永久写不进去');
    assert.deepEqual(
      JSON.parse(await readFile(filePath, 'utf8')).entries.map((item) => item.keyId),
      ['seed-0', 'after-crash'],
    );
    assert.deepEqual((await readdir(dir)).sort(), ['history.json'], '接管之后锁必须被释放');
  });
});

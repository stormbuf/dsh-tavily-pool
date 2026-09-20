/**
 * 密钥池持久化，针对真实的临时目录检验。
 *
 * 这里要紧的行为都是用户会注意到的：文件损坏不得弄丢用户的密钥或让插件停摆；一次
 * 写入绝不能留下半写完的文件；本地文件之外的任何界面都绝不能看到明文密钥。
 */

import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { describe } from 'node:test';

import { maskKey, PoolFileError, PoolStore, validatePool } from '../lib/pool.js';

/** 一个以全新临时目录为后端的存储。 */
async function temporaryStore() {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-tavily-pool-test-'));
  return new PoolStore({ dir, fileName: 'keys.json' });
}

describe('POOL-6：写入是原子的', () => {
  test('写入经 rename 替换文件，不留下临时文件', async () => {
    const store = await temporaryStore();
    await store.load();
    await store.addKey({ key: 'tvly-dev-aaaaaaaaaaaaaaaaaaaa' });

    const entries = await readdir(store.dir);
    assert.deepEqual(entries, ['keys.json'], '成功写入后不得残留任何 .tmp 文件');

    const written = JSON.parse(await readFile(store.filePath, 'utf8'));
    assert.equal(written.keys.length, 1);
    assert.equal(written.order.length, 1);
  });

  test('POOL-2：添加的密钥立即落盘，重启后仍在', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'dsh-tavily-pool-test-'));
    const store = await new PoolStore({ dir, fileName: 'keys.json' }).load();
    const secret = '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';
    await store.addKey({ key: secret, label: 'primary' });

    // 用同一目录新建一个存储，等价于 DSH 重启后重新读盘。
    const reloaded = await new PoolStore({ dir, fileName: 'keys.json' }).load();

    assert.equal(reloaded.loadError, undefined);
    assert.equal(reloaded.keysInOrder().length, 1, '重启后密钥仍应存在');
    assert.equal(reloaded.keysInOrder()[0].key, secret, '明文落盘（POOL-2 允许，POOL-3 只约束出口）');
    assert.equal(reloaded.maskedList()[0].label, 'primary');
    assert.equal(JSON.stringify(reloaded.maskedList()).includes(secret), false, '而列表里只有脱敏形式');
  });

  test('POOL-2：并发添加全部留存，且不互相覆盖', async () => {
    const store = await temporaryStore();
    await store.load();

    // 五个写入方同时进入。如果存储没有把它们串起来，每个都会对同一份空文档做快照，
    // 最后一次 rename 胜出，于是添加了五把密钥却只剩一把。
    await Promise.all(
      ['a', 'b', 'c', 'd', 'e'].map((suffix) => store.addKey({ key: `tvly-dev-key-${suffix}-000000000000` })),
    );

    assert.equal(store.keysInOrder().length, 5, '每次添加都必须留存');
    const onDisk = JSON.parse(await readFile(store.filePath, 'utf8'));
    assert.equal(onDisk.keys.length, 5, '并且每次添加都必须落盘');
    assert.deepEqual(
      onDisk.order.slice().sort(),
      onDisk.keys.map((entry) => entry.id).sort(),
      'order 列表必须仍然精确列出已存储的密钥',
    );
  });

  test('失败的写入不会毒害后续写入', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'dsh-tavily-pool-test-'));
    let fail = true;
    const real = await import('node:fs/promises');
    const store = new PoolStore({
      dir,
      fileName: 'keys.json',
      fs: {
        ...real,
        writeFile: async (...args) => {
          if (fail) throw new Error('simulated disk failure');
          return real.writeFile(...args);
        },
      },
    });

    await store.load();
    await assert.rejects(() => store.addKey({ key: 'tvly-dev-doomed-aaaaaaaaaaaa' }));

    fail = false;
    await store.addKey({ key: 'tvly-dev-working-bbbbbbbbbbbb' });
    assert.deepEqual(store.keysInOrder().map((entry) => entry.key), ['tvly-dev-working-bbbbbbbbbbbb']);
  });

  test('被拒绝的变更既不改变文件，也不改变内存', async () => {
    const store = await temporaryStore();
    await store.load();
    await store.addKey({ key: 'tvly-dev-original-aaaaaaaaaaaa' });
    const before = await readFile(store.filePath, 'utf8');

    await assert.rejects(async () => {
      await store.update(() => {
        throw new Error('the caller changed its mind');
      });
    }, /changed its mind/u);

    assert.equal(await readFile(store.filePath, 'utf8'), before, '文件必须原样未动');
    assert.equal(store.keysInOrder().length, 1, '内存中的文档也必须原样未动');
  });

  test('被打断的写入让先前的文件保持完整', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'dsh-tavily-pool-test-'));
    let writes = 0;
    const store = new PoolStore({
      dir,
      fileName: 'keys.json',
      fs: {
        mkdir: (await import('node:fs/promises')).mkdir,
        readFile: (await import('node:fs/promises')).readFile,
        rename: (await import('node:fs/promises')).rename,
        unlink: (await import('node:fs/promises')).unlink,
        writeFile: async (...args) => {
          writes += 1;
          if (writes > 1) throw new Error('simulated interruption');
          const { writeFile: realWrite } = await import('node:fs/promises');
          return realWrite(...args);
        },
      },
    });

    await store.load();
    await store.addKey({ key: 'tvly-dev-first-key-aaaaaaaa' });
    const before = await readFile(store.filePath, 'utf8');

    await assert.rejects(() => store.addKey({ key: 'tvly-dev-second-key-bbbbbbbb' }));

    assert.equal(await readFile(store.filePath, 'utf8'), before, '文件必须逐字节相同');
    const entries = await readdir(dir);
    assert.deepEqual(entries, ['keys.json'], '被遗弃的临时文件必须清理掉');
  });
});

describe('POOL-7：文件损坏时只上报，不抛出', () => {
  test('文件不存在属于正常的首次运行', async () => {
    const store = await temporaryStore();
    await store.load();
    assert.equal(store.loadError, undefined);
    assert.deepEqual(store.keysInOrder(), []);
  });

  test('JSON 非法时以空池启动，并保持文件原样未动', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'dsh-tavily-pool-test-'));
    const filePath = join(dir, 'keys.json');
    await writeFile(filePath, '{ this is not json', 'utf8');

    const store = await new PoolStore({ dir, fileName: 'keys.json' }).load();

    assert.ok(store.loadError instanceof PoolFileError);
    assert.equal(store.loadError.reason, 'malformed');
    assert.deepEqual(store.keysInOrder(), [], '插件必须仍以空池工作');
    assert.equal(await readFile(filePath, 'utf8'), '{ this is not json', '原文件必须保留');
  });

  test('schema 不匹配时以空池启动，并保持文件原样未动', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'dsh-tavily-pool-test-'));
    const filePath = join(dir, 'keys.json');
    const original = JSON.stringify({ version: 99, keys: 'not an array' });
    await writeFile(filePath, original, 'utf8');

    const store = await new PoolStore({ dir, fileName: 'keys.json' }).load();

    assert.ok(store.loadError instanceof PoolFileError);
    assert.equal(await readFile(filePath, 'utf8'), original);
  });
});

describe('密钥池文档校验', () => {
  test('接受形状良好的文档', () => {
    const document = validatePool({
      version: 1,
      keys: [{ id: 'a', key: 'tvly-dev-aaaaaaaaaaaaaaaa', disabled: false }],
      order: ['a'],
      stats: {},
      usageCache: {},
    });
    assert.equal(document.keys.length, 1);
  });

  test('修复陈旧的 order 列表，而不是丢弃密钥', () => {
    const document = validatePool({
      version: 1,
      keys: [{ id: 'a', key: 'k-a' }, { id: 'b', key: 'k-b' }],
      order: ['b', 'ghost', 'b'],
    });
    assert.deepEqual(document.order, ['b', 'a'], '未知 id 丢弃，缺失 id 追加，重复项折叠');
  });

  test('拒绝没有 id 的密钥', () => {
    assert.throws(
      () => validatePool({ version: 1, keys: [{ key: 'k' }], order: [] }),
      /has no id/u,
    );
  });

  test('拒绝没有密钥内容的密钥', () => {
    assert.throws(
      () => validatePool({ version: 1, keys: [{ id: 'a', key: '' }], order: ['a'] }),
      /has no key/u,
    );
  });
});

describe('POOL-3：脱敏', () => {
  test('展示的信息足以认出密钥，但不足以使用它', () => {
    const masked = maskKey('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');
    assert.equal(masked, 'tvly-dev-…iJWq');
    assert.equal(masked.includes('U03Fq7'), false, '中间部分不得留存');
  });

  test('脱敏短密钥时不泄露可用的前缀', () => {
    assert.equal(maskKey('tvly-abc'), 'tv…c');
  });

  test('脱敏列表绝不携带明文', async () => {
    const store = await temporaryStore();
    await store.load();
    const secret = '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';
    await store.addKey({ key: secret, label: 'primary' });

    const serialized = JSON.stringify(store.maskedList());
    assert.equal(serialized.includes(secret), false, '明文不得出现在面板视图里');
    assert.equal(serialized.includes('U03Fq7'), false, '也不得出现其中任何一段较长的中间片段');
    assert.match(serialized, /tvly-dev-…iJWq/u);
  });
});

describe('POOL-4：增删改启停排序即时落盘', () => {
  test('停用一把密钥会立即写入文件，并保留它的统计', async () => {
    const store = await temporaryStore();
    await store.load();
    const first = await store.addKey({ key: 'tvly-dev-first-aaaaaaaaaaaa', label: 'primary' });
    await store.addKey({ key: 'tvly-dev-second-bbbbbbbbbbbb' });

    await store.update((document) => {
      document.stats[first.id] = { calls: 3, successes: 2, failures: 1 };
      return document;
    });
    await store.setDisabled(first.id, true);

    const onDisk = JSON.parse(await readFile(store.filePath, 'utf8'));
    const stored = onDisk.keys.find((entry) => entry.id === first.id);
    assert.equal(stored.disabled, true, '停用必须立即落盘');
    assert.equal(onDisk.stats[first.id].calls, 3, '停用不丢统计（POOL-5）');
    assert.equal(stored.label, 'primary');
  });

  test('改备注会立即落盘，清空备注则删掉该字段', async () => {
    const store = await temporaryStore();
    await store.load();
    const record = await store.addKey({ key: 'tvly-dev-aaaaaaaaaaaaaaaa' });

    await store.rename(record.id, 'backup');
    assert.equal(store.keysInOrder()[0].label, 'backup');

    await store.rename(record.id, '');
    assert.equal('label' in store.keysInOrder()[0], false, '空备注表示没有备注');
  });

  test('删除一把密钥会连同它的统计与余额缓存一起移除', async () => {
    const store = await temporaryStore();
    await store.load();
    const doomed = await store.addKey({ key: 'tvly-dev-doomed-aaaaaaaaaaaa' });
    await store.addKey({ key: 'tvly-dev-kept-bbbbbbbbbbbb' });
    await store.update((document) => {
      document.stats[doomed.id] = { calls: 1 };
      document.usageCache[doomed.id] = { key: { limit: 10, usage: 1 } };
      return document;
    });

    const removed = await store.removeKey(doomed.id);

    assert.equal(removed.id, doomed.id);
    assert.equal(removed.masked.includes('doomed'), false, '返回的也是脱敏记录');
    const onDisk = JSON.parse(await readFile(store.filePath, 'utf8'));
    assert.deepEqual(onDisk.keys.map((entry) => entry.id), [store.keysInOrder()[0].id]);
    assert.equal(onDisk.order.includes(doomed.id), false, 'order 里不得留下幽灵条目');
    assert.equal(doomed.id in onDisk.stats, false, '统计随密钥一起删除');
    assert.equal(doomed.id in onDisk.usageCache, false, '余额缓存随密钥一起删除');
  });

  test('重排按给定顺序落盘，未提到的密钥保持相对次序排在后面', async () => {
    const store = await temporaryStore();
    await store.load();
    const first = await store.addKey({ key: 'tvly-dev-first-aaaaaaaaaaaa' });
    const second = await store.addKey({ key: 'tvly-dev-second-bbbbbbbbbbbb' });
    const third = await store.addKey({ key: 'tvly-dev-third-cccccccccccc' });

    const order = await store.reorder([third.id, 'ghost-id', first.id]);

    assert.deepEqual(order, [third.id, first.id, second.id], '未知 id 丢弃，未提到的追加');
    const onDisk = JSON.parse(await readFile(store.filePath, 'utf8'));
    assert.deepEqual(onDisk.order, order);
  });

  test('编辑不存在的密钥会被拒绝，且不改动文件', async () => {
    const store = await temporaryStore();
    await store.load();
    await store.addKey({ key: 'tvly-dev-only-aaaaaaaaaaaa' });
    const before = await readFile(store.filePath, 'utf8');

    await assert.rejects(() => store.setDisabled('no-such-id', true), RangeError);
    await assert.rejects(() => store.rename('no-such-id', 'x'), RangeError);
    await assert.rejects(() => store.removeKey('no-such-id'), RangeError);

    assert.equal(await readFile(store.filePath, 'utf8'), before);
  });

  test('统计写入失败只在记录里报错，不弄坏存储也不抛给调用方', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'dsh-tavily-pool-test-'));
    const real = await import('node:fs/promises');
    let fail = true;
    const store = new PoolStore({
      dir,
      fileName: 'keys.json',
      fs: {
        ...real,
        writeFile: async (...args) => {
          if (fail) throw new Error('simulated disk failure');
          return real.writeFile(...args);
        },
      },
    });
    await store.load();

    const written = await store.writeStats('key-id', () => ({ calls: 1 }));

    assert.equal(written, false, '失败以上报的形式返回，而不是抛给搜索路径');
    assert.ok(store.lastWriteError instanceof Error);
    assert.deepEqual(store.statsOf('key-id'), { calls: 1 }, '内存状态仍然更新：调度决策读的是它');
  });

  test('失败的编辑整体回滚，内存与磁盘仍一致', async () => {
    // 编辑落盘失败时不能只改内存：那会留下一份重启就消失的密钥池，而面板此刻显示的
    // 正是它。回滚之后两边都停在编辑之前的状态。
    const dir = await mkdtemp(join(tmpdir(), 'dsh-tavily-pool-test-'));
    const real = await import('node:fs/promises');
    let writes = 0;
    const store = new PoolStore({
      dir,
      fileName: 'keys.json',
      fs: {
        ...real,
        writeFile: async (...args) => {
          writes += 1;
          // 第一次写入建立初始文件，之后的那次编辑写入失败。
          if (writes === 2) throw new Error('simulated edit failure');
          return real.writeFile(...args);
        },
      },
    });
    await store.load();
    const record = await store.addKey({ key: 'tvly-dev-base-aaaaaaaaaaaa' });

    await assert.rejects(() => store.setDisabled(record.id, true), /simulated edit failure/u);

    assert.equal(store.maskedList()[0].disabled, false, '失败的那次编辑不生效');
    const onDisk = JSON.parse(await readFile(store.filePath, 'utf8'));
    assert.equal(onDisk.keys[0].disabled, false, '磁盘上也不生效（不是只活了在内存里）');
  });

  test('失败的编辑不被后续写入连带回滚，两者最终都与磁盘一致', async () => {
    // 回滚必须只撤掉**这一次编辑**：若同一条队列上已有别的写入接管了文档，无条件
    // 回滚会把它们的成果一起抹掉，而它们要么已经写好、要么即将写好——磁盘与内存从此
    // 不一致，且内存里少掉的那次统计再也不会自己回来。
    const dir = await mkdtemp(join(tmpdir(), 'dsh-tavily-pool-test-'));
    const real = await import('node:fs/promises');
    let writes = 0;
    const store = new PoolStore({
      dir,
      fileName: 'keys.json',
      fs: {
        ...real,
        writeFile: async (...args) => {
          writes += 1;
          if (writes === 2) throw new Error('simulated edit failure');
          return real.writeFile(...args);
        },
      },
    });
    await store.load();
    const record = await store.addKey({ key: 'tvly-dev-base-aaaaaaaaaaaa' });

    const editing = store.setDisabled(record.id, true);
    // 先接上拒绝处理，否则 Node 会把它报成 unhandledRejection。
    const editingSettled = editing.then(() => undefined, (error) => error);
    await store.writeStats(record.id, () => ({ calls: 5 }));

    assert.match(String((await editingSettled).message), /simulated edit failure/u);
    assert.equal(store.statsOf(record.id).calls, 5, '并发写入的统计不得被回滚抹掉');

    // 关键断言：内存与磁盘必须一致——无论那次编辑最终生效与否。
    const onDisk = JSON.parse(await readFile(store.filePath, 'utf8'));
    assert.equal(
      store.maskedList()[0].disabled,
      onDisk.keys[0].disabled,
      '两次写入都排在同一队列上，最终状态必须两边一致',
    );
    assert.equal(store.statsOf(record.id).calls, onDisk.stats[record.id].calls);
  });

  test('编辑与统计写入并发时不丢更新，内存与磁盘最终一致', async () => {
    // 面板的编辑（`update`）与搜索的记账（`writeStats`）写的是同一份文档。两条路径若
    // 一条同步、一条等落盘之后才改内存，慢的那条就会把快的那条的成果覆盖掉——症状是
    // 「用户改了顺序，磁盘上却没改」，而且此后内存与磁盘长期不一致。
    const dir = await mkdtemp(join(tmpdir(), 'dsh-tavily-pool-test-'));
    const real = await import('node:fs/promises');
    const store = new PoolStore({
      dir,
      fileName: 'keys.json',
      // 放慢落盘，制造出「编辑正在写盘」的那个窗口。
      fs: {
        ...real,
        writeFile: async (...args) => {
          await new Promise((resolve) => {
            setTimeout(resolve, 20);
          });
          return real.writeFile(...args);
        },
      },
    });
    await store.load();
    const record = await store.addKey({ key: 'tvly-dev-race-aaaaaaaaaaaa' });

    const editing = store.setDisabled(record.id, true);
    await store.writeStats(record.id, () => ({ calls: 7 }));
    await editing;

    const onDisk = JSON.parse(await readFile(store.filePath, 'utf8'));
    assert.equal(onDisk.keys[0].disabled, true, '用户的编辑必须落盘');
    assert.equal(onDisk.stats[record.id].calls, 7, '统计也必须落盘');
    assert.equal(store.maskedList()[0].disabled, true, '内存与磁盘一致');
    assert.equal(store.statsOf(record.id).calls, 7);
  });
});

describe('issue 01 的密钥选择', () => {
  test('按用户顺序给出密钥，停用者仍在列表里但状态为停用', async () => {
    const store = await temporaryStore();
    await store.load();
    const first = await store.addKey({ key: 'tvly-dev-first-aaaaaaaaaaaa' });
    await store.addKey({ key: 'tvly-dev-second-bbbbbbbbbbbb' });
    assert.deepEqual(
      store.maskedList().map((entry) => entry.disabled),
      [false, false],
    );

    await store.setDisabled(first.id, true);
    assert.equal(store.maskedList()[0].disabled, true);
    assert.equal(store.keysInOrder().length, 2, '停用不删除记录：统计与配置都保留（POOL-5）');
  });

  test('池为空时列表为空', async () => {
    const store = await temporaryStore();
    await store.load();
    assert.deepEqual(store.maskedList(), []);
  });
});

describe('POOL-8：批量添加是一次编辑', () => {
  /**
   * 一个计着写入次数的存储。
   *
   * 「一次落盘」这件事只有数得出来才谈得上被检验：批量添加若退化成循环调用 `addKey`，
   * 行为上完全看不出区别（最终还是全部留存），只有写入次数会从 1 变成 N。
   *
   * @returns `{ store, writes }`。
   */
  async function countingStore() {
    const dir = await mkdtemp(join(tmpdir(), 'dsh-tavily-pool-batch-'));
    const real = await import('node:fs/promises');
    const counter = { count: 0 };
    const store = await new PoolStore({
      dir,
      fileName: 'keys.json',
      fs: {
        mkdir: real.mkdir,
        readFile: real.readFile,
        rename: real.rename,
        unlink: real.unlink,
        writeFile: (...args) => {
          counter.count += 1;
          return real.writeFile(...args);
        },
      },
    }).load();
    return { store, writes: counter };
  }

  test('12 把密钥只写一次盘，且全部留存', async () => {
    const { store, writes } = await countingStore();
    const keys = Array.from({ length: 12 }, (unused, index) => ({ key: `tvly-dev-batch-${String(index)}-000000000000` }));

    const records = await store.addKeys({ keys });

    assert.equal(records.length, 12);
    assert.equal(writes.count, 1, '批量添加是一次编辑，不是 12 次');
    assert.equal(store.keysInOrder().length, 12);
    assert.equal(JSON.parse(await readFile(store.filePath, 'utf8')).keys.length, 12, '而且真落了盘');
  });

  test('同一批共享同一个 addedAt：它们是同一次动作的结果', async () => {
    const { store } = await countingStore();
    const records = await store.addKeys({
      keys: [{ key: 'tvly-dev-batch-a-000000000000' }, { key: 'tvly-dev-batch-b-000000000000' }],
      nowMs: Date.parse('2026-09-19T00:00:00.000Z'),
    });

    assert.deepEqual(records.map((record) => record.addedAt), [
      '2026-09-19T00:00:00.000Z',
      '2026-09-19T00:00:00.000Z',
    ]);
  });

  test('空数组什么都不做，连一次写入都不排', async () => {
    const { store, writes } = await countingStore();
    assert.deepEqual(await store.addKeys({ keys: [] }), []);
    assert.equal(writes.count, 0);
    assert.deepEqual(store.keysInOrder(), []);
  });

  test('批量添加的新密钥排在池尾，顺序列表与密钥列表一一对应', async () => {
    const { store } = await countingStore();
    await store.addKey({ key: 'tvly-dev-existing-000000000000' });
    await store.addKeys({ keys: [{ key: 'tvly-dev-new-a-000000000000' }, { key: 'tvly-dev-new-b-000000000000' }] });

    const onDisk = JSON.parse(await readFile(store.filePath, 'utf8'));
    assert.deepEqual(
      store.keysInOrder().map((record) => record.key),
      ['tvly-dev-existing-000000000000', 'tvly-dev-new-a-000000000000', 'tvly-dev-new-b-000000000000'],
    );
    assert.deepEqual(onDisk.order, store.keysInOrder().map((record) => record.id));
  });

  test('批量添加的密钥默认启用，且列表出口只有脱敏形式（POOL-3、POOL-5）', async () => {
    const { store } = await countingStore();
    const secret = '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';
    await store.addKeys({ keys: [{ key: secret }] });

    assert.equal(store.keysInOrder()[0].disabled, false);
    assert.equal(JSON.stringify(store.maskedList()).includes(secret), false);
  });
});

describe('22 D2：批量删除是一次编辑', () => {
  /**
   * 一个计着写入次数的存储（与 `POOL-8` 那组同一手法）。
   *
   * 「一次落盘」只有数得出来才谈得上被检验：`removeKeys` 若退化成循环调用 `removeKey`，
   * 最终状态完全一样，只有写入次数会从 1 变成 N——而那个差别正是「中途失败留半个池子」
   * 这个风险的全部来源。
   *
   * @returns `{ store, writes }`。
   */
  async function countingStore() {
    const dir = await mkdtemp(join(tmpdir(), 'dsh-tavily-pool-remove-batch-'));
    const real = await import('node:fs/promises');
    const counter = { count: 0 };
    const store = await new PoolStore({
      dir,
      fileName: 'keys.json',
      fs: {
        mkdir: real.mkdir,
        readFile: real.readFile,
        rename: real.rename,
        unlink: real.unlink,
        writeFile: (...args) => {
          counter.count += 1;
          return real.writeFile(...args);
        },
      },
    }).load();
    return { store, writes: counter };
  }

  test('删 5 把只写一次盘，连统计与余额缓存一起清掉', async () => {
    const { store, writes } = await countingStore();
    const records = await store.addKeys({
      keys: Array.from({ length: 6 }, (unused, index) => ({ key: `tvly-dev-remove-${String(index)}-000000000000` })),
    });
    await store.writeStats(records[0].id, () => ({ calls: 3 }));
    await store.setUsage(records[0].id, { key: { limit: 1000, usage: 10 } });
    const doomed = records.slice(0, 5).map((record) => record.id);
    const before = writes.count;

    const removed = await store.removeKeys(doomed);

    assert.equal(removed.length, 5);
    assert.equal(writes.count - before, 1, '批量删除是一次编辑，不是 5 次');
    assert.equal(store.keysInOrder().length, 1);
    assert.equal(store.keysInOrder()[0].id, records[5].id, '没被点到的那些原样保留');
    assert.equal(store.statsOf(records[0].id), undefined, '统计随记录一起删掉');
    assert.equal(store.usageOf(records[0].id), undefined, '余额缓存同理');
    const onDisk = JSON.parse(await readFile(store.filePath, 'utf8'));
    assert.equal(onDisk.keys.length, 1);
    assert.deepEqual(onDisk.order, [records[5].id]);
  });

  test('未知 id 被静默忽略（存在性判断属于调用方）', async () => {
    // 存储层不做领域判断：`lib/panel.js` 才是那个先校验再删的地方（它要保证「一个不存在的
    // id 一把都不删」）。这里如实记录这条分工，免得将来有人把校验挪进存储层。
    const { store, writes } = await countingStore();
    const [only] = await store.addKeys({ keys: [{ key: 'tvly-dev-remove-only-0000000000' }] });

    const removed = await store.removeKeys(['no-such-id']);

    assert.deepEqual(removed, []);
    assert.equal(store.keysInOrder().length, 1, '未知 id 不该动到已有的记录');
    assert.equal(writes.count, 2, '加上第一次添加，一共两次写入');
    assert.equal(store.keysInOrder()[0].id, only.id);
  });

  test('空列表什么都不做，也不落盘', async () => {
    const { store, writes } = await countingStore();
    await store.addKeys({ keys: [{ key: 'tvly-dev-remove-empty-000000000' }] });
    const before = writes.count;

    assert.deepEqual(await store.removeKeys([]), []);
    assert.deepEqual(await store.removeKeys(undefined), []);
    assert.equal(writes.count, before, '没东西可删时不该产生一次写入');
  });
});

describe('22 C1：密钥池的真源是磁盘，内存只是它的缓存', () => {
  /**
   * 一份**非空**的初始状态：先由另一个存储把密钥写进磁盘，再让被测存储加载它。
   *
   * 「先在磁盘上放一份非空的池」是 ticket `21` 留下的纪律：总是从零开始的固件会让
   * 「忘记读已有状态」这类缺陷隐形，而本组用例测的正是「运行期磁盘变了会怎样」。
   *
   * @param keys - 初始密钥明文，按顺序写进磁盘。
   * @returns `{ writer, store, filePath, disk }`——`writer` 扮演另一个进程（或用户手工编辑），
   *   `store` 是被测的那个「本进程」。
   */
  async function seededStore(keys) {
    const dir = await mkdtemp(join(tmpdir(), 'dsh-tavily-pool-truth-'));
    const filePath = join(dir, 'keys.json');
    const writer = await new PoolStore({ dir, fileName: 'keys.json' }).load();
    for (const key of keys) await writer.addKey({ key });
    const store = await new PoolStore({ dir, fileName: 'keys.json' }).load();
    return { writer, store, filePath, disk: async () => JSON.parse(await readFile(filePath, 'utf8')) };
  }

  test('外部新增的密钥不会被下一次与密钥无关的记账写入覆盖', async () => {
    // 搜索命中密钥之后的统计落盘走的就是 writeStats 这条路：它与密钥内容毫无关系，
    // 却是把外部补进来的那把抹掉的那次写入。
    const { writer, store, disk } = await seededStore(['tvly-dev-first-aaaaaaaaaaaa']);
    await writer.addKey({ key: 'tvly-dev-added-bbbbbbbbbbbb' });

    await store.writeStats(store.keysInOrder()[0].id, () => ({ calls: 1 }));

    assert.deepEqual(
      (await disk()).keys.map((entry) => entry.key),
      ['tvly-dev-first-aaaaaaaaaaaa', 'tvly-dev-added-bbbbbbbbbbbb'],
      '外部补进来的那把必须还在磁盘上',
    );
    assert.deepEqual(
      store.keysInOrder().map((entry) => entry.key),
      ['tvly-dev-first-aaaaaaaaaaaa', 'tvly-dev-added-bbbbbbbbbbbb'],
      '内存里的候选也要跟上磁盘',
    );
  });

  test('外部删除的密钥不再被使用，也不会被下一次落盘写回', async () => {
    const { writer, store, disk } = await seededStore(['tvly-dev-doomed-aaaaaaaaaaaa', 'tvly-dev-kept-bbbbbbbbbbbb']);
    const [doomed, kept] = store.keysInOrder();
    await writer.removeKey(doomed.id);

    await store.writeStats(kept.id, () => ({ calls: 1 }));

    assert.deepEqual(
      store.keysInOrder().map((entry) => entry.key),
      ['tvly-dev-kept-bbbbbbbbbbbb'],
      '调度器手里的候选必须去掉它',
    );
    assert.deepEqual(
      (await disk()).keys.map((entry) => entry.key),
      ['tvly-dev-kept-bbbbbbbbbbbb'],
      '它也不得被写回磁盘',
    );
  });

  test('外部改过的记录字段以磁盘为准（本进程没碰过它时）', async () => {
    const { writer, store, disk } = await seededStore(['tvly-dev-first-aaaaaaaaaaaa']);
    const id = store.keysInOrder()[0].id;
    await writer.rename(id, '外部改的备注');
    await writer.setDisabled(id, true);

    await store.writeStats(id, () => ({ calls: 2 }));

    const document = await disk();
    assert.equal(document.keys[0].label, '外部改的备注', '外部的编辑不得被内存里那份旧记录覆盖');
    assert.equal(document.keys[0].disabled, true);
    assert.equal(document.stats[id].calls, 2, '而统计仍以本进程为准');
  });

  test('本进程刚做的编辑与外部改动同时存在时，两边都不丢', async () => {
    // 只做「磁盘优先」是不够的：本进程的面板编辑在落盘之前只存在于内存里，磁盘上还没有它。
    // 归并因此要按「本进程改过哪几条」把编辑意图叠到磁盘之上。
    const { writer, store, disk } = await seededStore(['tvly-dev-first-aaaaaaaaaaaa']);
    const id = store.keysInOrder()[0].id;
    await writer.addKey({ key: 'tvly-dev-external-bbbbbbbbbbbb' });

    await store.rename(id, '本进程改的');

    const document = await disk();
    assert.deepEqual(
      document.keys.map((entry) => entry.key),
      ['tvly-dev-first-aaaaaaaaaaaa', 'tvly-dev-external-bbbbbbbbbbbb'],
    );
    assert.equal(document.keys[0].label, '本进程改的', '本进程的编辑必须落盘，而不是被磁盘那份盖回去');
  });

  test('统计与余额缓存以本进程为准，外部改过的统计不会把运行期记账顶掉', async () => {
    const { store, filePath, disk } = await seededStore(['tvly-dev-first-aaaaaaaaaaaa']);
    const id = store.keysInOrder()[0].id;
    await store.writeStats(id, () => ({ calls: 1 }));

    // 外部把统计改成一个不属于本进程运行期的值，随后本进程做一次记录级编辑。
    const document = await disk();
    document.stats[id] = { calls: 99 };
    await writeFile(filePath, `${JSON.stringify(document, null, 2)}\n`, 'utf8');

    await store.setDisabled(id, true);

    assert.equal((await disk()).stats[id].calls, 1, '运行期记账是本进程的状态，不会被磁盘上的旧值顶掉');
  });

  test('外部改动如实记在 lastExternalChange 上，供上报出口读走', async () => {
    const { writer, store } = await seededStore(['tvly-dev-first-aaaaaaaaaaaa', 'tvly-dev-second-bbbbbbbbbbbb']);
    const [first, second] = store.keysInOrder();
    assert.equal(store.lastExternalChange, undefined, '还没有外部改动时它是空的');

    await writer.removeKey(first.id);
    await writer.addKey({ key: 'tvly-dev-added-cccccccccccc' });
    await writer.rename(second.id, '外部改的');

    await store.refreshFromDisk();

    assert.equal(store.lastExternalChange.added, 1, '外部新增了一条');
    assert.equal(store.lastExternalChange.removed, 1, '外部删掉了一条');
    assert.equal(store.lastExternalChange.changed, 1, '外部改了一条的字段');
    assert.match(store.lastExternalChange.at, /^\d{4}-\d{2}-\d{2}T/u, '要带上观察时刻');
    assert.deepEqual(
      store.keysInOrder().map((entry) => entry.key),
      ['tvly-dev-second-bbbbbbbbbbbb', 'tvly-dev-added-cccccccccccc'],
      '对账把外部删除与外部新增一起带进内存',
    );
    assert.equal(store.keysInOrder()[0].label, '外部改的', '外部改的字段也在内存里生效');
  });

  test('删除整个文件不等于清空密钥池：读不出来时什么都不做', async () => {
    // 读盘失败（含文件不存在）与「磁盘上是空的」是两件事：把它们当成同一件，会让一次
    // 备份/同步工具的临时挪动把用户手上的密钥清掉。
    const { store, filePath } = await seededStore(['tvly-dev-first-aaaaaaaaaaaa']);
    const { unlink } = await import('node:fs/promises');
    await unlink(filePath);

    await store.refreshFromDisk();

    assert.equal(store.keysInOrder().length, 1, '一次读盘失败不该动内存里的密钥池');
  });

  test('写盘失败的编辑即使期间发生过对账，也整体回滚', async () => {
    // 对账会在一次编辑写盘的**期间**替换内存文档（面板读一次、搜索开始前都会触发它）。
    // 编辑失败时若拿「文档引用没变」当回滚判据，这次没写进去的编辑就会留在内存里——而面板
    // 此刻显示的正是内存，于是用户看到一把磁盘上并不存在的密钥。判据因此是「有没有更晚的编辑」。
    const dir = await mkdtemp(join(tmpdir(), 'dsh-tavily-pool-truth-'));
    const real = await import('node:fs/promises');
    let writes = 0;
    const store = new PoolStore({
      dir,
      fileName: 'keys.json',
      fs: {
        ...real,
        writeFile: async (...args) => {
          writes += 1;
          if (writes === 2) {
            await store.refreshFromDisk();
            throw new Error('simulated edit failure');
          }
          return real.writeFile(...args);
        },
      },
    });
    await store.load();
    const record = await store.addKey({ key: 'tvly-dev-base-aaaaaaaaaaaa' });

    await assert.rejects(() => store.setDisabled(record.id, true), /simulated edit failure/u);

    assert.equal(store.maskedList()[0].disabled, false, '失败的那次编辑不生效');
    const onDisk = JSON.parse(await readFile(store.filePath, 'utf8'));
    assert.equal(onDisk.keys[0].disabled, false, '磁盘上也不生效');
  });
});

describe('22 C3：本版本不认识的顶层键往返保留', () => {
  test('经一次面板编辑之后，未知顶层键与记录级未知字段都还在', async () => {
    // 真实场景：同一台机器上跑过更新版本的插件、或用户手工加了字段，随后回到本版本。
    const dir = await mkdtemp(join(tmpdir(), 'dsh-tavily-pool-extras-'));
    const filePath = join(dir, 'keys.json');
    await writeFile(filePath, `${JSON.stringify({
      version: 1,
      keys: [{ id: 'a', key: 'tvly-dev-first-aaaaaaaaaaaa', disabled: false, note: '记录级未知字段' }],
      order: ['a'],
      stats: {},
      usageCache: {},
      schemaExtras: { writtenBy: 'future-version' },
      labels: ['自定义顶层键'],
    }, null, 2)}\n`, 'utf8');

    const store = await new PoolStore({ dir, fileName: 'keys.json' }).load();
    await store.setDisabled('a', true);

    const document = JSON.parse(await readFile(filePath, 'utf8'));
    assert.deepEqual(document.schemaExtras, { writtenBy: 'future-version' }, '未知顶层键必须原样带上');
    assert.deepEqual(document.labels, ['自定义顶层键']);
    assert.equal(document.keys[0].note, '记录级未知字段', '记录级未知字段同样保留');
    assert.equal(document.keys[0].disabled, true, '而这次编辑本身照常生效');
  });

  test('进程运行期间外部写下的未知顶层键，也不被下一次落盘抹掉', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'dsh-tavily-pool-extras-'));
    const filePath = join(dir, 'keys.json');
    const writer = await new PoolStore({ dir, fileName: 'keys.json' }).load();
    await writer.addKey({ key: 'tvly-dev-first-aaaaaaaaaaaa' });
    const store = await new PoolStore({ dir, fileName: 'keys.json' }).load();
    const id = store.keysInOrder()[0].id;

    // 外部（用户手工编辑）补一个本版本不认识的顶层键。
    const document = JSON.parse(await readFile(filePath, 'utf8'));
    document.schemaExtras = { writtenBy: 'future-version' };
    await writeFile(filePath, `${JSON.stringify(document, null, 2)}\n`, 'utf8');

    await store.writeStats(id, () => ({ calls: 1 }));

    const written = JSON.parse(await readFile(filePath, 'utf8'));
    assert.deepEqual(written.schemaExtras, { writtenBy: 'future-version' }, '外部写的未知顶层键跟着磁盘走');
    assert.equal(written.stats[id].calls, 1, '本进程的统计照常落盘');
  });
});

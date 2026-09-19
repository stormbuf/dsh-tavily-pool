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

  test('并发写入串行执行，而不是互相覆盖', async () => {
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
    assert.equal(store.firstUsableKey(), 'tvly-dev-working-bbbbbbbbbbbb');
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

describe('issue 01 的密钥选择', () => {
  test('按用户顺序使用第一把启用的密钥', async () => {
    const store = await temporaryStore();
    await store.load();
    const first = await store.addKey({ key: 'tvly-dev-first-aaaaaaaaaaaa' });
    await store.addKey({ key: 'tvly-dev-second-bbbbbbbbbbbb' });
    assert.equal(store.firstUsableKey(), 'tvly-dev-first-aaaaaaaaaaaa');

    await store.update((document) => {
      const entry = document.keys.find((candidate) => candidate.id === first.id);
      entry.disabled = true;
      return document;
    });
    assert.equal(store.firstUsableKey(), 'tvly-dev-second-bbbbbbbbbbbb');
  });

  test('池为空时报告没有密钥', async () => {
    const store = await temporaryStore();
    await store.load();
    assert.equal(store.firstUsableKey(), undefined);
  });
});

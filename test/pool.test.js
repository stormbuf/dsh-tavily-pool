/**
 * Key-pool persistence, against a real temporary directory.
 *
 * The behaviours that matter here are the ones a user would notice: a damaged
 * file must not lose their keys or stop the plugin, a write must never leave a
 * half-written file, and no surface outside the local file may ever see a
 * plaintext key.
 */

import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { describe } from 'node:test';

import { maskKey, PoolFileError, PoolStore, validatePool } from '../lib/pool.js';

/** A store backed by a fresh temporary directory. */
async function temporaryStore() {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-tavily-pool-test-'));
  return new PoolStore({ dir, fileName: 'keys.json' });
}

describe('POOL-6: writes are atomic', () => {
  test('a write replaces the file through a rename, leaving no temporary behind', async () => {
    const store = await temporaryStore();
    await store.load();
    await store.addKey({ key: 'tvly-dev-aaaaaaaaaaaaaaaaaaaa' });

    const entries = await readdir(store.dir);
    assert.deepEqual(entries, ['keys.json'], 'no .tmp file may survive a successful write');

    const written = JSON.parse(await readFile(store.filePath, 'utf8'));
    assert.equal(written.keys.length, 1);
    assert.equal(written.order.length, 1);
  });

  test('concurrent writes serialize instead of clobbering each other', async () => {
    const store = await temporaryStore();
    await store.load();

    // Five writers entering at once. If the store did not chain them, each
    // would snapshot the same empty document and the last rename would win,
    // leaving one key where five were added.
    await Promise.all(
      ['a', 'b', 'c', 'd', 'e'].map((suffix) => store.addKey({ key: `tvly-dev-key-${suffix}-000000000000` })),
    );

    assert.equal(store.keysInOrder().length, 5, 'every add must survive');
    const onDisk = JSON.parse(await readFile(store.filePath, 'utf8'));
    assert.equal(onDisk.keys.length, 5, 'and every add must be on disk');
    assert.deepEqual(
      onDisk.order.slice().sort(),
      onDisk.keys.map((entry) => entry.id).sort(),
      'the order list must still name exactly the stored keys',
    );
  });

  test('a failed write does not poison later writes', async () => {
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

  test('a rejected mutation leaves neither the file nor memory changed', async () => {
    const store = await temporaryStore();
    await store.load();
    await store.addKey({ key: 'tvly-dev-original-aaaaaaaaaaaa' });
    const before = await readFile(store.filePath, 'utf8');

    await assert.rejects(async () => {
      await store.update(() => {
        throw new Error('the caller changed its mind');
      });
    }, /changed its mind/u);

    assert.equal(await readFile(store.filePath, 'utf8'), before, 'the file must be untouched');
    assert.equal(store.keysInOrder().length, 1, 'and so must the in-memory document');
  });

  test('an interrupted write leaves the previous file intact', async () => {
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

    assert.equal(await readFile(store.filePath, 'utf8'), before, 'the file must be byte-identical');
    const entries = await readdir(dir);
    assert.deepEqual(entries, ['keys.json'], 'the abandoned temporary must be cleaned up');
  });
});

describe('POOL-7: a damaged file is reported, not thrown', () => {
  test('a missing file is a normal first run', async () => {
    const store = await temporaryStore();
    await store.load();
    assert.equal(store.loadError, undefined);
    assert.deepEqual(store.keysInOrder(), []);
  });

  test('invalid JSON starts empty and keeps the file untouched', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'dsh-tavily-pool-test-'));
    const filePath = join(dir, 'keys.json');
    await writeFile(filePath, '{ this is not json', 'utf8');

    const store = await new PoolStore({ dir, fileName: 'keys.json' }).load();

    assert.ok(store.loadError instanceof PoolFileError);
    assert.equal(store.loadError.reason, 'malformed');
    assert.deepEqual(store.keysInOrder(), [], 'the plugin must still work, with an empty pool');
    assert.equal(await readFile(filePath, 'utf8'), '{ this is not json', 'the original must be preserved');
  });

  test('a schema mismatch starts empty and keeps the file untouched', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'dsh-tavily-pool-test-'));
    const filePath = join(dir, 'keys.json');
    const original = JSON.stringify({ version: 99, keys: 'not an array' });
    await writeFile(filePath, original, 'utf8');

    const store = await new PoolStore({ dir, fileName: 'keys.json' }).load();

    assert.ok(store.loadError instanceof PoolFileError);
    assert.equal(await readFile(filePath, 'utf8'), original);
  });
});

describe('pool document validation', () => {
  test('accepts a well-formed document', () => {
    const document = validatePool({
      version: 1,
      keys: [{ id: 'a', key: 'tvly-dev-aaaaaaaaaaaaaaaa', disabled: false }],
      order: ['a'],
      stats: {},
      usageCache: {},
    });
    assert.equal(document.keys.length, 1);
  });

  test('repairs a stale order list instead of discarding the keys', () => {
    const document = validatePool({
      version: 1,
      keys: [{ id: 'a', key: 'k-a' }, { id: 'b', key: 'k-b' }],
      order: ['b', 'ghost', 'b'],
    });
    assert.deepEqual(document.order, ['b', 'a'], 'unknown ids drop, missing ids append, duplicates collapse');
  });

  test('rejects a key with no id', () => {
    assert.throws(
      () => validatePool({ version: 1, keys: [{ key: 'k' }], order: [] }),
      /has no id/u,
    );
  });

  test('rejects a key with no key material', () => {
    assert.throws(
      () => validatePool({ version: 1, keys: [{ id: 'a', key: '' }], order: ['a'] }),
      /has no key/u,
    );
  });
});

describe('POOL-3: masking', () => {
  test('shows enough to recognize a key and not enough to use it', () => {
    const masked = maskKey('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');
    assert.equal(masked, 'tvly-dev-…iJWq');
    assert.equal(masked.includes('U03Fq7'), false, 'the middle must not survive');
  });

  test('masks a short key without revealing a usable prefix', () => {
    assert.equal(maskKey('tvly-abc'), 'tv…c');
  });

  test('the masked list never carries plaintext', async () => {
    const store = await temporaryStore();
    await store.load();
    const secret = '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';
    await store.addKey({ key: secret, label: 'primary' });

    const serialized = JSON.stringify(store.maskedList());
    assert.equal(serialized.includes(secret), false, 'plaintext must not appear in the panel view');
    assert.equal(serialized.includes('U03Fq7'), false, 'nor any long interior slice of it');
    assert.match(serialized, /tvly-dev-…iJWq/u);
  });
});

describe('key selection for issue 01', () => {
  test('uses the first enabled key in user order', async () => {
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

  test('reports no key when the pool is empty', async () => {
    const store = await temporaryStore();
    await store.load();
    assert.equal(store.firstUsableKey(), undefined);
  });
});

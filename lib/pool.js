/**
 * Key-pool persistence.
 *
 * Host-free (`COMPAT-1`): the state directory and the filesystem operations are
 * injected, so the module runs under `node:test` against a temporary directory
 * and never learns where `~/.dsh` is.
 *
 * This is the subset issue `01` needs — load the pool, persist it atomically,
 * and hand out a usable key. Masking, the full edit surface, quota caches, and
 * the panel's HTTP API belong to issues `02`, `06`, and `09`.
 *
 * @module dsh-tavily-pool/pool
 */

import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

/** Schema version of the pool document. */
export const POOL_SCHEMA_VERSION = 1;

/**
 * How many leading characters of a key stay visible when masking.
 *
 * `tvly-` plus a few characters is enough for a human to tell two keys apart
 * and far too little to be usable as a credential.
 */
const MASK_PREFIX_CHARS = 9;

/** How many trailing characters stay visible when masking. */
const MASK_SUFFIX_CHARS = 4;

/**
 * Mask a key for every surface that is not the local file itself (`POOL-3`).
 *
 * A key short enough that the visible halves would overlap is masked whole
 * rather than partly revealed: there is no way to show part of it safely.
 *
 * @param key - plaintext key.
 * @returns the masked form, e.g. `tvly-dev-…aV2i`.
 */
export function maskKey(key) {
  if (typeof key !== 'string' || key.length === 0) return '';
  if (key.length <= MASK_PREFIX_CHARS + MASK_SUFFIX_CHARS) return `${key.slice(0, 2)}…${key.slice(-1)}`;
  return `${key.slice(0, MASK_PREFIX_CHARS)}…${key.slice(-MASK_SUFFIX_CHARS)}`;
}

/** A fresh, valid pool document. */
export function emptyPool() {
  return { version: POOL_SCHEMA_VERSION, keys: [], order: [], stats: {}, usageCache: {} };
}

/** Whether a value is a plain (non-array, non-null) object. */
function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/**
 * The failure recorded when the pool file exists but cannot be trusted.
 *
 * Reported rather than thrown (`POOL-7`): a damaged file must not stop the
 * plugin from loading, because a pool that starts empty is still a working
 * plugin while a plugin that refuses to load takes search down with it.
 */
export class PoolFileError extends Error {
  /**
   * @param message - what is wrong with the file.
   * @param path - the offending file.
   * @param options - failure facts.
   * @param options.reason - `'unreadable'` or `'malformed'`.
   * @param options.cause - the decoder or validator error.
   */
  constructor(message, path, options = {}) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = 'PoolFileError';
    this.path = path;
    this.reason = options.reason ?? 'malformed';
  }
}

/**
 * Validate a decoded pool document.
 *
 * Strict about the parts later code indexes by id, lenient about additive
 * fields, so a file written by a newer version of this plugin is not discarded
 * merely for carrying extra data.
 *
 * @param value - decoded JSON value.
 * @returns the accepted document.
 * @throws {TypeError} when the shape is not a pool document.
 */
export function validatePool(value) {
  if (!isPlainObject(value)) throw new TypeError('pool document must be a JSON object');
  if (value.version !== POOL_SCHEMA_VERSION) {
    throw new TypeError(`pool document version ${String(value.version)} is not ${String(POOL_SCHEMA_VERSION)}`);
  }
  if (!Array.isArray(value.keys)) throw new TypeError('pool document "keys" must be an array');
  if (!Array.isArray(value.order)) throw new TypeError('pool document "order" must be an array');

  const keys = value.keys.map((entry, index) => {
    if (!isPlainObject(entry)) throw new TypeError(`pool key #${String(index)} must be an object`);
    if (typeof entry.id !== 'string' || entry.id.length === 0) {
      throw new TypeError(`pool key #${String(index)} has no id`);
    }
    if (typeof entry.key !== 'string' || entry.key.length === 0) {
      throw new TypeError(`pool key #${String(index)} has no key`);
    }
    return { ...entry, disabled: entry.disabled === true };
  });

  // A missing or stale order entry is repaired rather than rejected: order is a
  // presentation preference, not a data-integrity fact, and rejecting the file
  // over it would throw away the user's keys.
  const ids = new Set(keys.map((entry) => entry.id));
  const order = value.order.filter((id, index) => ids.has(id) && value.order.indexOf(id) === index);
  for (const entry of keys) if (!order.includes(entry.id)) order.push(entry.id);

  return {
    version: POOL_SCHEMA_VERSION,
    keys,
    order,
    stats: isPlainObject(value.stats) ? value.stats : {},
    usageCache: isPlainObject(value.usageCache) ? value.usageCache : {},
  };
}

/**
 * The pool store: load once, persist atomically, and hand out keys in order.
 *
 * Writes are serialized through one promise chain so two concurrent edits
 * cannot interleave into a half-applied file, and each write goes to a
 * temporary file that is renamed over the target (`POOL-6`). A rename within a
 * directory is atomic, so an interrupted write leaves the previous file intact
 * rather than a truncated one.
 */
export class PoolStore {
  #filePath;
  #document = emptyPool();
  #loadError;
  #writeChain = Promise.resolve();

  /**
   * @param options - store location and filesystem seams.
   * @param options.dir - resolved state directory; never a hardcoded path.
   * @param options.fileName - pool file name inside `dir`.
   * @param options.fs - filesystem operations, injectable for tests.
   */
  constructor({ dir, fileName, fs = { mkdir, readFile, rename, unlink, writeFile } }) {
    this.#filePath = join(dir, fileName);
    this.dir = dir;
    this.fs = fs;
  }

  /** Absolute path of the pool file. */
  get filePath() {
    return this.#filePath;
  }

  /**
   * The load-time failure, when the file could not be trusted (`POOL-7`).
   *
   * @returns the error, or `undefined` when the file loaded or did not exist.
   */
  get loadError() {
    return this.#loadError;
  }

  /**
   * Read the pool from disk.
   *
   * A missing file is a normal first run. A damaged one is left exactly as
   * found and reported through {@link loadError}; the store then operates on an
   * empty pool, and the next successful write starts a fresh file.
   *
   * @returns the store, for chaining.
   */
  async load() {
    let raw;
    try {
      raw = await this.fs.readFile(this.#filePath, 'utf8');
    } catch (error) {
      this.#document = emptyPool();
      this.#loadError = error?.code === 'ENOENT'
        ? undefined
        : new PoolFileError(
          `key pool at ${this.#filePath} could not be read: ${String(error)}`,
          this.#filePath,
          { reason: 'unreadable', cause: error },
        );
      return this;
    }

    let decoded;
    try {
      decoded = JSON.parse(raw);
    } catch (error) {
      this.#document = emptyPool();
      this.#loadError = new PoolFileError(
        `key pool at ${this.#filePath} is not valid JSON: ${String(error)}`,
        this.#filePath,
        { reason: 'malformed', cause: error },
      );
      return this;
    }

    try {
      this.#document = validatePool(decoded);
      this.#loadError = undefined;
    } catch (error) {
      this.#document = emptyPool();
      this.#loadError = new PoolFileError(
        `key pool at ${this.#filePath} does not match the expected schema: ${String(error.message)}`,
        this.#filePath,
        { reason: 'malformed', cause: error },
      );
    }
    return this;
  }

  /** A detached copy of the current document. */
  snapshot() {
    return structuredClone(this.#document);
  }

  /** Every key record, in the user's order, including disabled ones. */
  keysInOrder() {
    const byId = new Map(this.#document.keys.map((entry) => [entry.id, entry]));
    return this.#document.order.map((id) => byId.get(id)).filter((entry) => entry !== undefined);
  }

  /**
   * The plaintext key to use for the next search.
   *
   * Issue `01` has no scheduler yet, so this is the first enabled key in user
   * order. Balance-aware selection and the hard exclusions replace it in the
   * scheduler and health issues; the caller treats this as "one attempt's key",
   * not as a decision.
   *
   * @returns the key, or `undefined` when the pool has no usable entry.
   */
  firstUsableKey() {
    return this.keysInOrder().find((candidate) => candidate.disabled !== true)?.key;
  }

  /**
   * Persist a mutation and replace the in-memory document with its result.
   *
   * The mutator receives a detached copy: if it throws, nothing is written and
   * the in-memory document is unchanged, so a rejected edit cannot leave the
   * store describing a state that was never saved.
   *
   * @param mutate - receives a copy of the document and returns the next one.
   * @returns the persisted document.
   */
  async update(mutate) {
    const run = async () => {
      const next = validatePool(await mutate(this.snapshot()));
      await this.#persist(next);
      this.#document = next;
      this.#loadError = undefined;
      return next;
    };
    // Chain unconditionally, and keep the chain alive after a rejection so one
    // failed write does not poison every later one.
    const result = this.#writeChain.then(run, run);
    this.#writeChain = result.then(() => undefined, () => undefined);
    return result;
  }

  /**
   * Add a key (`POOL-2`).
   *
   * @param options - the new key.
   * @param options.key - plaintext key.
   * @param options.label - optional user note.
   * @param options.nowMs - current epoch milliseconds.
   * @returns the created record.
   */
  async addKey({ key, label, nowMs = Date.now() }) {
    const record = {
      id: randomUUID(),
      key,
      ...label === undefined || label.length === 0 ? {} : { label },
      addedAt: new Date(nowMs).toISOString(),
      disabled: false,
    };
    await this.update((document) => {
      document.keys.push(record);
      document.order.push(record.id);
      return document;
    });
    return record;
  }

  /**
   * The masked view the panel and every HTTP response receive (`POOL-3`).
   *
   * Built by allow-list rather than by deleting `key`, so a field added to the
   * record later cannot leak through this function by default.
   *
   * @returns one entry per key, plaintext excluded.
   */
  maskedList() {
    return this.keysInOrder().map((entry) => ({
      id: entry.id,
      masked: maskKey(entry.key),
      label: entry.label ?? '',
      addedAt: entry.addedAt,
      disabled: entry.disabled,
      stats: this.#document.stats[entry.id] ?? undefined,
      usage: this.#document.usageCache[entry.id] ?? undefined,
    }));
  }

  /** Write the document through a temporary file and an atomic rename. */
  async #persist(document) {
    await this.fs.mkdir(dirname(this.#filePath), { recursive: true, mode: 0o700 });
    const temporary = `${this.#filePath}.${String(process.pid)}.${randomUUID()}.tmp`;
    try {
      await this.fs.writeFile(temporary, `${JSON.stringify(document, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
      await this.fs.rename(temporary, this.#filePath);
    } catch (error) {
      // A failed write or rename would otherwise leave the temporary file
      // behind on every retry, slowly filling the directory.
      await this.fs.unlink(temporary).catch(() => undefined);
      throw error;
    }
  }
}

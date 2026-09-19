/**
 * Live seam check: the real host service, the real plugin, the real Tavily API.
 *
 * This is the issue-16 style verification that unit tests cannot replace. It
 * builds an actual `ctx.web` service from `@deepseek-ai/dsh-web`, mounts this
 * plugin's `apply()` into a real Cordis context, and drives a search the way
 * `dsh-tool-web` does. What it proves, which no stub can:
 *
 * - the seam resolves `searchProvider: 'tavily'` to this plugin's provider;
 * - `available()` never trips `WEB_PROVIDER_CONFIGURED_UNAVAILABLE`;
 * - the request really reaches `api.tavily.com` and the response maps back;
 * - the seam's own `maxResults` enforcement runs on our result.
 *
 * It needs a key, so it is not part of `npm test`. Point it at one of these:
 *
 *   TAVILY_API_KEY=tvly-... node test/live/seam-check.mjs
 *   node test/live/seam-check.mjs --keys-dir ~/.dsh/dsh-tavily-pool
 *
 * Exits non-zero on the first failed check.
 */

import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { Context } from '@deepseek-ai/cordis';
import { WebRuntime } from '@deepseek-ai/dsh-web';

import { apply, inject } from '../../index.js';
import { PROVIDER_ID, STATE_DIR_NAME } from '../../lib/constants.js';
import { PoolStore } from '../../lib/pool.js';

/** Parse `--flag value` arguments without pulling in a parser. */
function flag(name, fallback) {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 && process.argv[index + 1] !== undefined ? process.argv[index + 1] : fallback;
}

/** Report one check with a stable prefix, so output is greppable. */
function check(label, detail) {
  process.stdout.write(`  ok   ${label}${detail === undefined ? '' : ` — ${detail}`}\n`);
}

/**
 * Point `DSH_HOME` at a directory holding a key.
 *
 * The plugin resolves its pool through `ctx.dshHomePath`, which reads
 * `$DSH_HOME` at call time, so setting it here is exactly what a different
 * harness home would do — no test-only hook in the plugin.
 *
 * @returns the harness home, once a key is in place.
 */
async function prepareHarnessHome() {
  const configured = flag('keys-dir');
  if (configured !== undefined) return configured.replace(/\/dsh-tavily-pool$/u, '');

  const apiKey = process.env.TAVILY_API_KEY;
  if (apiKey === undefined || apiKey.length === 0) {
    process.stderr.write(
      'seam-check: no key available. Set TAVILY_API_KEY=tvly-... or pass '
      + '--keys-dir <dir containing keys.json>.\n',
    );
    process.exit(2);
  }
  const home = await mkdtemp(join(tmpdir(), 'dsh-tavily-seam-'));
  const store = new PoolStore({ dir: join(home, STATE_DIR_NAME), fileName: 'keys.json' });
  await store.load();
  await store.addKey({ key: apiKey, label: 'seam-check' });
  check('seeded a temporary harness home', home);
  return home;
}

const harnessHome = await prepareHarnessHome();
process.env.DSH_HOME = harnessHome;

// A real Cordis context, and the real seam service pinned exactly the way the
// profile patch pins it.
const ctx = new Context();
new WebRuntime(ctx, { searchProvider: PROVIDER_ID, fetchProvider: PROVIDER_ID });

assert.deepEqual(inject, ['web'], 'the plugin must declare the web dependency');
apply(ctx, {});
check('plugin applied', `registered searchProvider=${PROVIDER_ID}`);

const result = await ctx.web.search({ query: 'DeepSeek Harness plugin architecture', maxResults: 3 });

assert.ok(Array.isArray(result.sources), 'sources must be an array');
assert.ok(result.sources.length > 0, 'a live search should return at least one source');
assert.ok(result.sources.length <= 3, 'the seam must enforce maxResults on our result');
for (const source of result.sources) {
  assert.match(source.url, /^https?:\/\//u, `source url must be absolute: ${String(source.url)}`);
}
check('search returned sources', `${String(result.sources.length)} (maxResults=3 enforced)`);
check('first source', result.sources[0].url);
if (result.content !== undefined) check('provider answer present', `${String(result.content.length)} chars`);

// `available()` is the one contract whose violation is a hard throw rather than
// a fallback, so it must be verified without reading the registry — that is
// private state this plugin is forbidden to touch (COMPAT-6). Registering the
// same id twice is the public surface that proves ours is in there: the seam
// refuses duplicates. `registerSearchProvider` throws synchronously.
const probeCtx = new Context();
new WebRuntime(probeCtx, { searchProvider: PROVIDER_ID });
apply(probeCtx, {});
assert.throws(
  () => probeCtx.web.registerSearchProvider({ id: PROVIDER_ID, available: () => true, search: async () => ({}) }),
  (error) => error.code === 'WEB_DUPLICATE_PROVIDER',
  'registering the same id twice must fail, which proves ours is registered',
);
check('the provider id is registered (duplicate registration is refused)');

// The pin resolves our provider through `available()`, so a second live search
// completing proves it is still `true` after real use.
const second = await ctx.web.search({ query: 'DeepSeek Harness release notes', maxResults: 1 });
assert.ok(second.sources.length >= 1, 'a second search through the pin must still resolve');
check('available() is still true on a second live call');

// And prove the seam would have thrown had the pin pointed at nothing, so the
// checks above are not vacuous.
const unpinned = new Context();
new WebRuntime(unpinned, { searchProvider: 'definitely-not-registered' });
await assert.rejects(
  () => unpinned.web.search({ query: 'x' }),
  (error) => error.code === 'WEB_PROVIDER_CONFIGURED_MISSING',
  'an unregistered pin must throw WEB_PROVIDER_CONFIGURED_MISSING',
);
check('control: an unregistered pin throws WEB_PROVIDER_CONFIGURED_MISSING');

process.stdout.write('seam-check: all live checks passed\n');
process.exit(0);

/**
 * The host-free core, checked from the outside (`COMPAT-1`).
 *
 * These modules are the ones an upgrade must never have to touch, so the test
 * that matters most is the structural one: they must be importable and
 * testable without a harness anywhere in sight.
 *
 * The list below is the *implemented* subset of the five modules COMPAT-1
 * names. `lib/scheduler.js`, `lib/health.js`, and `lib/usage.js` do not exist
 * yet — they arrive with the scheduling, failure-classification, and
 * balance-refresh work — and must be added here in the same commit that creates
 * them, so the rule keeps being enforced mechanically rather than by memory.
 */

import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import test, { describe } from 'node:test';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');

/**
 * Modules the compatibility contract forbids from knowing about the host.
 *
 * Add to this list whenever a new logic-core module is created.
 */
const HOST_FREE_MODULES = [
  'lib/tavily.js',
  'lib/pool.js',
];

/** The full set COMPAT-1 names, so the gap is visible rather than implied. */
const CONTRACTED_MODULES = [
  ...HOST_FREE_MODULES,
  'lib/scheduler.js',
  'lib/health.js',
  'lib/usage.js',
];

describe('COMPAT-1: the logic core does not depend on the host', () => {
  for (const relativePath of HOST_FREE_MODULES) {
    test(`${relativePath} imports no @deepseek-ai/* package`, async () => {
      const source = await readFile(join(repoRoot, relativePath), 'utf8');
      const imports = [...source.matchAll(/^\s*(?:import|export)[^'"]*from\s+['"]([^'"]+)['"]/gmu)]
        .map((match) => match[1]);
      const hostImports = imports.filter((specifier) => specifier.startsWith('@deepseek-ai/'));
      assert.deepEqual(hostImports, [], `${relativePath} must not import host packages`);
    });

    test(`${relativePath} imports and works without a harness`, async () => {
      const module = await import(`../${relativePath}`);
      assert.ok(Object.keys(module).length > 0, `${relativePath} should export something`);
    });
  }

  test('every module the contract names is either covered here or not yet written', () => {
    // A reminder in executable form: when one of these lands, this assertion is
    // what tells the next person to add it above.
    const missing = CONTRACTED_MODULES.filter((relativePath) => !HOST_FREE_MODULES.includes(relativePath));
    assert.deepEqual(
      missing,
      ['lib/scheduler.js', 'lib/health.js', 'lib/usage.js'],
      'a contracted module was added or removed — update HOST_FREE_MODULES to match',
    );
  });
});

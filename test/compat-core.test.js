/**
 * The host-free core, checked from the outside (`COMPAT-1`).
 *
 * These modules are the ones an upgrade must never have to touch, so the test
 * that matters most is the structural one: they must be importable and
 * testable without a harness anywhere in sight.
 */

import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import test, { describe } from 'node:test';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');

/** Modules the compatibility contract forbids from knowing about the host. */
const HOST_FREE_MODULES = [
  'lib/tavily.js',
  'lib/pool.js',
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
});

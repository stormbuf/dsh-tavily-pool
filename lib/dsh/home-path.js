/**
 * The key pool path, resolved through the host.
 *
 * `DOC-4` forbids hardcoded machine paths and requires user-level directories to
 * come from the host's own home resolver. Keeping that resolution here — rather
 * than importing the host path helper from the core — is what lets `lib/pool.js`
 * take a plain directory string and stay testable under `node:test`.
 *
 * @module dsh-tavily-pool/dsh/home-path
 */

import { join } from 'node:path';

import { STATE_DIR_NAME } from '../constants.js';
import { readService } from './read-service.js';

/**
 * Resolve the directory holding this plugin's state.
 *
 * The host helper is consulted first — through the reflective read, because it
 * is an optional capability and the context proxy throws on an un-injected
 * service name. The fallback exists only so a missing capability degrades to a
 * less authoritative path rather than a throw during load (`COMPAT-3`); it
 * mirrors the host resolver's documented precedence (`$DSH_HOME`, then the OS
 * home) so the degraded path still lands on the same file rather than inventing
 * a new one.
 *
 * @param ctx - plugin context.
 * @returns the absolute state directory.
 * @throws {Error} when no home can be determined at all.
 */
export function resolveStateDir(ctx) {
  const hostResolver = readService(ctx, 'dshHomePath');
  if (typeof hostResolver === 'function') return hostResolver(STATE_DIR_NAME);

  const configured = process.env.DSH_HOME?.trim();
  if (configured !== undefined && configured.length > 0) return join(configured, STATE_DIR_NAME);

  const osHome = process.env.HOME ?? process.env.USERPROFILE;
  if (osHome === undefined || osHome.length === 0) {
    throw new Error(
      'dsh-tavily-pool: cannot resolve the harness home; ctx.dshHomePath is unavailable '
      + 'and neither $DSH_HOME nor $HOME is set',
    );
  }
  return join(osHome, '.dsh', STATE_DIR_NAME);
}

/**
 * Host capability probe (`COMPAT-2`, `COMPAT-3`).
 *
 * The behaviour under test is what happens when the host changes shape: the
 * plugin must say *which* capability is gone, at load time, and must keep
 * working as far as it can.
 *
 * The stand-in context is deliberately shaped like the real one — services are
 * read through `get(name)`, and reading a non-injected service name *throws* —
 * because that difference is exactly what a probe gets wrong.
 */

import assert from 'node:assert/strict';
import { join } from 'node:path';
import test, { describe } from 'node:test';

import {
  describeMissingCapabilities,
  probeCapabilities,
  REQUIRED_CAPABILITIES,
} from '../lib/dsh/capabilities.js';

/**
 * A context that behaves like Cordis's: `get(name)` is the non-throwing read,
 * and direct property access throws for anything not in `inject`.
 *
 * The returned object exposes `services` so a test can remove one — deleting
 * from `ctx.get(...)` would only mutate whatever the read returned.
 *
 * @param services - the provided services.
 * @returns the fake context, with its service map attached.
 */
function fakeContext(services) {
  const ctx = new Proxy(
    { get: (name) => services[name] },
    {
      get(target, prop) {
        if (prop === 'get') return target.get;
        if (prop === 'services') return services;
        if (prop in services) return services[prop];
        throw new Error(`cannot get property "${String(prop)}" without inject`);
      },
    },
  );
  return ctx;
}

/** A host that satisfies every probed capability. */
function completeHost() {
  return {
    ctx: fakeContext({
      web: { registerSearchProvider() {}, registerFetchProvider() {} },
      settings: { register() {} },
      clientModules: {},
      dshHomePath: (...segments) => join('/home/.dsh', ...segments),
      connection: { fetch: { register() {} } },
    }),
  };
}

describe('COMPAT-2: the probe names what is missing', () => {
  test('a complete host reports nothing missing', () => {
    const report = probeCapabilities(completeHost());
    assert.equal(report.ok, true);
    assert.deepEqual(report.missingRequired, []);
    assert.deepEqual(report.missingOptional, []);
    assert.equal(describeMissingCapabilities(report), '');
  });

  test('an absent service is reported, not thrown on', () => {
    // Reading `ctx.settings` directly would throw "without inject"; the probe
    // must therefore use the reflective read, or it reports a crash instead of
    // a missing capability.
    const host = completeHost();
    delete host.ctx.services.settings;
    const report = probeCapabilities(host);
    assert.equal(report.ok, false);
    assert.deepEqual(report.missingRequired, ['settings.register']);
  });

  test('a reshaped seam is reported as missing, by name', () => {
    const host = completeHost();
    delete host.ctx.services.web.registerSearchProvider;
    const report = probeCapabilities(host);
    assert.equal(report.ok, false);
    assert.deepEqual(report.missingRequired, ['web.registerSearchProvider']);
    const message = describeMissingCapabilities(report);
    assert.match(message, /web\.registerSearchProvider/);
    assert.match(message, /docs\/dsh-upgrade\.md/);
  });

  test('every required capability is genuinely required', () => {
    for (const id of REQUIRED_CAPABILITIES) {
      const host = completeHost();
      if (id === 'web.registerSearchProvider') delete host.ctx.services.web.registerSearchProvider;
      if (id === 'settings.register') delete host.ctx.services.settings;
      if (id === 'clientModules') delete host.ctx.services.clientModules;
      const report = probeCapabilities(host);
      assert.equal(report.ok, false, `removing ${id} should fail the probe`);
      assert.ok(report.missingRequired.includes(id), `${id} should be reported missing`);
    }
  });

  test('a missing optional capability degrades without failing the probe', () => {
    const host = completeHost();
    delete host.ctx.services.dshHomePath;
    delete host.ctx.services.connection;
    const report = probeCapabilities(host);
    assert.equal(report.ok, true, 'optional capabilities must not block loading');
    assert.deepEqual(report.missingOptional, ['dshHomePath', 'connection.fetch.register']);
    assert.match(describeMissingCapabilities(report), /\[optional\] dshHomePath/);
  });

  test('the probe tolerates a context with no services at all', () => {
    const report = probeCapabilities({ ctx: fakeContext({}) });
    assert.equal(report.ok, false);
    assert.deepEqual(report.missingRequired, [...REQUIRED_CAPABILITIES]);
  });

  test('the probe tolerates a context with no reflective read at all', () => {
    const report = probeCapabilities({ ctx: {} });
    assert.equal(report.ok, false);
    assert.deepEqual(report.missingRequired, [...REQUIRED_CAPABILITIES]);
  });
});

/**
 * Host capability probe (`COMPAT-2`, `COMPAT-3`).
 *
 * Every host fact this plugin depends on is checked here, at load time, and
 * reported as one specific missing thing rather than as a failure that first
 * appears when a model calls `web_search`. The re-adaptation checklist in
 * `docs/dsh-upgrade.md` is the human-facing half of the same idea.
 *
 * The probe never throws and never aborts anything. `COMPAT-3` requires the
 * provider to stay registered even when the host has changed shape — a
 * half-working plugin beats a search outage — so the caller decides what to do
 * with the findings, and the findings are surfaced to the panel.
 *
 * Host-aware by design (it lives in `lib/dsh/`), but written against
 * duck-typed shapes so it is exercised with a plain object under `node:test`.
 *
 * @module dsh-tavily-pool/dsh/capabilities
 */

import { readService } from './read-service.js';

/**
 * @typedef {object} CapabilityFinding
 * @property {string} id - stable capability id, usable in a settings panel.
 * @property {'ok'|'missing'} status - the finding.
 * @property {string} detail - what is wrong, naming the exact member.
 * @property {string|undefined} remedy - what to check on a host upgrade.
 */

/**
 * Capabilities without which the plugin cannot do its job at all.
 *
 * These are the three the compatibility contract names: the seam's registration
 * function, settings registration, and the client slot's carrier.
 */
export const REQUIRED_CAPABILITIES = Object.freeze([
  'web.registerSearchProvider',
  'settings.register',
  'clientModules',
]);

/**
 * Capabilities whose absence degrades one feature rather than the takeover.
 *
 * Reported, never blocking: fetch takeover can fall back to the local HTTP
 * provider, the panel can be absent while search still works, and a missing
 * home resolver still resolves a path (just a less authoritative one).
 */
export const OPTIONAL_CAPABILITIES = Object.freeze([
  'web.registerFetchProvider',
  'dshHomePath',
  'connection.fetch.register',
]);

/** What to inspect on the host after an upgrade, per capability. */
const REMEDIES = Object.freeze({
  'web.registerSearchProvider':
    'ctx.web.registerSearchProvider(provider) in @deepseek-ai/dsh-web — the only '
    + 'supported way to contribute a search provider.',
  'settings.register':
    'ctx.settings.register(ns, schema, options) in @deepseek-ai/dsh-settings — how the '
    + 'toggles reach the panel; namespaces cannot be registered twice.',
  clientModules:
    'ctx.clientModules in @deepseek-ai/dsh-client-modules — composes the dsh.client '
    + 'bundles and serves the slot host the settings card registers into.',
  'web.registerFetchProvider':
    'ctx.web.registerFetchProvider(provider) in @deepseek-ai/dsh-web.',
  dshHomePath:
    'ctx.dshHomePath(...segments) in @deepseek-ai/dsh-app-boot — how the key pool reaches '
    + 'the harness home without hardcoding a path.',
  'connection.fetch.register':
    'ctx.connection.fetch.register({path, methods, requestBody, fetch}) in '
    + '@deepseek-ai/dsh-client-connection — the panel HTTP API.',
});

/** Whether a value is callable. */
function isFunction(value) {
  return typeof value === 'function';
}

/**
 * @typedef {object} CapabilityReport
 * @property {CapabilityFinding[]} findings - one entry per checked capability.
 * @property {boolean} ok - true when every required capability is present.
 * @property {string[]} missingRequired - required capability ids that are absent.
 * @property {string[]} missingOptional - optional capability ids that are absent.
 * @property {string} summary - one-line report suitable for a log line.
 */

/**
 * Probe the host for every capability this plugin uses.
 *
 * Services are read through {@link readService} rather than as properties: the
 * context proxy throws on a service the reading fiber did not `inject`, which
 * would turn "the settings service is absent" into "the probe crashed" — the
 * opposite of what a probe is for.
 *
 * @param host - the host surface, gathered by the caller.
 * @param host.ctx - plugin context; absent services are reported, never thrown on.
 * @returns a {@link CapabilityReport}.
 */
export function probeCapabilities(host) {
  const { ctx } = host;
  const web = readService(ctx, 'web');
  const settings = readService(ctx, 'settings');
  const clientModules = readService(ctx, 'clientModules');
  const connection = readService(ctx, 'connection');
  const dshHomePath = readService(ctx, 'dshHomePath');

  const findings = [];

  /** Record one check. */
  const check = (id, present, detail) => {
    findings.push({
      id,
      status: present ? 'ok' : 'missing',
      detail: present ? 'available' : detail,
      remedy: REMEDIES[id],
    });
  };

  check(
    'web.registerSearchProvider',
    isFunction(web?.registerSearchProvider),
    'ctx.web.registerSearchProvider is not a function (the web seam is missing or reshaped)',
  );
  check(
    'settings.register',
    isFunction(settings?.register),
    'ctx.settings.register is not a function (the settings service is missing or reshaped)',
  );
  check(
    'clientModules',
    clientModules !== undefined,
    'ctx.clientModules is absent (the host cannot compose client bundles, so no settings card can render)',
  );
  check(
    'web.registerFetchProvider',
    isFunction(web?.registerFetchProvider),
    'ctx.web.registerFetchProvider is not a function',
  );
  check(
    'dshHomePath',
    isFunction(dshHomePath),
    'ctx.dshHomePath is not a function (the key pool path falls back to $DSH_HOME, then $HOME)',
  );
  check(
    'connection.fetch.register',
    isFunction(connection?.fetch?.register),
    'ctx.connection.fetch.register is not a function (the panel HTTP API is unavailable)',
  );

  const missingRequired = findings
    .filter((finding) => finding.status === 'missing' && REQUIRED_CAPABILITIES.includes(finding.id))
    .map((finding) => finding.id);
  const missingOptional = findings
    .filter((finding) => finding.status === 'missing' && OPTIONAL_CAPABILITIES.includes(finding.id))
    .map((finding) => finding.id);

  const summary = missingRequired.length === 0 && missingOptional.length === 0
    ? 'all probed host capabilities present'
    : `missing capabilities — required [${missingRequired.join(', ')}], optional [${missingOptional.join(', ')}]`;

  return {
    findings,
    ok: missingRequired.length === 0,
    missingRequired,
    missingOptional,
    summary,
  };
}

/**
 * Render a probe report as one actionable error message (`COMPAT-2`): it must
 * name *what* is missing and *where to look*, because its reader is a future
 * maintainer adapting the plugin to a changed host.
 *
 * @param report - a {@link CapabilityReport}.
 * @returns a multi-line message, or an empty string when nothing is missing.
 */
export function describeMissingCapabilities(report) {
  const missing = report.findings.filter((finding) => finding.status === 'missing');
  if (missing.length === 0) return '';
  const lines = [
    `dsh-tavily-pool: the host is missing ${String(missing.length)} capability(ies) this plugin uses.`,
    'DeepSeek Harness is in preview and its plugin interfaces change between releases.',
    'See docs/dsh-upgrade.md for the re-adaptation checklist.',
  ];
  for (const finding of missing) {
    const scope = REQUIRED_CAPABILITIES.includes(finding.id) ? 'required' : 'optional';
    lines.push(`  - [${scope}] ${finding.id}: ${finding.detail}`);
    if (finding.remedy !== undefined && finding.remedy !== null) lines.push(`      expected: ${finding.remedy}`);
  }
  return lines.join('\n');
}

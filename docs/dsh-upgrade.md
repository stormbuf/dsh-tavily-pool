# Re-adapting this plugin to a new DSH release

**English** | [简体中文](./dsh-upgrade.zh-CN.md)

DeepSeek Harness is in preview, so its plugin interfaces change between releases. This
plugin is built around one idea: **all host-specific knowledge lives in `lib/dsh/`**, so a
breaking change costs one directory, not the whole codebase.

| Tested against | `@deepseek-ai/dsh-*` `0.1.5-rc.2`, `@deepseek-ai/cordis` `4.0.2` |
|---|---|
| Depends on | the packages listed in `package.json` → `peerDependencies` |
| Declared range | deliberately **narrow** — see [Version range](#version-range) |

If an upgrade breaks something, read the failure first: the plugin **probes the host at
load time** and reports *which* capability is missing, by name, instead of failing on the
first search. That message is usually enough to identify the row to work through below.

## The layer that must never change

These modules import **no** `@deepseek-ai/*` package and run under `node:test` without a
harness. If an upgrade forces changes here, something has gone wrong with the design, not
with the upgrade:

| Module | Owns |
|---|---|
| `lib/constants.js` | ids, endpoints, timeouts, defaults |
| `lib/tavily.js` | Tavily REST request/response shapes |
| `lib/pool.js` | key-pool file, atomic writes, masking |

`lib/scheduler.js`, `lib/health.js`, and `lib/usage.js` join this layer as the scheduling,
failure-classification, and balance-refresh work lands. `test/compat-core.test.js`
enforces the rule mechanically — it fails if any listed file grows a host import, and it
asserts the list itself, so creating one of those modules without adding it here fails
the suite rather than passing silently.

## Checklist

Work through these in order; the first items cover nearly every breakage.

### 1. Seam shape — `WebSearchProvider` / `WebFetchProvider`

**Where:** `dsh-web/lib/types/types.d.ts`
**Then edit:** `lib/dsh/search-provider.js`

Check that both provider interfaces still have `id`, `available()`, and
`search()` / `fetch()`, and that the request/result types still have the fields this
plugin reads and writes:

- `WebSearchRequest.query`, `.maxResults`
- `WebSearchResult.sources[]`, `.content?`, `.truncated`
- `WebFetchBody` still discriminates on `kind` with `'text'` among the arms

### 2. Selection semantics — the reason `available()` is always `true`

**Where:** `dsh-web/lib/index.js`, function `resolveProvider`
**Then edit:** `lib/dsh/search-provider.js` (the `available()` comment, if the answer changed)

The plugin pins itself in `cordis.patch.yml`, so it lives under the rule *"a configured id
that is registered but unavailable is a hard throw"* — not a fallback. Confirm that rule
still holds:

- configured + registered + `available()` → that provider
- configured + not registered → `WEB_PROVIDER_CONFIGURED_MISSING`
- configured + registered + not available → `WEB_PROVIDER_CONFIGURED_UNAVAILABLE`

**If `available()` gained fallback semantics**, `available()` could start reflecting real
state. Until then it must keep returning `true`, and every decision must stay inside
`search()`.

### 3. Patch semantics — the reason both fields are written out

**Where:** `cordis-plugin-include/lib/index.js`, function `applyEntryPatches`
**Then edit:** `cordis.patch.yml`

The patch walker assigns each key it finds in the patch (`target[key] = value`), so
assigning `config` **replaces the whole object**: an omitted field is gone from the
composed row, not retained from the base layer. Confirm that is still true — verified by
running the host's own `applyEntryPatches` against the base `web` row and by
`dsh --profile <p> --dump-config`. If it became a deep merge, the comment in
`cordis.patch.yml` is now wrong; writing both fields stays correct either way.

> That distinction is what makes omitting a field dangerous: losing an explicit pin lets
> the seam fall back to auto-selection, where a second usable provider is
> `WEB_PROVIDER_AMBIGUOUS` rather than the provider the user configured.

### 4. Context service access — the trap that broke this plugin once

**Where:** `cordis/lib/index.js`, `ReflectService.handler.get`
**Then edit:** `lib/dsh/read-service.js`

The context proxy has two reads with different semantics:

- `ctx.someService` **throws** `cannot get property "x" without inject` unless the reading
  fiber declared it in `inject`;
- `ctx.get('someService')` returns `undefined` instead.

Everything that *probes* must use the reflective form, or a missing capability is reported
as a crash rather than as a missing capability. This is already implemented in
`lib/dsh/read-service.js`; verify the trap still exists and that nothing has started using
the direct form again.

### 5. The fallback targets this plugin constructs directly

**Where:** `dsh-web-search-deepseek` and `dsh-web-fetch-http` — their public exports.
**Then edit:** the adapter module the toggle/fallback ticket adds under `lib/dsh/`

Later tickets construct `DeepSeekSearchProvider` and `HttpFetchProvider` directly, because
the fallback path is what a user gets when they switch this plugin off. Check:

- both classes are still exported from their packages;
- their constructor signatures are unchanged;
- `publicHttpNetwork.resolve` is still exported (the fetch fallback injects it);
- the official limits this plugin mirrors are unchanged — **`maxResponseBytes: 5_000_000`,
  `maxBodyChars: 100_000`, `timeoutMs: 30_000`, `maxRedirects: 5`, and the
  `deepseek-harness/0.0.1 (+https://github.com/deepseek-ai)` user agent.** These are
  constants copied from the official provider because it registers no settings namespace;
  if they drift, "toggle off" silently stops matching the user's previous behaviour.

### 6. Settings registration

**Where:** `dsh-settings` — `register(ns, schema, options)`.
**Then edit:** `index.js` and whatever settings adapter module the settings ticket adds

Confirm the signature and that duplicate namespace registration still throws. The plugin
must **not** re-register `web-search-deepseek`: that namespace belongs to the official
plugin, which must stay enabled, and re-registering it throws.

### 7. Manifest fields

**Where:** `dsh-package-manifest/lib/types/types.d.ts`, interface `DshManifest`.
**Then edit:** `package.json`

Check whether `dsh.bundle.patch` / `dsh.client` gained new required siblings. The client
half matters for the panel ticket: `dsh.client` requires `exports["./client"]` to exist, and
the bundle id must equal the package name.

### 8. Client module protocol (panel ticket only)

**Where:** `dsh-web-frontend/dist/assets/index-*.js`, search for `staticModules`.
**Then edit:** `lib/client.js`

The seed module table lists exactly which specifiers a zero-build bundle may `require`. If
an entry the panel uses was removed, the card fails to load. The slot contract is
`dsh-client-ui-settings-plugins/lib/types/client/slot-contract.d.ts`; the card must register
with the **`key`** field (the settings namespace), never `id` or `order`.

## Version range

`package.json` → `peerDependencies` uses an intentionally narrow range:
`>=0.1.5-rc.2 <0.1.6` for the host packages, `>=4.0.2 <5` for Cordis.

The preview period argues for **failing loudly on an untested version rather than
declaring compatibility that was never checked.** When you verify a new release, widen the
range to include it and update the README's tested-version line — that line and this table
are the same promise, so change both together.

Two things to remember when widening:

- A prerelease is only matched by a range that names it. `^0.1.5` does **not** match
  `0.1.5-rc.2`; write `>=0.1.5-rc.2 <0.1.6` or name the prerelease explicitly.
- `pnpm` (which `dsh plugin add` forwards to) does not auto-install peers. Peer ranges here
  are documentation and a warning source, not an install mechanism.

## After upgrading

1. `npm test` — the host-free core must stay green with no changes.
2. `node test/live/seam-check.mjs` with a real key — proves the seam resolves the pinned
   provider and a live search maps back correctly.
3. Restart the harness and run one real `web_search` through the UI, then work through
   `.scratch/dsh-tavily/issues/16-real-machine-e2e-verification.md`. Behaviour that only
   exists inside a running harness cannot be proven by unit tests, and each upgrade
   invalidates the previous run.

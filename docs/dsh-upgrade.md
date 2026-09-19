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
| `lib/pool.js` | key-pool file, atomic writes, masking, key edits |
| `lib/scheduler.js` | balance ordering, hard exclusion, bounded wait |
| `lib/health.js` | failure classification, cooldown, quota/invalid state |
| `lib/attempts.js` | failover across keys within one request |
| `lib/settings.js` | setting shapes and defaults (the schema itself is host-agnostic) |
| `lib/usage.js` | balance refresh, the `/usage` quota, the month-start probe window |
| `lib/panel.js` | panel state projection and command execution (host-free: it knows neither `Request` nor `Response`) |

`test/compat-core.test.js` enforces the rule mechanically — it fails if any listed file
grows a host import, and it asserts that **every** `lib/*.js` is classified, so a new core
module that nobody added here fails the suite rather than silently escaping the rule.
(`lib/client.js` is the one deliberate exception: it is a browser script rather than a
module, and the test names it as such.)

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
- `ctx.get('someService')` returns `undefined` instead — but **only for services visible in
  that fiber's isolation scope**. It is not the boundary-crossing read its own type
  documentation advertises.

Everything that *probes* must use the reflective form, or a missing capability is reported
as a crash rather than as a missing capability. This is implemented in
`lib/dsh/read-service.js`; verify the trap still exists and that nothing has started using
the direct form again.

**Measured on 2026-09-19 with a probe plugin inside an isolated `dsh web` instance:**

| Declared on the plugin | `settings` | `connection` | `credentials` | `clientModules` | `launchEnvironment` | `dshHomePath` |
|---|---|---|---|---|---|---|
| nothing | undefined | undefined | undefined | object | object | function |
| `inject: ['web']` | undefined | undefined | undefined | object | object | function |
| `inject: [all three]` | object | object | object | object | object | function |
| `ctx.inject([all three], cb)` | object | object | object | object | object | function |

Three services this plugin needs — `settings`, `connection`, `credentials` — are **not** in
a plain fiber's scope, so `ctx.get` silently returned `undefined` for them: the settings
namespace was never registered and no panel route was ever mounted. They must be obtained
through `ctx.inject([name], callback)`, which hands the callback a child fiber where the
service is visible (`lib/dsh/host-services.js`).

Do **not** add them to the plugin's own `inject` list instead: that list is all-or-nothing
(Cordis loads the plugin only while every declared service is available), so a host missing
any one of them would lose search entirely — the opposite of `PIN-5`.

Two timing facts that come with it, both measured (ms since process start):

```
apply:start @+817   apply:end @+817   microtask @+1417
setTimeout(0) @+3373                   inject:settings @+3385
```

The inject callbacks run **after** the whole profile finishes composing, so neither a
synchronous probe nor a fixed delay can see those services. Capability probing therefore
hangs off real events (each service becoming available, and the first search), while the
panel probes fresh on every read.

**Check on upgrade:** run `test/dsh-host-services.test.js`. Its host double is deliberately
*stricter* than the real one (its `get` returns only injected services), so a change in the
isolation semantics fails there instead of surfacing as a silently missing panel.

### 5. The fallback targets this plugin constructs directly

**Where:** `dsh-web-search-deepseek` and `dsh-web-fetch-http` — their public exports.
**Then edit:** both fallbacks live in `lib/dsh/fallback.js`

The search fallback has landed in `lib/dsh/fallback.js`: it constructs `DeepSeekSearchProvider`
directly, because the fallback path is what a user gets when they switch this plugin off. Check:

- `DeepSeekSearchProvider` and `WEB_SEARCH_DEEPSEEK_SETTINGS_NAMESPACE` are still exported from
  that package;
- its constructor still takes a thunk returning the options object;
- `@deepseek-ai/dsh-credentials` still exports `credentialRef` / `isCredentialRefName` (the former
  throws on a name outside the grammar, so the latter must be checked first);
- `@deepseek-ai/dsh-launch-environment` still exports `launchEnvironmentOf`, and its snapshot's
  `get(name)` still returns `{ value, source }`;
- the official defaults this plugin mirrors are unchanged — `apiKeyEnv: DEEPSEEK_API_KEY`,
  `baseURL: https://api.deepseek.com/anthropic/v1`, `model: deepseek-v4-flash`,
  `apiVersion: 2023-06-01`, `maxTokens: 4096`, `maxUses: 5`, and the `DEEPSEEK_SEARCH_BASE_URL`
  endpoint override. The official package does not export its `resolveOptions`, so these are
  copied; if they drift, only the "user configured nothing" tier diverges from the official
  provider, and that tier already fails loudly as a missing credential.

The fetch fallback (ticket `10`) lives in `officialFetchProvider()` in the same file, and is much
simpler — the official fetcher needs no credential, so there is no `CFG-5` pair here. Check three
things:

- `HttpFetchProvider` and `DEFAULT_USER_AGENT` are still exported from the package root.
  **`publicHttpNetwork` is not**: it is exported from the source module only, and the package's
  `exports` map covers just `./src/*` and `./package.json`, so no subpath reaches the root
  `lib/index.js`. The constructor therefore **omits the second argument**, letting the official
  package supply its own default resolver (the constructor's default value *is*
  `publicHttpNetwork.resolve`, so behaviour is identical). Ticket `10` originally claimed it was
  reachable as an export; that is corrected in that ticket's Comments.
- the four limits this plugin mirrors are unchanged: `maxResponseBytes: 5_000_000`,
  `maxBodyChars: 100_000`, `timeoutMs: 30_000`, `maxRedirects: 5` (the fifth, `userAgent`, comes
  from the exported constant). Those four exist only as schema `.default(...)` values inside the
  package, so copying is the only option.
- `test/dsh-fetch-provider.test.js` reads the official package's `Config` schema and compares field
  by field, so an upstream default change turns it red without anyone having to re-read this
  section by hand.

### 6. Settings registration

**Where:** `dsh-settings` — `register(ns, schema, options)` on the service, and `get(ns)` on
the service for reading a registered namespace back.
**Then edit:** `lib/dsh/settings.js`

Confirm both halves of the shape: `register` returns an owner scope, and the **service**
carries `get(ns)`. Reading through the scope returned by `register` looks equivalent but is
not — a service without `get` is one more host shape to notice, and the plugin reads through
the service so that a re-registration failure does not also break reading.

Confirm too that duplicate namespace registration still throws. The plugin must **not**
re-register `web-search-deepseek`: that namespace belongs to the official plugin, which
must stay enabled, and re-registering it throws.

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

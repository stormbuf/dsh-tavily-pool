# Re-adapting this plugin to a new DSH release

**English** | [简体中文](./dsh-upgrade.zh-CN.md)

DeepSeek Harness is in preview, so its plugin interfaces change between releases. This
plugin is built around one idea: **all host-specific knowledge lives in `lib/dsh/`**, so a
breaking change costs one directory, not the whole codebase.

| Tested against | `@deepseek-ai/dsh-*` `0.1.7-rc.2`, `@deepseek-ai/cordis` `4.0.4` |
|---|---|
| Depends on | the packages listed in `package.json` → `peerDependencies` |
| Declared range | **lower bound only** for the host packages — see [Version range](#version-range) |

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
a plain fiber's scope, so `ctx.get` silently returned `undefined` for them: under the old
model that meant the settings namespace was never registered and no panel route was ever
mounted; under 0.1.7 the same blindness means every panel write reports "the host has no
settings service". They must be obtained through `ctx.inject([name], callback)`, which hands
the callback a child fiber where the service is visible (`lib/dsh/host-services.js`).

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
- `resolveOptions`'s **side effect** is still there: the options object carries `recordRequest`, and
  the provider calls it (optionally, before the request) to append a
  `web/deepseek-search-llm-request` event to the session. Ticket `22` F1 added it to this plugin's
  copy; `test/dsh-fallback.test.js` reconciles this plugin's option keys against the official
  source mechanically, so a new field upstream turns that test red. Note the read is
  `readService(ctx, 'agents')` — `agents` is not one of the three services that need `inject`
  (coupling point 19), but it is only guaranteed active once a real request is in flight, which
  is exactly when `recordRequest` runs;
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

### 6. Host tool budgets — the deadline the host actually arms

**Where:** `dsh-tools` (`get(name, scope)`), `dsh-tool-call-timeout-policy`
(`ctx.tools.get(exec.name, exec.agent)?.timeoutMs`), and `dsh-tool-web` (`timeoutMs` on the
`web_search` / `web_fetch` definitions, from `searchTimeoutMs` / `fetchTimeoutMs`).
**Then edit:** `lib/dsh/host-budget.js`

Both paths size their total budget from the value the host actually bound, not from a constant
(ticket `22` F2). Reading it wrong is not a "slightly late timeout": when the host's deadline
fires first, the model sees `tool call timed out after <n>ms` and the upstream error this plugin
was carrying is lost.

Check that `ctx.tools.get(name)` still resolves the tool definition and that it still carries a
numeric `timeoutMs`; that the timeout policy still reads it with `?.timeoutMs` and skips arming
when absent; and that the tool names are still `web_search` / `web_fetch`. `test/budgets.test.js`
reconciles this plugin's constants against the host's own composition file and package schema
mechanically, and asserts both folded budgets finish strictly before the host deadline — it fails
loudly (never skips) when the host install cannot be located, and honours `DSH_HOST_ROOT` when it
can't be found automatically.

`tools` is read through the plugin's context view with **no agent scope** — the provider has no
agent at request time, and guessing one would read another agent's budget. The reading is
reported as `host` / `unbound` / `unavailable`, so "we fell back to the constant" is observable
rather than silent.

### 7. Settings model

**Where:** `dsh-settings` (the `settings` service), `dsh-app-boot` (`evaluatePluginCompatibility`),
and the entry-config resolution in `@deepseek-ai/cordis`.
**Then edit:** `index.js` (the `Config` export), `lib/dsh/settings.js`, `lib/settings.js`

DSH 0.1.7 replaced the whole model. Settings are **the plugin's own loader row config**, not a
namespace the plugin registers:

- the entry module exports `Config` (a schemastery schema) and `apply(ctx, config)` receives the
  resolved config. There is no `ctx.settings.register(ns, schema)` and no `get(ns)` any more;
- **only `.volatile()` fields get a form.** `volatileForm()` in `dsh-settings` recurses the root
  schema's `dict` and keeps volatile children; an entry where none is volatile does not appear in
  `describe()` at all — no settings page, no error;
- a volatile field resolves to a **live accessor** (`{ get(), [volatile.write]() }`), not a plain
  value. Read it with `config.x.get()` (the official packages do exactly this). The accessor is
  what makes `applies: 'live'` work: a panel write lands on the same accessor, so the next read
  sees it **without reloading the plugin**. `lib/dsh/settings.js` flattens these into a plain
  object for the host-free `lib/settings.js`;
- entry identity is the **profile entry id** (`entry.options.id`), i.e. the `name` export and the
  `id` in `cordis.patch.yml`. `ctx.settings.update(entryId, patch, expectedRevision?)` writes to
  the profile patch; `ctx.settings.update` is the only member the panel needs;
- reading **another** entry's config (the fallback path reads the official
  `web-search-deepseek`) goes through `ctx.settings.describe()`, which returns each configurable
  entry's resolved value under `ns`. It is unredacted unless `redactSecrets` is requested, and it
  walks every entry — call it on the fallback path, not per search.

`test/settings-stub.mjs` reproduces both the schema validation (same `settingsSchema()`) and the
volatile-accessor liveness, so the unit tests exercise the real shape rather than a plain object.

### 8. Manifest fields

**Where:** `dsh-package-manifest/lib/types/types.d.ts`, interface `DshManifest`.
**Then edit:** `package.json`

Check whether `dsh.bundle.patch` / `dsh.client` gained new required siblings. The client
half matters for the panel ticket: `dsh.client` requires `exports["./client"]` to exist, and
the bundle id must equal the package name.

### 9. Client module protocol (panel ticket only)

**Where:** `dsh-web-frontend/dist/assets/index-*.js`, search for `PLATFORM_MODULES`.
**Then edit:** `lib/client.js`

The seed module table lists exactly which specifiers a zero-build bundle may `require`. If
an entry the panel uses was removed, the card fails to load. This card uses three: `react`,
`react-dom` (the batch-add dialog mounts through its `createPortal`) and
`@deepseek-ai/dsh-client-ui-primitives` (`Switch` / `Tag` / `IconChevronDownOutline14`).

The **mount point** is the other half. 0.1.7 moved plugin configuration to the sidebar Plugins
page: the card registers into `plugins.row.config`, keyed by **`<package name>#<row id>`**
(`dsh-tavily-pool#tavily-pool`) — the old `settings.plugin.item` keyed by settings namespace is
gone from the host. The owning contract is
`dsh-client-ui-plugin-manager/lib/types/client/slot-contract.d.ts`. Registering into a slot the
host does not declare **does not error**; the card simply never renders, which is why the slot
name and key are asserted in `test/client-card.test.js`.

The entry receives `PluginConfigViewProps` (`view: 'summary' | 'page'`, plus an optional
`form` carrying the host-owned config snapshot and `mutate`). This card renders itself for
`page` and a one-liner for `summary`, and keeps writing settings through its own panel route
(`ctx.settings.update`) rather than through `form.mutate`.

## Version range

`package.json` declares the host packages with a **lower bound only**
(`>=0.1.5-rc.2`), while Cordis keeps a major upper bound (`>=4.0.2 <5`).

The upper bound was dropped in `0.3.1`. DSH 0.1.7 introduced a hard gate —
`evaluatePluginCompatibility()` in `@deepseek-ai/dsh-app-boot` — that checks every
`@deepseek-ai/dsh` / `@deepseek-ai/dsh-*` peer against the running version and, on a
mismatch, **skips the whole bundle** before any of its code loads. Under the old `<0.1.6`
bound every DSH release past `0.1.6` silently dropped the plugin: no providers registered,
no provider pin, no settings card. A stale upper bound is therefore worse than no upper
bound — it turns "may need re-adaptation" into "quietly gone".

The discipline it replaces still holds one layer lower: the plugin keeps probing host
capabilities at load time and names the missing one, so an incompatible release fails
loudly at the first thing that actually breaks instead of refusing to mount at all.
`engines.dsh` carries the same lower bound declaratively; no DSH reader enforces it today.

Two things to remember:

- A prerelease is only matched by a range that names it. `^0.1.5` does **not** match
  `0.1.5-rc.2`; write `>=0.1.5-rc.2`.
- `pnpm` (which `dsh plugin add` forwards to) does not auto-install peers. Peer ranges here
  are documentation and a warning source, not an install mechanism.

Verifying a new release no longer requires touching the range at all: update the README's
tested-version line and the table above — those two are the same promise and must change
together. Raise the lower bound only when you deliberately stop supporting older releases.

## After upgrading

1. `npm test` — the host-free core must stay green with no changes.
2. `node test/live/seam-check.mjs` with a real key — proves the seam resolves the pinned
   provider and a live search maps back correctly.
3. `node test/live/panel-and-toggles.mjs` with a real key — proves the toggles take effect
   live, the fallback path works, and a half-broken plugin still serves searches.
4. `node test/live/panel-browser-check.mjs` — renders the settings card in a real headless
   Chrome. Unit tests execute the component against a React stand-in and assert the element
   tree, but they cannot see rendering; a CSS collision once passed every unit test while the
   real card was unusable.
5. Restart the harness and run one real `web_search` through the UI. Behaviour that only
   exists inside a running harness cannot be proven by unit tests, and each upgrade
   invalidates the previous run.

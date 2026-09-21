# dsh-tavily-pool

**English** | [简体中文](./README.zh-CN.md)

Tavily-backed web search **and** page fetching for DeepSeek Harness: multi-key pool with balance-aware rotation, automatic failover, cooldown, official `/usage` balance reporting, and independent toggles for search and fetch — configurable from the DSH settings panel.

> Not to be confused with [`SZMY-haruhi/dsh-tavily`](https://github.com/SZMY-haruhi/dsh-tavily) (single key / keyless, no scheduling) or [`@yuuz12/dsh-tavily`](https://www.npmjs.com/package/@yuuz12/dsh-tavily) (multi-key, but no fetch takeover and it rewrites internal fields at runtime). This plugin manages a **pool** of keys, schedules by remaining balance, and takes over **both** `web_search` and `web_fetch`.

## Features

- **Multi-key pool** — add one key or paste a whole batch (one per line), label, enable/disable, reorder, remove one or several at once; the UI only ever shows masked keys
- **Scheduling policy** — switch between balance-first ordering and plain manual order, where the list order becomes the scheduling order
- **Balance-aware rotation** — highest remaining balance first; three-state balance (the limit comes from `key.limit`, falling back to the account's `account.plan_limit` — only when **both** are explicitly `null` is a key unlimited and ranked first; unknown goes last)
- **Automatic failover** — a failing key hands the request to the next one
- **Cooldown** — honors upstream `Retry-After`; cooled keys are hard-excluded until it expires, and when every key is cooling the request waits for the earliest one within a bounded budget
- **Status-aware errors** — separates temporary failures, permanent key death (body-inspected, never status-code-only), and quota exhaustion (`432` / `433` treated alike: the key stays out of rotation until `/usage` confirms a positive balance)
- **Official balance, refreshed on use** — the card's credit figure is the official `/usage` reading (limit − used). A reading is pulled again when the key being used has one over an hour old, when a key is added, and for any key still missing a reading the next time the plugin is used at all. The plugin keeps **no** credit accounting of its own: Tavily's billing rules can change at any time, so a locally computed figure could silently become wrong. Between readings the ordering is nudged forward by a deliberately rough per-call estimate that is never shown as a number of its own; it does move the displayed `used` figure, so the card also says how old the last official reading is. Nothing runs in the background: no search or fetch means no `/usage` traffic at all
- **Balance refresh** — pulls official `/usage` with per-key sliding-window quota reservation, so it never trips the 10-per-10-minutes limit
- **Configurable search parameters** — search depth, result cap, topic, and generated-answer toggle, all taking effect immediately
- **Fetch takeover (off by default)** — maps `web_fetch` to Tavily `/extract`, returning plain text (never HTML, which DSH would convert a second time); extraction depth and output format are configurable. Turn it on in settings when you want Tavily to handle fetching too
- **Call history and chart** — every call is recorded (key, endpoint, outcome, duration, `request_id`) and drawn as a 14-day call-count chart; the file is bounded by both an entry cap and a 30-day window
- **Independent toggles** — search and fetch can be switched back to the official providers separately
- **Zero runtime dependencies** — plain ESM, no build step

> **Shipped:** the whole spec — search takeover and its toggle, the key pool (single key,
> pasted batch, bulk removal), failover with cooldown, search parameters, the scheduling
> policy, balance refresh, fetch takeover with its own toggle (off by default), call history
> with its chart, the per-key call stats and balance bar, the connectivity test, and the
> settings card with its HTTP API.

## Install

From the npm registry:

```sh
dsh plugin add dsh-tavily-pool
```

Or straight from GitHub, which needs no registry account. Pin a released tag when you want a
reproducible version — see the [tags](https://github.com/stormbuf/dsh-tavily-pool/tags) for
the ones that exist:

```sh
dsh plugin add github:stormbuf/dsh-tavily-pool
dsh plugin add github:stormbuf/dsh-tavily-pool#vX.Y.Z
```

Both routes install the same files: the `files` whitelist in `package.json` applies to git installs too, so no `test/` or `scripts/` directory comes along.

Then restart DSH, open **Settings → Plugins → dsh-tavily-pool** and paste your Tavily API key(s). Keys are entered through the panel only — the plugin does not read environment variables or the DSH credentials service.

See [`docs/usage.md`](./docs/usage.md) for configuration, scheduling behaviour, billing, and manual rollback steps.

## Compatibility

DeepSeek Harness is in preview, so its architecture and plugin interfaces may change between releases. This plugin isolates nearly all host-specific knowledge in one thin adapter layer (`lib/dsh/`), plus the zero-build client half (`lib/client.js`) and the provider pin in `cordis.patch.yml`, and probes host capabilities at load time, so that adapting to a breaking change stays cheap.

**Tested against DSH `0.1.5-rc.2`.** On a newer release, the plugin may need re-adaptation; it will report a clear error naming the missing capability rather than failing silently. The step-by-step checklist lives in [`docs/dsh-upgrade.md`](./docs/dsh-upgrade.md).

Installing through `dsh plugin add` makes this package a **bundle layer** of the target profile (it lands in that profile's `dsh.profile.bundles`, after the DSH bundles), which is what lets its `cordis.patch.yml` pin the providers. Your own profile patch is applied after every bundle layer, so it can always override or disable what this plugin does — see [Manual rollback](./docs/usage.md#manual-rollback).

## License

MIT

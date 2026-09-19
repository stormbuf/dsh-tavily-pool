# dsh-tavily-pool

**English** | [简体中文](./README.zh-CN.md)

Tavily-backed web search **and** page fetching for DeepSeek Harness: multi-key pool with balance-aware rotation, automatic failover, cooldown, usage stats, and independent toggles for search and fetch — configurable from the DSH settings panel.

> Not to be confused with [`szmy-haruhi/dsh-tavily`](https://github.com/SZMY-haruhi/dsh-tavily) (single key / keyless, no scheduling) or [`@yuuz12/dsh-tavily`](https://www.npmjs.com/package/@yuuz12/dsh-tavily) (multi-key, but no fetch takeover and it rewrites internal fields at runtime). This plugin manages a **pool** of keys, schedules by remaining balance, and takes over **both** `web_search` and `web_fetch`.

## Features

- **Multi-key pool** — add, label, enable/disable, reorder, remove; the UI only ever shows masked keys
- **Balance-aware rotation** — highest remaining balance first; three-state balance (`limit === null` → unlimited first, unknown → last)
- **Automatic failover** — a failing key hands the request to the next one
- **Cooldown** — honors upstream `Retry-After`; cooled keys are excluded until it expires, and when every key is cooling the request briefly waits for the earliest one
- **Manual order** — optionally schedule by your own key order instead of by balance
- **Status-aware errors** — separates temporary failures, permanent key death (body-inspected, never status-code-only), key quota exhaustion (432), and account-level PayGo exhaustion (433, fails fast instead of pointlessly rotating keys)
- **Usage accounting** — reads real `usage.credits` from responses; unknown is recorded as unknown, never as zero
- **Balance refresh** — pulls official `/usage` with per-key sliding-window quota reservation, so it never trips the 10-per-10-minutes limit
- **Fetch takeover** — maps `web_fetch` to Tavily `/extract`; billing follows successful-URL tiers
- **Independent toggles** — search and fetch can be switched back to the official providers separately
- **Zero runtime dependencies** — plain ESM, no build step

## Install

```sh
dsh plugin add dsh-tavily-pool
```

Then open **Settings → Plugins → dsh-tavily-pool** and paste your Tavily API key(s). Keys are entered through the panel only — the plugin does not read environment variables or the DSH credentials service.

See [`docs/usage.md`](./docs/usage.md) for configuration, scheduling behaviour, billing, and manual rollback steps.
## Compatibility

DeepSeek Harness is in preview, so its architecture and plugin interfaces may change between releases. This plugin isolates all host-specific knowledge in one thin adapter layer (`lib/dsh/`) and probes host capabilities at load time, so that adapting to a breaking change stays cheap.

**Tested against DSH `0.1.5-rc.2`.** On a newer release, the plugin may need re-adaptation; it will report a clear error naming the missing capability rather than failing silently. The step-by-step checklist lives in [`docs/dsh-upgrade.md`](./docs/dsh-upgrade.md).

## License

MIT

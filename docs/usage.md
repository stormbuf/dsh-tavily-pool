# dsh-tavily-pool usage

**English** | [简体中文](./usage.zh-CN.md)

Use [Tavily](https://tavily.com) in place of DeepSeek Harness's built-in web search and page fetching: multiple API keys, balance-aware scheduling, automatic failover, and usage stats.

## Install

```sh
dsh plugin add dsh-tavily-pool
```

After installing, restart DSH and open **Settings → Plugins** to find this plugin's configuration card.

## Adding keys

This plugin does **not** read environment variables, and does not read DSH's credentials service — keys can only be pasted into the panel.

1. Open **Settings → Plugins → dsh-tavily-pool**
2. Paste a Tavily API key (form `tvly-...`) into the key field
3. Save

You can add as many as you like. The list only ever shows a masked form (`tvly-...xxxx`); the plaintext is stored locally only:

```
~/.dsh/dsh-tavily-pool/keys.json
```

That file is readable only by your user. The plugin exposes no endpoint that returns a key's plaintext, and provides no import/export.

## Toggles

There are two **independent** toggles:

| Toggle | Behaviour when off |
|---|---|
| **Search takeover** | Search requests go to DSH's official search provider |
| **Fetch takeover** | Fetch requests go to DSH's built-in local HTTP fetcher |

They do not affect each other — you can use Tavily for search while keeping the built-in fetcher, for example.

Toggle changes take effect **immediately**, with no restart.

## Scheduling

The key pool schedules by **balance first**:

- Keys with more remaining credits go first
- Keys whose balance is "unlimited" go first of all
- Keys whose balance is **unknown** go last (unknown is not zero)
- Within the same balance tier, keys rotate

When a key fails temporarily (rate limiting `429`, server error `5xx`) it is **cooled down**, and during the cooldown it **does not participate** in key selection (it will not be used even if every other key is unavailable). It recovers automatically when the cooldown ends.

If **every** key is cooling down, the plugin **briefly waits** for the earliest one to expire rather than failing immediately; the wait is bounded, and once exceeded the upstream error is returned.

**Quota exhaustion** (`432` / `433`) is different from a cooldown: it is not a matter of "wait a moment", but of the key having no credits left in the current billing cycle. Such a key stays **unselected** until it is confirmed to have recovered.

Tavily resets usage on the **1st of each month**. Because the official documentation does not state which time zone that reset happens in, the plugin **probes automatically** after a month boundary has passed: starting from the UTC month start, it checks every 6 hours for up to 48 hours — a window wide enough to cover the month start in any time zone worldwide. A probe only calls the balance-query endpoint and **consumes no credits**.

You can also click **Refresh balance** in the panel to check immediately. If it has not recovered within 48 hours, that usually means you need to raise the limit on the [Tavily dashboard](https://app.tavily.com/account/plan) rather than wait.

If no key in the pool is usable, requests **fall back** according to the toggles above.

Key failures fall into three kinds:

- **Permanently invalid** (for example, the response body explicitly says the key was revoked or is invalid) — needs your action
- **Temporary failure** (rate limiting, server errors) — recovers automatically after a cooldown
- **Quota exhausted** (`432` / `433`) — recovers only once the balance is confirmed to have returned; see the [Tavily dashboard](https://app.tavily.com/account/plan) to raise the limit

## Balance refresh

The **Refresh balance** button in the panel calls Tavily's `/usage` endpoint to pull the official balance.

Tavily rate-limits that endpoint at **10 requests / 10 minutes**, so the plugin reserves quota per key and will not trip the limit. On failure it **keeps the old value and marks it stale** rather than overwriting with 0.

The plugin **does not infer the billing cycle** — balances always come from the current-cycle values returned by the official `/usage`.

## Billing

- **Search**: `basic` / `fast` / `ultra-fast` cost 1 credit, `advanced` costs 2
- **Fetch**: every **5 successful** URL extractions cost 1 credit (`basic`) or 2 (`advanced`); failed URLs are **not charged**

A single fetch therefore often costs 0 credits.

## Manual rollback

If the plugin fails to load and search becomes unavailable, DSH reports `WEB_PROVIDER_CONFIGURED_MISSING`. To recover, point the providers in the profile patch back at the official values.

Edit:

```
~/.dsh/profiles/<profile>/cordis.patch.yml
```

Find the section overriding the `web` row and change `searchProvider` and `fetchProvider` back to the official values:

```yaml
- id: web
  config:
    searchProvider: deepseek-official
    fetchProvider: http
```

> ⚠️ **Both fields must be written out.** A patch's `config` is **replaced wholesale**, not merged; writing only one leaves the other "unconfigured", which falls back to auto-selection — that does not error, but it is no longer the behaviour you asked for.

Saving takes effect immediately, with no restart (the profile's `patchReload` is `live`).

Afterwards you can disable or remove this plugin.

## How this differs from other DSH Tavily plugins

There are two other plugins on the same topic; this one is positioned differently:

| | `szmy-haruhi/dsh-tavily` | `@yuuz12/dsh-tavily` | **dsh-tavily-pool** |
|---|---|---|---|
| Key model | Single key / keyless | Multi-key pool | **Multi-key pool** |
| Balance-aware scheduling | No | Yes | **Yes** |
| Failover and cooldown | No | Yes | **Yes** |
| Usage stats | No | Yes | **Yes** |
| Fetch takeover | No | No | **Yes** |
| Takeover method | Static config | Rewrites internal fields at runtime | **Static config** |

This plugin does **not** support keyless mode — a keyless call cannot be attributed to your account, so it cannot be accounted for and no balance can be shown.

## License

MIT

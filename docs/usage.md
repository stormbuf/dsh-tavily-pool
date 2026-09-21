# dsh-tavily-pool usage

**English** | [简体中文](./usage.zh-CN.md)

Use [Tavily](https://tavily.com) in place of DeepSeek Harness's built-in web search and page fetching: multiple API keys, balance-aware scheduling, automatic failover, and per-key call stats.

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

After installing, restart DSH and open **Settings → Plugins** to find this plugin's configuration card.

## Adding keys

This plugin does **not** read environment variables, and does not read DSH's credentials service — keys can only be pasted into the panel.

1. Open **Settings → Plugins → dsh-tavily-pool**
2. Paste a Tavily API key (form `tvly-...`) into the key field
3. Save

To add several at once, click **Add several**: a dialog opens with a text box. Paste one key per line and confirm — every line becomes a key. Leading and trailing whitespace is trimmed, blank lines are ignored, and lines that are already in the pool (or repeated within the same paste) are skipped; the card then reports how many were added and how many were skipped. Downstream nothing differs from a single paste: the same local file, the same masked list.

Submitting the same plaintext twice does not take two slots: the single-key form de-duplicates too, and the card says "that key is already in the pool" when it does.

To remove several at once, click **Remove several**: tick them in the dialog and confirm — the selected keys go away in **one write**. Single-key removal stays per-key; this is the bulk exit, because ticking rows one by one is too slow once a bad paste has blown the pool up.

Writes are bounded: a single key is at most 512 characters (a real one is about 50), one paste adds at most 200, and the pool holds at most 200. Over the limit the server **rejects the whole batch** and states the limit, the count it received, and which line — it never truncates silently, because silent truncation reads as success.

The pool holds up to 200 keys. The list only ever shows a masked form (`tvly-...xxxx`); the plaintext is stored locally only:

```
~/.dsh/dsh-tavily-pool/keys.json
```

That file is readable only by your user. The plugin exposes no endpoint that returns a key's plaintext, and provides no import/export.

### Editing that file while DSH is running

**The file is the source of truth for the key set; the pool inside the DSH process is only a cache of it.** Changes made to the file while DSH runs do count:

| External change | Result |
|---|---|
| Add a key (hand-written record, or added by another instance/process) | It is picked up, and is not overwritten by the older in-memory pool |
| Remove a key | It stops being used for search or fetch, and is not written back by the next write |
| Change a record field such as `label` / `disabled` | The file wins unless this process is the one changing it right now; a record this process just changed stays as this process left it |
| Add a top-level key this version does not know (e.g. written by a newer version) | Preserved verbatim, and not wiped by the next edit |
| Change `order` (the sequence) | The sequence follows the in-process pool; hand-edits to it take effect after a restart. The record set itself still follows the file |

The rule in the other direction is just as explicit: **per-key call stats and balance caches follow this process's runtime records** and overwrite the same entries in the file on write — they are never read back from it.

Nothing is guaranteed to be instant: an external change is absorbed at the latest on the **next write** (accounting after a search or fetch, a balance refresh, a panel edit) or the **next time the panel is opened**.

Two edges worth knowing:

- **Deleting `keys.json` outright is not the same as emptying the pool.** When the file cannot be read (missing, or its contents broken) the plugin does nothing and your keys are not lost. To empty the pool, remove keys one by one in the panel.
- **Do not break the file.** When the contents are not valid JSON the plugin continues with an empty pool and reports it (the message names the file), and **while the file is broken any write from the panel replaces it with a pool holding only the new keys** — the price of that deliberate "continue with an empty pool" tradeoff.

## Toggles

There are two **independent** toggles:

| Toggle | Default | Behaviour when off |
|---|---|---|
| **Search takeover** | **on** | Search requests go to DSH's official search provider |
| **Fetch takeover** | **off** | Fetch requests go to DSH's built-in local HTTP fetcher |

They do not affect each other — you can use Tavily for search while keeping the built-in fetcher, which is exactly the default state.

**Fetch takeover is off by default**: installing this plugin is usually about search, while fetching is a separate upstream path that spends its own quota. Defaulting it to on would make a quota decision on your behalf that you never asked for. Turn it on in settings when you want Tavily to handle fetching too.

Toggle changes take effect **immediately**, with no restart.

> **Upgrade note**: a default only applies to a setting you have **never** configured. If you explicitly turned fetch takeover on before, it stays on after upgrading — the default never overrides your choice.

## Search parameters

| Parameter | Values | Default | Meaning |
|---|---|---|---|
| **Search depth** `searchDepth` | `basic` / `advanced` / `fast` / `ultra-fast` | `basic` | The relevance-versus-latency tradeoff. `advanced` costs **2 credits** per search; the other three cost 1 |
| **Result cap** `maxResults` | 1–20 | 10 | How many sources one search may return |
| **Topic** `topic` | `general` / `news` / `finance` | `general` | `news` suits current events, `finance` suits financial queries |
| **Generated answer** `includeAnswer` | on / off | off | Ask Tavily for an extra generated answer, returned as the search result's body text |

Parameter changes likewise take effect **immediately**; the next search carries the new values.

`maxResults` is a **cap**, not a guarantee: the model may ask for fewer results when it calls search, and then its number wins. The final result is truncated once more by DSH's seam. The lower bound is 1 — the official API reference says 0, but `0` is in practice rejected upstream with `400 Invalid max results.`, and that class of error neither retries nor switches keys, so the panel does not accept it.

The host's own orchestration imposes one more cap: DSH's `tool-web` asks this plugin for `searchMaxResults` results (default **8**) on every search, and the plugin sends whichever is **smaller** — that or the panel value. So on DSH, setting `maxResults` anywhere in 9–20 behaves exactly like 8; only lowering it (1–8) changes how many sources actually come back.

Depth and count are independent dimensions: **depth decides how thoroughly the search runs, the cap decides how many sources come back.** Billing looks only at depth (`advanced` costs 2 credits, the other three cost 1); the cap does not affect credits.

## Fetch parameters

| Parameter | Values | Default | Meaning |
|---|---|---|---|
| **Extraction depth** `fetchDepth` | `basic` / `advanced` | `basic` | `advanced` retrieves more content, at **twice the credits** |
| **Output format** `fetchFormat` | `markdown` / `text` | `markdown` | The text Tavily returns; `text` costs extra latency upstream |

There are no per-call fetch controls: DSH's fetch request type carries **only a URL**, so the model cannot ask for a different depth or format on an individual call. These two settings are the only way to change it.

A fetched page comes back as **plain text, never as HTML**. Tavily already returns markdown, so the plugin tells DSH it is text and DSH passes it straight through; marking it as HTML would make DSH convert a markdown document a second time and mangle the content.

Both settings only apply while **fetch takeover is on**.

## Scheduling

The key pool schedules by **balance first** by default:

- A key's balance is **limit − used**. The limit comes from the key itself (`key.limit`); when that is `null` the plugin falls back to the plan limit of the account this key belongs to (`account.plan_limit`) — free accounts return `null` for `key.limit`, so reading only that field would show a 1000-credits-per-month account as "unlimited"
- Keys with more remaining credits go first
- Only keys with no limit at either level count as "unlimited", and they go first of all
- Keys whose balance is **unknown** go last (unknown is not zero)
- Within the same balance tier, keys rotate
- **Every key is computed on its own**: the plugin does not try to work out which keys share an account (the official API does not expose ownership), so when one account holds several keys each of them sees the same account-level limit

### Scheduling policy

`schedulingPolicy` switches between two ways of **ordering** the candidates:

| Value | Behaviour |
|---|---|
| `balance` (default) | Remaining balance decides; keys in the same tier rotate |
| `manual` | Keys are tried strictly in the order shown in the key pool, **ignoring balance** |

"Manual order" means the list order becomes the scheduling order — so the up/down buttons stop being cosmetic. With `manual`, the first usable key in the list is chosen every time (it does not rotate), and when it fails the request moves to the next one.

**This is ordering only.** Disabled, cooling, quota-exhausted, and permanently invalid keys are hard-excluded under *either* policy — manual order is not "ignore the state and keep hammering key one", because then a single broken key would take the whole pool down with it.

Policy changes take effect **immediately**, like every other setting.

When a key fails temporarily (rate limiting `429`, server error `5xx`) it is **cooled down**, and during the cooldown it **does not participate** in key selection (it will not be used even if every other key is unavailable). It recovers automatically when the cooldown ends.

If **every** key is cooling down, the plugin **waits** for the earliest one to expire rather than failing immediately — but only when that moment falls inside the wait budget. It will not wait pointlessly past the budget: waiting for an expiry it cannot reach only defers the failure, so it returns the upstream error at once, preserving the original `request_id`.

A failing key triggers **failover**: the plugin switches to another key automatically. No key is tried twice within one request.

**Quota exhaustion** (`432` / `433`) is different from a cooldown: it is not a matter of "wait a moment", but of the key having no credits left in the current billing cycle. Such a key stays **unselected** until it is confirmed to have recovered.

Tavily resets usage on the **1st of each month**. Because the official documentation does not state which time zone that reset happens in, the plugin **probes automatically** after a month boundary has passed: starting from the UTC month start, it checks every 6 hours for up to 48 hours — a window wide enough to cover the month start in any time zone worldwide. A probe only calls the balance-query endpoint and **consumes no credits**.

You can also click **Refresh balance** in the panel to check immediately. If it has not recovered within 48 hours, that usually means you need to raise the limit on the [Tavily dashboard](https://app.tavily.com/account/plan) rather than wait.

If no key in the pool is usable, requests **fall back** according to the toggles above. There are three ways to land there: the search toggle is off, the key-pool file is corrupt (the plugin then continues from an empty pool and reports the file in the log), or the pool holds no candidate that could **recover within this request** (empty pool, everything disabled, everything quota-exhausted or permanently invalid).

> Note that "no usable key" and "just tried one and it failed" are different things: in the latter case there is a real upstream response in hand, and the plugin reports it faithfully (including its `request_id`) rather than retrying against a different source.

The fallback target can itself be unavailable, and the two ways that happens produce **different codes**, because they need different things from you:

| Code | Meaning | What to do |
|---|---|---|
| `TAVILY_FALLBACK_CREDENTIAL_MISSING` | The official credential was **never configured** | Configure one (the Models page in the panel, the `DEEPSEEK_API_KEY` environment variable, or `web-search-deepseek`'s `apiKey`) |
| `TAVILY_FALLBACK_CREDENTIAL_INVALID` | The official credential is configured but rejected upstream with `401` / `403` | Replace it, rather than configure it again |

Both errors also carry *why* the request left Tavily, because seeing only an error about a DeepSeek credential would send you to fix the wrong thing.

Key failures fall into three kinds:

- **Permanently invalid** (for example, the response body explicitly says the key was revoked or is invalid) — needs your action
- **Temporary failure** (rate limiting, server errors) — recovers automatically after a cooldown
- **Quota exhausted** (`432` / `433`) — recovers only once the balance is confirmed to have returned; see the [Tavily dashboard](https://app.tavily.com/account/plan) to raise the limit

## Balance refresh

The **Refresh balance** button in the panel calls Tavily's `/usage` endpoint to pull the official balance.

You rarely need it. Three things refresh a reading automatically:

- **A key that has never been read** is read the next time the plugin is used at all — a search or a fetch checks the whole pool and fills in the keys whose balance is still unknown. That matters because an unknown balance ranks last in scheduling.
- **The key actually being used** is re-read once its reading is over an hour old.
- **A key you just added** is read once, right after it is stored.

Keys that already have a reading — even a somewhat old one — are left alone unless they are the one being used. **Nothing runs in the background**: if you never search or fetch, the plugin never calls `/usage` on its own.

Tavily rate-limits that endpoint at **10 requests / 10 minutes**, so the plugin reserves quota per key and will not trip the limit. On failure it **keeps the old value and marks it stale** rather than overwriting with 0.

The plugin **does not infer the billing cycle** — balances always come from the current-cycle values returned by the official `/usage`.

## Billing

Tavily's billing rules (for reference — **the official docs are authoritative**):

- **Search**: `basic` / `fast` / `ultra-fast` cost 1 credit, `advanced` costs 2
- **Fetch**: every **5 successful** URL extractions cost 1 credit (`basic`) or 2 (`advanced`); failed URLs are **not charged**

A single fetch therefore usually costs **0 credits**: the five-URL counter is **cumulative across calls**, and a DSH fetch call carries one URL, so only every fifth successful fetch crosses a tier.

> ⚠️ **This plugin keeps no credit accounting of its own.** The two rules above are background only: the plugin does **not** total up "how many credits I spent", and it shows **no** locally computed credit figure anywhere.
>
> The reason is that these rules can change upstream at any time. If Tavily adjusts a tier or the way it charges, a locally computed number would not fail — it would quietly become wrong, and you would have no way to tell.
>
> The credit figure on the card always comes from the official `/usage` reading (limit − used). No locally computed number is ever shown as a figure of its own. One caveat worth knowing: the forward advance below moves the `used` value the card displays, so what you see is the last official reading **plus** the estimated cost of the calls since — and the card also tells you how old that last official reading is. Because a key's reading is refreshed automatically the next time it is used once that reading is over an hour old, that gap stays small.

### Why an estimate still exists

The scheduling policy is balance-first, and `/usage` cannot be refreshed on every call (it is rate-limited to 10 per 10 minutes). Without any forward advance, keys with plenty of quota would stay ranked first — ordering would keep using the stale numbers from the last `/usage` until you refreshed by hand.

So after each successful call the plugin **estimates** a cost from the two rules above, purely to nudge the cached balance forward so ordering roughly reflects reality. That estimate:

- is **never shown as a figure of its own**
- only affects scheduling order, where the worst case is that two keys swap places
- **does** move the displayed balance, which is why the card also shows how old the last official reading is
- is bounded: the reading is refreshed automatically the next time the key is used after an hour, so the estimate can only ever accumulate over that window

## Call history

Every Tavily call is recorded — the key used, the endpoint, whether it succeeded, the duration, and the upstream `request_id` when there is one — in:

```
~/.dsh/dsh-tavily-pool/history.json
```

The panel shows a **chart of daily call counts** over the last 14 days (search and fetch as separate lines, because their magnitudes differ too much to share a vertical scale) plus a table of the most recent calls.

> The chart plots **calls**, not credits: call counts come entirely from local facts (one entry is one real call) and are unaffected by upstream billing rules. Credits appear only once, at the top of the panel, as the official `/usage` reading.

**One request can produce several entries.** Key failover means each attempt is a separate real upstream call, so a search that tried two keys leaves one failed entry and one successful one. That is deliberate: those attempts were each real calls, and a request-level summary would hide them.

### Retention

Two limits apply **at once**, and the stricter one wins:

| Limit | Value | Why |
|---|---|---|
| Entry count | 500 (newest kept) | Stops high-frequency use from growing the file without bound |
| Age | 30 days | Stops low-frequency use from keeping a six-month-old entry forever |

The file therefore never exceeds roughly 100 KB. Trimming happens on every write — there is no background task, and no window in which the process could exit between two trims.

The age window is measured from the **newest entry**, not from the current time: a history file you copied from elsewhere, or one left behind after the system clock moved, is not wiped out the moment it is read.

There is **no credit field** in the history. Older versions (0.1.0 and earlier) wrote one; those fields disappear on the next write, because both reading and writing rebuild each entry from a whitelist and never carry unknown keys back.

If the history file cannot be written, calls are unaffected — the plugin reports it in the log and the chart is simply missing those entries. If it cannot be read, the panel says so instead of showing an empty chart.

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

To roll back only one of the two capabilities, change that field and keep the other one pointing at `tavily` — but keep **both lines** present either way. The table in [Toggles](#toggles) says which official value each field takes.

Saving takes effect immediately, with no restart (the profile's `patchReload` is `live`).

A profile initialized by `dsh plugin add` has exactly this shape: `dsh-tavily-pool` is listed in the profile's `dsh.profile.bundles`, after `@deepseek-ai/dsh-base` and `@deepseek-ai/dsh-web-app`, and the provider pin arrives as a bundle patch layer. Your own `cordis.patch.yml` is applied **after** every bundle layer, so it overrides both fields.

Afterwards you can disable or remove this plugin.

## How this differs from other DSH Tavily plugins

There are two other plugins on the same topic; this one is positioned differently:

| | `szmy-haruhi/dsh-tavily` | `@yuuz12/dsh-tavily` | **dsh-tavily-pool** |
|---|---|---|---|
| Key model | Single key / keyless | Multi-key pool | **Multi-key pool** |
| Balance-aware scheduling | No | Yes | **Yes** |
| Failover and cooldown | No | Yes | **Yes** |
| Call stats and history | No | Yes | **Yes** |
| Fetch takeover | No | No | **Yes** |
| Takeover method | Static config | Rewrites internal fields at runtime | **Static config** |

This plugin does **not** support keyless mode — a keyless call cannot be attributed to your account, so it cannot be accounted for and no balance can be shown.

## License

MIT

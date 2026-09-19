# piagent-realtime-provider-cost

Shows the **effective token prices (input/output, per 1M tokens)** of the
**last API call** in the Pi status bar – right next to the session cost sum.

Unlike the core footer's cost sum, these are the rates **actually billed by
OpenRouter** (including provider routing, discounts and peak overrides), not the
catalogue prices from `models-store.json`. For OpenRouter models the **serving
provider** is appended as a tag.

```
↑$2/↓$12 (Fir)    # arrows (Unicode, full size in every font), tag = Fireworks
in:$2/out:$12     # ASCII mode (icons: ascii)
↑$2/↓$12 (⟳)      # provider/costs are currently resolved via the generation API
↑$1.5/↓$6 (?)     # model just switched: catalogue prices, provider not known yet
```

**Colour:** the in/out **icons** are **coloured by their deviation from the
catalogue price** (green/yellow/orange/red, see [Colours](#colours)); the numbers
and the provider tag stay in the base colour (**white**). When a **provider
switch** is detected, the **whole** item is drawn **bold gold** (`bold:#ffd700`)
for one prompt – the deviation colours do not apply then.

All values are **per 1M tokens** in the configured currency.

## Contents

- [Installation](#installation)
- [Setup](#setup)
  - [Without pi-powerline-footer](#without-pi-powerline-footer)
  - [With pi-powerline-footer (recommended)](#with-pi-powerline-footer-recommended)
- [Colours](#colours)
- [Commands](#commands)
- [Configuration](#configuration)
  - [Icons](#icons)
  - [Rounding](#rounding)
- [How it works](#how-it-works)
- [Background: why the generation API detour?](#background-why-the-generation-api-detour)
- [Dependencies](#dependencies)

## Installation

```bash
pi install git:git@github.com:FloezWerk/piagent-realtime-provider-cost.git
```

> This repository is developed against a local Gitea instance and mirrored to
> the public GitHub repository `FloezWerk/piagent-realtime-provider-cost`.
> Installation instructions always reference the **GitHub** URL – the Gitea path
> is internal and must not appear in user-facing docs.

Local/development:

```bash
pi -e ./extensions/realtime-provider-cost.ts
```

After changes in a running session: `/reload`.

Afterwards the extension is active immediately – **without further
configuration** the value appears in the footer next to the cost sum. If you use
the Powerline bar, the item should additionally be hooked in there (next
section).

## Setup

### Without pi-powerline-footer

Works standalone: `ctx.ui.setStatus` is a core API, the core footer shows the
value as its own line below the status line.

### With pi-powerline-footer (recommended)

Add a custom item that reads the `realtime-provider-cost` status channel:

```jsonc
{
  "powerline": {
    "preset": "default",
    "customItems": [
      {
        "id": "provider-cost",
        "statusKey": "realtime-provider-cost",
        "position": "right",
        "color": "warning",
        "selfColorize": true,
        "hideWhenMissing": true,
        "excludeFromExtensionStatuses": true
      }
    ]
  }
}
```

Explicit positioning right next to `cost` via `powerline.layout`:

```jsonc
{
  "powerline": {
    "layout": {
      "left": ["model", "thinking", "shell_mode", "path", "git", "queue", "context_pct", "cache_read", "cost", "custom:provider-cost"]
    },
    "customItems": [
      { "id": "provider-cost", "statusKey": "realtime-provider-cost", "selfColorize": true }
    ]
  }
}
```

> **Important:** set `selfColorize: true`. Otherwise Powerline strips the item's
> ANSI colour codes and colours it itself – the dynamic white/gold switch on a
> provider change would be lost.

## Colours

There are two layers:

1. **Deviation colour coding.** The effective rate is compared with the model's
**catalogue price** (`models-store.json`); the colour shows the deviation. What
gets coloured are the **icons/arrows** (in and out separately); the numbers
themselves stay in the base colour so they remain readable on dark backgrounds.
The provider tag is also in the base colour.

   Thresholds are configurable (setting `deviationThresholds`, command
   `/provider-cost threshold …`); the percentages below are the defaults:

   | Deviation from catalogue price | Colour |
   | --- | --- |
   | more than `green` % **cheaper** (< −10 %) | **green** |
   | up to `yellow` % more expensive (0 % < x ≤ 10 %) | **yellow** |
   | `yellow`–`orange` % more expensive (> 10 % and ≤ 20 %) | **orange** (256-colour 208) |
   | more than `orange` % more expensive (> 20 %) | **red** |
   | otherwise (0 %, up to `green` % cheaper, or no catalogue price known) | base colour |

   > In and out are coloured **individually** (e.g. input arrow green, output
   > arrow red). If there is no effective price or no catalogue price (e.g. `?`),
   > the base colour stays.

   Example: `↑`green `$2` / `↓`red `$12` (numbers white).

   **Readability.** A terminal cannot draw an outline/stroke around glyphs (pure
   font rendering). Therefore the **icon** carries the deviation colour and the
   number stays neutral. `deviationStyle` controls the icon's SGR attributes:

   | `deviationStyle` | Effect |
   | --- | --- |
   | `plain` (default) | plain foreground colour on the arrow |
   | `bold` | arrow bolder/brighter (`SGR 1`) |
   | `reverse` | arrow as a coloured block (`SGR 7`) |

   Set via `/provider-cost style <plain|bold|reverse>` or setting
   `deviationStyle`.

2. **Base/switch colour** for everything else. **White** by default; when a
**provider switch** is detected the **whole** item is drawn **bold gold**
(`bold:#ffd700`) for one prompt and overrides the deviation colours. Set via
`/provider-cost color …` / `/provider-cost switchColor …` or the settings
`color` / `switchColor`.

Colour specs are freely choosable:

| Syntax | Example | Result |
| --- | --- | --- |
| Palette | `white`, `yellow`, `orange`, `red`, `green`, `cyan`, `magenta`, `blue`, `gray`, `none` | SGR 97/93/38;5;208/91/92/96/95/94/90 |
| Hex (truecolor) | `#ffd700`, `#fd0` | `38;2;r;g;b` |
| 256-colour | `226` (0-255) | `38;5;n` |
| Bold | `bold:yellow`, `bold:#ffd700`, `bold:226` | `1;<colour>` |
| Reverse | `reverse:red`, `reverse:orange` | `7;<colour>` (colour becomes the background) |
| Combined | `bold:reverse:red` | `1;7;<colour>` |

These are **not** CSS names and **not** theme names (`warning`, `error`, …) from
the Pi/Powerline theme world – the extension colours in ANSI itself so it can
switch dynamically (see `selfColorize` above).

Common alternatives for the switch highlight:

```bash
/provider-cost switchColor bold:#ffd700   # default: bold gold (truecolor)
/provider-cost switchColor bold:220       # gold, 256-colour (available everywhere)
/provider-cost switchColor bold:226       # pure yellow, 256-colour
/provider-cost switchColor bold:yellow    # bold bright yellow
/provider-cost color none                 # no colouring at all
```

## Commands

| Command | Effect |
| --- | --- |
| `/provider-cost` or `/provider-cost status` | State, currency, icons, colours, lookup+refresh interval, display, tag/source, cache age in prompts |
| `/provider-cost on` | Enable the display (persisted) |
| `/provider-cost off` | Disable the display (persisted) |
| `/provider-cost toggle` | Toggle (persisted) |
| `/provider-cost refresh` | Reload exchange rates **and** re-resolve provider/costs via the generation API (if possible) |
| `/provider-cost currency <CODE>` | Set the display currency (persisted) |
| `/provider-cost icons <auto\|nerd\|ascii>` | Set the icon mode (persisted) |
| `/provider-cost color <spec>` | Set the base colour, e.g. `white`, `#ffd700`, `226`, `bold:yellow` (persisted, see [Colours](#colours)) |
| `/provider-cost switchColor <spec>` | Set the switch colour (provider change) (persisted, see [Colours](#colours)) |
| `/provider-cost style <plain\|bold\|reverse>` | Attributes of the deviation colour on the in/out icon (persisted; default `plain`) |
| `/provider-cost threshold <green\|yellow\|orange> <pct>` | Set a deviation threshold in percent (persisted; defaults 10/10/20) |
| `/provider-cost lookup <on\|off\|refresh>` | Provider resolution on/off; `refresh` clears the provider **and** pricing cache and re-resolves |
| `/provider-cost notify <on\|off>` | Notification for every automatic generation-API request (persisted; default `off`) |

## Configuration

In `~/.pi/agent/settings.json` under the root key `realtime-provider-cost`
(matching the extension name). Other keys are left untouched; every value can
also be set via a command.

```jsonc
{
  "realtime-provider-cost": {
    "enabled": true,
    "currency": "EUR",
    "icons": "nerd",
    "color": "white",
    "switchColor": "bold:#ffd700",
    "deviationStyle": "plain",
    "deviationThresholds": { "green": 10, "yellow": 10, "orange": 20 },
    "lookupUpstreamProvider": true,
    "providerCacheRefreshPrompts": 10,
    "notifyGenerationLookup": false
  }
}
```

| Field | Default | Description |
| --- | --- | --- |
| `enabled` | `true` | Display on/off |
| `currency` | `"USD"` | `USD`, `CNY`, `EUR`, `GBP`, `JPY`, `CAD`, `AUD`, `CHF`, `INR`, `KRW` |
| `icons` | `"auto"` | `auto` (terminal heuristic), `nerd`, `ascii` – `nerd`/`auto` use `↑`/`↓`, `ascii` uses `in:`/`out:` |
| `color` | `"white"` | Base colour: palette name, `#rrggbb` or `0-255`, optionally with `bold:` |
| `switchColor` | `"bold:#ffd700"` | Colour right after a detected provider change |
| `deviationStyle` | `"plain"` | SGR attributes of the deviation colour on the icon: `plain`, `bold`, `reverse` |
| `deviationThresholds` | `{green:10, yellow:10, orange:20}` | Percentage thresholds: below `-green` green, up to `yellow` yellow, up to `orange` orange, above red (all ≥ 0) |
| `lookupUpstreamProvider` | `true` | Provider/cost resolution active (routing constraint + cache + generation API) |
| `providerCacheRefreshPrompts` | `10` | After this many **prompts** (user turns) a `generation` cache entry is refreshed; `0` = always re-resolve |
| `notifyGenerationLookup` | `false` | Notify before every automatic generation-API request (with reason) |

### Icons

1. Env `PROVIDER_COST_NERD_FONTS=1` (nerd) / `=0` (ascii)
2. Config `icons`
3. `auto`: heuristic like Powerline (`GHOSTTY_RESOURCES_DIR` or
   `TERM_PROGRAM`/`TERM` ∈ iterm, wezterm, kitty, ghostty, alacritty, kaku)

Many terminals only set `TERM=xterm-256color` → `auto` yields ASCII
(`in:`/`out:`); for icons use `icons: "nerd"` or `/provider-cost icons nerd`.

> The previously used Nerd Font arrows (`U+F090`/`U+F08B`) were replaced by
> `↑`/`↓` because private-use glyphs are rendered noticeably smaller.

### Rounding

Rounded to **at most 4 decimal places**, trailing zeros removed (`$2`, `$12.5`,
`$0.2896`).

## How it works

- **Real billing instead of catalogue price.** The source of the numbers is
  OpenRouter: the **generation API** returns `total_cost` (actually charged) and
  the token counts, and the **endpoint prices** provide the bucket ratio
  (input/output/cache) of the provider that actually served the request:

  ```
  modelled = prompt*in + completion*out + cacheRead*cacheReadTokens   (from endpoint prices)
  factor   = total_cost / modelled          # discounts, peak overrides, price changes
  in-rate  = prompt * factor                (USD per 1M tokens)
  out-rate = completion * factor
  ```

  The `factor` makes the display match the invoice even when endpoint prices do
  not (yet) exactly match the billed rate. As long as no API data is available,
  the approximation from `usage.cost.*` (Pi catalogue) is shown.

- **Resolution.** Order:
  1. **Routing constraint** from `models.json`
     (`providers.openrouter.modelOverrides.<model>.compat.openRouterRouting.only`)
     – only counts as *certain* when `allow_fallbacks: false` is set. With
     `allow_fallbacks: true` (OpenRouter default) another provider may serve even
     if `only` names exactly one.
  2. **Persistent rate cache** (`~/.pi/agent/realtime-provider-cost/provider-cache.json`),
     key = request model. Entries expire after `providerCacheRefreshPrompts`
     **prompts** (not by time).
  3. **Generation API** `GET https://openrouter.ai/api/v1/generation?id=<responseId>`
     – returns the provider **and** the real amount, at most 1 call per model at a
     time. Data is only available a few seconds after the call → retry with
     backoff (1s/2s/4s/8s). Meanwhile an **"update in progress" icon** (`⟳`) is
     shown instead of the provider tag.

  **When is the API called?**
  - Provider *certain* (one `only` entry **and** `allow_fallbacks: false`) →
    once on the first call, afterwards only every N prompts (rate cache).
  - Provider *not certain* (`allow_fallbacks: true` or no `only`) →
    **per response**, because only the actual provider counts.
  - **Model switch** (different request model than the previous call) → forced
    refresh of provider **and** costs, even if the cache would still be fresh. A
    session restore with the same model is not a switch.

  **Notification.** (Optional, default **off**: setting
  `notifyGenerationLookup` or `/provider-cost notify on`.) Every automatically
  triggered generation-API request is reported as a notify, including the reason
  in parentheses, e.g.
  `Generation API: resolving provider/costs for deepseek/… (cache miss).`
  Reasons: `cache miss`, `cache expired (N prompts)`, `cache without rates`,
  `stale cache`, `model switch`, `manual refresh` (`/provider-cost refresh`),
  `cache cleared` (`/provider-cost lookup refresh`).

- **Preview on model switch.** When the model is switched (`model_select`), the
  **catalogue prices** (`models-store.json`) of the new model are shown
  immediately. The serving provider is not known at that point yet (the first
  call of the new model is still running) → the tag shows `?`. As soon as the
  first response arrives, the real value (including provider tag, or `⟳` while
  resolving) replaces the preview. Tiered pricing is not applied in the preview –
  without token counts only the base rates are known.
  - **`/provider-cost refresh`** → reloads the exchange rates **and** forces a
    generation-API call (provider + costs) when possible (OpenRouter,
    `lookupUpstreamProvider` active, `responseId` present, no lookup already
    running). Clear the cache first with `/provider-cost lookup refresh`.

  The prompt counter is persisted in the cache and survives restarts. Example
  with `providerCacheRefreshPrompts: 10`: resolution on the 1st prompt, then
  again after the 10th further prompt.

- **Invalidation by call counter:** there is no signal that reveals a provider
  switch per response (model slug, `system_fingerprint`, `native_finish_reason`,
  `service_tier` are provider-independent). With a certain provider it is stable
  in the short term, so resolving every N prompts suffices; otherwise it is
  queried per response.
- **Two caches:** `provider-cache.json` (provider + rates per model) and
  `endpoint-pricing.json` (provider price lists, 24 h). `/provider-cost lookup refresh`
  clears both.
- **No batch endpoint:** OpenRouter offers neither multiple IDs nor a generations
  list; `/api/v1/activity` requires a management key.
- **While streaming** the last known value stays; it is only updated on
  `message_end`.
- **Failover:** if one side is not computable (e.g. `usage.input == 0`) or the
  conversion rate is missing, `?` is shown per side.
- **Subscription providers** (OAuth or `kimi-coding`) → the item is hidden.
- **Free models** are shown as `$0/$0`.
- **Currency conversion** mirrors `pi-powerline-footer` (same source, 24h cache,
  own file `…/realtime-provider-cost/currency-rates.json`); independent of
  Powerline.
- **No interference with Pi:** the extension replaces neither the footer nor the
  cost calculation; the session cost sum next to it remains Pi's catalogue value.

## Background: why the generation API detour?

OpenRouter delivers the serving provider in the stream chunk as a `provider`
field, but Pi (`pi-ai`) discards it (it only reads `chunk.id` and `chunk.model`).
Pi likewise discards the actual cost amount (`usage.cost`) and computes costs from
the price table (`models-store.json`) – which reflects the **model base price**,
not the price of the routed provider (example `deepseek/deepseek-v4.1-flash` via
Fireworks: catalogue 0.15/0.60 vs. real 0.22/0.66). No provider header exists
(`X-Provider-Name` is only listed as "exposed" but is not sent). The generation
API is therefore the only reliable source for provider and billed amount.

## Dependencies

`@earendil-works/pi-ai`, `@earendil-works/pi-coding-agent` and
`@earendil-works/pi-tui` are bundled by Pi and are therefore only declared as
optional `peerDependencies`. No runtime dependencies on other extensions.

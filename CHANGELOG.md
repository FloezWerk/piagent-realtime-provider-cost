# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.11.1] - 2026-09-19

### Fixed

- The deviation colour on the in/out arrows no longer turns yellow when the
  effective rate matches the catalogue price: the deviation is now computed from
  the rates rounded to the displayed precision (4 decimals in the display
  currency), so a rate that renders like the list price keeps the base colour.
  Binary-float noise of the invoice-derived rates (e.g. a factor of
  1.0000000000000002, `$0.20000000000000004` vs `$0.2`) previously produced a
  ~1e-14 % deviation and coloured the arrows.
- No more absurdly high rates for cache-heavy prompts: the billed amount is now
  matched against *all* token buckets (input, cache write, cache read, output)
  with the provider's price for each one. Cached prompt tokens were previously
  left out of the modelled total while OpenRouter counts them in `total_cost`,
  which inflated the correction factor (e.g. 36x for a first `gpt-5.6-luna` call
  on Azure with ~5.6k cache-write tokens).
- The endpoint-price cache no longer re-scales its stored (already per-1M) values
  by 1e6 on every load; a cache written by an older version is discarded
  (cache version 2).
- A generation-API lookup that returned no result no longer turns into one
  request per prompt: the failed attempt re-arms the cache window like a stored
  entry, so the prompt counter (and the notify reason `cache expired (N prompts)`)
  does not keep growing and the last known provider/costs stay in use.
- Free OpenRouter models no longer trigger a generation-API request after every
  prompt: a zero invoice yields no per-token rate, so the cache entry was never
  considered usable. Such an entry now stays valid for the whole cache window
  (`providerCacheRefreshPrompts`), and a zero invoice is reported as real `$0`
  rates.

## [0.11.0] - 2026-09-19

### Added

- Status-bar item with the effective in/out token prices (per 1M tokens) of the
  last API call, in a configurable currency (10 currencies, live FX rates)
- Serving-provider tag for OpenRouter models, resolved via the routing
  constraint, a prompt-count based persistent cache, and the generation API
  (retry with backoff, `⟳` pending icon, forced refresh on model switch)
- Catalogue-price preview on model switch (`?` tag) until the first call resolves
- Deviation colour coding on the in/out arrows versus the catalogue price
  (green/yellow/orange/red) with configurable thresholds and SGR style
  (`plain`/`bold`/`reverse`)
- Base colour plus a one-prompt bold-gold provider-switch highlight; colour
  specs support palette names, hex, 256-colour, `bold:`, `reverse:`
- Icon modes `auto`/`nerd`/`ascii`
- `/provider-cost` command with `on|off|toggle|refresh|status|currency|icons|`
  `color|switchColor|style|threshold|lookup|notify`
- Optional notify before every automatic generation-API request (default off)

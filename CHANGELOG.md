# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

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

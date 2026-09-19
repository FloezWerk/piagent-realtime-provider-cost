# AGENTS.md

Instructions for AI coding agents (e.g. pi coding agent) working in this repo.

## Keep this file short

This rule is first on purpose: keep `AGENTS.md` very short and concise –
prefer bullets over prose. When adding or editing a rule, condense, never expand.

## Language: English only

- Everything here is English: README/docs, code comments, user-facing strings
  (`ctx.ui.notify(...)`, command descriptions, help/error texts), settings docs.
- Never introduce German (or any other language); touching an existing string
  keeps it English.

## Project layout

- `extensions/realtime-provider-cost.ts` - the Pi extension (entry point)
- `src/` - pure modules: color, currency, endpoint-pricing, format, icons,
  model-routing, pricing, provider-cache, rates, settings, upstream
- `CHANGELOG.md` - user-facing changes per version (Keep a Changelog format)
- `.spec-flow/` - tooling state, not part of the extension
- CI/CD and the release tooling live in
  [pi-extension-release-tool](https://github.com/FloezWerk/pi-extension-release-tool)
  (reusable workflows pinned via `@v0.1`, CLI via `npx …@^0.1`); do not copy
  their logic into this repo

## Changelog is mandatory

- Every user-facing change gets a bullet under `## [Unreleased]` in `CHANGELOG.md`,
  in the same commit that introduces it (categories: `Added`, `Changed`, `Fixed`, ...).
- Internal refactors, CI/tooling tweaks, docs-only fixes: no entry.
- `release.yml` rejects a tag without a matching `## [X.Y.Z]` entry.
- `README.md` has two generated blocks - the badges (from `package.json`) and
  the release notes of the current version (from `CHANGELOG.md`) - written by
  `npm run readme` and verified by `npm run check` (Gitea, the GitHub mirror and
  npm render the README). Never edit them by hand.

## Checks

- `npm run check` - README release-notes block is up to date (via the release
  tooling), bundle smoke test, `npm pack --dry-run`. It runs in CI through the
  shared reusable workflow (`ci.yml` only calls it); peers stay external,
  nothing to install
- `npm run readme` - regenerate the README release-notes block from `CHANGELOG.md`
- `npm run typecheck` - `tsc --noEmit` (needs devDependencies installed)
- Before committing: quick "no German" review of all touched strings/docs.

## Releasing

1. Move `[Unreleased]` bullets to `## [X.Y.Z] - YYYY-MM-DD` in `CHANGELOG.md`
2. Bump `"version"` in `package.json` to `X.Y.Z`, run `npm run readme`, commit
   both (the README block then already shows the notes on Gitea)
3. `git tag -a vX.Y.Z -m "vX.Y.Z" && git push origin vX.Y.Z`
   -> Gitea mirrors the tag -> `release.yml`: npm publish (provenance, scope
   `@floez-werk`) + GitHub release, both with the CHANGELOG section as notes

## Repository: local Gitea + public GitHub mirror

- Everything committed here becomes publicly readable on GitHub.
- Never commit sensitive data (keys, tokens, passwords, personal data) -
  source, docs, examples and history included. Use env vars or untracked files.
- `origin` = Gitea (`ssh://git@gitea/FloezWerk/piagent-realtime-provider-cost.git`),
  push target. Public GitHub URL:
  `git@github.com:FloezWerk/piagent-realtime-provider-cost.git`.
- Install instructions always use the GitHub URL or the npm package, never the
  Gitea path (internal):
  `pi install git:git@github.com:FloezWerk/piagent-realtime-provider-cost.git` or
  `pi install npm:@floez-werk/piagent-realtime-provider-cost`
- Exception: refreshing the locally installed copy uses the Gitea source it
  came from: `pi update ssh://git@gitea/FloezWerk/piagent-realtime-provider-cost.git`.

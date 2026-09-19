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

## Changelog is mandatory

- Every user-facing change gets a bullet under `## [Unreleased]` in `CHANGELOG.md`,
  in the same commit that introduces it (categories: `Added`, `Changed`, `Fixed`, ...).
- Internal refactors, CI/tooling tweaks, docs-only fixes: no entry.
- `release.yml` rejects a tag without a matching `## [X.Y.Z]` entry.

## Checks

- `npm run check` - bundle smoke test + `npm pack --dry-run` (the same scripts
  run in CI, see `.github/workflows/ci.yml`; peers stay external, nothing to install)
- `npm run typecheck` - `tsc --noEmit` (needs devDependencies installed)
- Before committing: quick "no German" review of all touched strings/docs.

## Releasing

1. Move `[Unreleased]` bullets to `## [X.Y.Z] - YYYY-MM-DD` in `CHANGELOG.md`
2. Bump `"version"` in `package.json` to `X.Y.Z`, commit
3. `git tag -a vX.Y.Z -m "vX.Y.Z" && git push origin vX.Y.Z`
   -> Gitea mirrors the tag -> `release.yml`: npm publish (provenance, scope
   `@floez-werk`) + GitHub release

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

# AGENTS.md

Instructions for AI coding agents (e.g. pi coding agent) working in this repo.

## Language: English only

Everything in this project is written in **English** – this applies to:

- `README.md` and any other documentation
- source code comments and docstrings
- user-facing output: `ctx.ui.notify(...)` messages, command descriptions,
  usage/help strings, error/warning texts, status text
- settings keys and their descriptions

Do **not** introduce German (or any other language) text. The project was
originally written with German comments/messages and was fully translated – keep
it that way. If you touch an existing string or comment, keep it English.

The project is operated via the **pi coding agent**, which reads this file
automatically at the start of a session.

## Project layout

- `extensions/realtime-provider-cost.ts` – the Pi extension (entry point).
- `src/` – pure, testable modules: `color`, `currency`, `endpoint-pricing`,
  `format`, `icons`, `model-routing`, `pricing`, `provider-cache`, `rates`,
  `settings`, `upstream`.
- `.spec-flow/` – tooling state, not part of the extension.

## Checks

```bash
npm run typecheck   # tsc --noEmit
```

All user-facing strings and docs must pass a quick "no German" review before
committing.

## Repository: local Gitea + public GitHub mirror

- This repo is developed against a **local Gitea** instance and **mirrored to a
  public GitHub repository**. Everything committed here becomes publicly
  readable on GitHub.
- **Never commit sensitive data** – no API keys, tokens, passwords, credentials
  or personal data. This applies to source, docs, config examples and git
  history. Sensitive values belong in env vars or local (untracked) config.
- Remote: `origin` = Gitea (`ssh://git@gitea/FloezWerk/piagent-realtime-provider-cost.git`)
  – this is the push target. The public GitHub URL is
  `git@github.com:FloezWerk/piagent-realtime-provider-cost.git`.
- **Installation instructions always use the GitHub URL**, never the Gitea path
  (the Gitea path is internal). Example:
  `pi install git:git@github.com:FloezWerk/piagent-realtime-provider-cost.git`.
- Exception: the locally installed extension copy was installed from the Gitea
  source, so refreshing it uses that same source:
  `pi update ssh://git@gitea/FloezWerk/piagent-realtime-provider-cost.git`.
- npm releases are published under the **`@floez-werk`** scope (package name
  `@floez-werk/piagent-realtime-provider-cost`, `publishConfig.access: public`).

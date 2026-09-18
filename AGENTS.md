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

## Git workflow

- Commit/push only when asked; ask before switching branches.
- Remote: `origin` = Gitea (`ssh://git@gitea/FloezWerk/piagent-realtime-provider-cost.git`).
- After pushing, the installed extension copy can be refreshed with
  `pi update ssh://git@gitea/FloezWerk/piagent-realtime-provider-cost.git`.

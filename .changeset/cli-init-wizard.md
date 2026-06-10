---
"@eidentic/cli": minor
"eidentic": minor
---

Interactive `eidentic init` wizard: provider/model/API-key prompts, optional dependency install, package-manager detection (pnpm/yarn/bun/npm). Non-TTY and `--yes` flag path unchanged for scripting. New flags: `--model`, `--api-key`, `--yes`, `--install`/`--no-install`. API key is written into `.env` only after `.gitignore` is secured.

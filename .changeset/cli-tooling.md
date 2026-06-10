---
"@eidentic/cli": minor
"create-eidentic": minor
---

Modernize the CLI tooling. `@eidentic/cli` now uses **citty** for command/arg parsing with **consola** + **picocolors** for output (`eidentic doctor`, `eidentic dev`, auto `--help`/`--version`). `create-eidentic` gains an interactive **@clack/prompts** flow (project name + model-provider selection, scaffolds the right provider dep / env var / agent import); a non-interactive path (dir arg, non-TTY) still scaffolds with defaults.

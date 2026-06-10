---
"@eidentic/cli": minor
"eidentic": minor
---

Add `eidentic init` command (scaffold Eidentic into an existing project: writes `eidentic.config.ts`, `src/agent.ts`, `.env`, `.env.example`, `.gitignore`; idempotent) and automatic `.env` loading on CLI start using Node-native `process.loadEnvFile()` — no new deps. All commands (`doctor`/`dev`/`studio`/`init`) now pick up `ANTHROPIC_API_KEY` etc. from a project-local `.env` automatically. `doctor` also reports whether a `.env` file exists in cwd (informational).

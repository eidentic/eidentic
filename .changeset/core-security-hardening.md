---
"@eidentic/core": patch
---

Security hardening — 4 core findings (findings #3, #6, #7, #9):

- **#3 (High)** — `resumeTurn` now re-runs input guardrails on the last user event before passing messages to the model, mirroring `runTurn`. PII/secret/off-topic text that was redacted on the first turn no longer leaks to the model on HITL or crash-resume paths.
- **#6 (Medium)** — `topicGuardrail` wraps user text in `<user_input>` delimiters so the classifier treats it as data, not instructions. Response parsing now uses an exact first-token match before falling back to substring includes; a reply containing both ALLOW and BLOCK is treated as uncertain (→ block unless `allowOnUncertain`). Added JSDoc best-effort caveat.
- **#7 (Medium)** — When the session-prefixed idempotency key is absent, `ToolRegistry` falls back to reading the bare `toolKey` (pre-prefix compatibility) before deciding to re-execute. New entries are always written with the prefixed key. Prevents previously-settled destructive tools from re-executing after an upgrade.
- **#9 (Medium)** — `redactValue` in `logger.ts` now carries a `WeakSet` cycle guard and a depth cap (20) to prevent unbounded recursion on cyclic objects. `VALUE_SECRET_RE` broadened to cover JWTs (`eyJ…`), AWS access key IDs (`AKIA…`), Slack tokens (`xox[baprs]-`), and GitHub tokens (`ghp_`/`gho_`).

---
"@eidentic/types": minor
"@eidentic/core": minor
---

Security foundations (§10/§20): deny-by-default permission policy and `SecretsPort` credential isolation.

**Permissions (`@eidentic/types` + `@eidentic/core`):**

- `PermissionPolicy` (deny/plan/allow/ask modes + glob lists) is evaluated in two layers: *schema layer* (`filterToolsForSchema`) removes statically-denied tools before the model ever sees them, and *dispatch gate* (`evaluatePermission` + `ToolRegistry.resolvePermission`) blocks any call that slips through at execution time — the tool body never runs.
- `PermissionMode`: `"default"` (allow all), `"plan"` (deny non-read-only), `"ask"` (dynamic resolver), `"bypass"` (unconditional allow), `"acceptEdits"`.
- Deny globs (`deny: ["delete_*"]`) win over every other rule. Plan mode denies any tool with `sideEffect !== "read-only"`.
- `globMatch` — anchored `*` wildcard matching used throughout permission evaluation.
- `Agent` accepts `permissions`, `onPreToolUse` (short-circuit hook), and `onPermissionRequest` (dynamic resolver for `ask`-mode tools). Denied results carry `meta.permissionDenied: true`.

**Secrets (`@eidentic/types` + `@eidentic/core`):**

- `SecretsPort` — minimal async interface (`get(ref): Promise<string | undefined>`). The model never sees secret values; they are injected into each tool's `ctx.secrets` at dispatch time only (§10.3).
- `EnvSecrets` (`@eidentic/core`) — `SecretsPort` backed by `process.env`.
- `MapSecrets` (`@eidentic/types/testing`) — in-memory `SecretsPort` backed by a plain record; for tests and offline demos.
- `ToolContext` (`ctx`) is injected into every tool `execute` call and carries `ctx.secrets`, `ctx.scope`, and `ctx.signal`. Existing tools that ignore `ctx` are unaffected (the argument is optional).
- `Agent` accepts `secrets: SecretsPort`; it is forwarded into the `ToolRegistry` and from there into each dispatch — the value is never serialised into the prompt, messages, or tool schemas.

**Deferred:** E2B/microsandbox `SandboxPort` (executable-skill code execution) is deferred to the executable-skills plan.

---
"@eidentic/tools": minor
---

New `@eidentic/tools` package: the built-in atomic tool set (§5.8) that makes Eidentic an end-to-end agent out of the box, with §5.6 sealed-endpoint security.

- **`fileTools({ root })`** — `read_file`, `write_file`, `edit_file`, `glob`, `grep`, all confined to a workspace `root`. Path traversal, absolute paths, and symlink escape are impossible (mirrors the `@eidentic/skills` `confinedResolve` containment). read/glob/grep are read-only (parallelizable); write/edit are destructive with idempotency keys. Outputs are size-bounded.
- **`bashTool(sandbox, opts?)`** — the sealed shell. `bash` executes ONLY via the injected `SandboxPort`, never the host process; with `NoneSandbox` it refuses (secure default, §10.7). Destructive and non-idempotent (no idempotency key — `durableUnprotected` under durable runs).
- **`webTools({ allowlist, fetchImpl?, search? })`** — `web_fetch` is sealed and egress-allowlisted (exact or dot-boundary suffix host match; an empty allowlist denies all). The agent supplies only `url`; method/headers/body are fixed; non-http(s) schemes and off-allowlist redirects are rejected. `web_search` is included only when you bring a provider; its credentials come from `ctx.secrets`, never the model.

Runtime deps are `@eidentic/core` + `@eidentic/types` only (Node built-ins for I/O). Deferred: lazy discovery `search_tools`/`load_tool` (§5.4), browser tools. A generic `http_request`/`exec` tool is intentionally never shipped (§5.6).

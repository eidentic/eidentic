---
"@eidentic/core": patch
---

Replace `node:crypto` SHA-256 with the Web Crypto API (`globalThis.crypto.subtle.digest`) so `@eidentic/core` works zero-config on Cloudflare Workers, Deno, Bun, and browsers — no `nodejs_compat` flag required.

All five call sites (`replay-hash.ts`, `tool.ts`, `loop.ts`, `agent.ts`, `skill-tools.ts`) now use a shared `sha256Hex` helper. The SHA-256 hex output is byte-identical, so existing event-replay hashes and checkpoint values continue to match.

The `ToolDef.idempotencyKey` and `Tool.idempotencyKey` types are widened from `(input) => string` to `(input) => string | Promise<string>` — existing sync implementations remain valid.

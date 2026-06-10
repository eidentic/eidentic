---
"@eidentic/types": patch
"@eidentic/core": patch
"@eidentic/skills": patch
---

Internal refactor: deduplicate `canonicalJson` — move the single canonical implementation to `@eidentic/types` and remove the 6 copy-pasted copies in `core` and `skills`.

The function was previously copy-pasted into `packages/core/src/tool.ts`, `packages/core/src/agent.ts`, `packages/core/src/replay-hash.ts`, `packages/core/src/loop.ts` (nested inside `chainHash`), `packages/skills/src/sign.ts`, and `packages/skills/src/executable.ts`. All 6 copies were confirmed byte-for-byte identical in output. The shared implementation lives in `packages/types/src/canonical-json.ts` and is re-exported from the `@eidentic/types` barrel.

No behavior change — hashes, signatures, and idempotency keys are unaffected.

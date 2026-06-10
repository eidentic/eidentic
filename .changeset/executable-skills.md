---
"@eidentic/skills": minor
---

Executable skills + safety substrate (§7.1, §7.4, §7.6): the test-gated, versioned, signed executable
skill kind on top of the existing interop-skill substrate.

**`@eidentic/skills`** — three additions (runtime dep stays `@eidentic/types`-only):

- **Executable skill model** (`executable.ts`): `ExecutableSkillDef` (`name`, `description`,
  `allowedTools?`, `tests`, and EXACTLY ONE of `run` (typed-function, trusted/dev) or `code`
  (code-string, agent-authored, run via an injected `SandboxPort`)), `SkillTest`, `SkillRunContext`,
  and the `SkillLock` provenance record. Plus a LOCAL `globMatch` + deny-by-default
  `isToolAllowed(allowedTools, toolId)` (a byte-for-byte mirror of `@eidentic/core`'s `globMatch`, kept
  local to preserve the drop-in dep boundary) and a canonical-JSON `contentHashOf`.

- **Skill Bank** (`bank.ts`): `SkillBank.register` runs ALL `def.tests` and registers ONLY if every
  test passes (the §7.4 test-gate) — a failing test returns `{ ok: false, failures }` and the skill is
  NOT added. On success it writes a versioned `skill.lock` (`version` increments per name; provenance:
  `author`, `contentHash`, per-test pass/fail, `createdAt`; `quarantined: author === "agent"`).
  `use(name, input, ctx)` runs a registered, non-quarantined, (if `requireSigned`) signature-verified
  skill, wrapping `ctx.callTool` so a tool id NOT in the skill's `allowedTools` is rejected
  (deny-by-default). Code-string skills execute via the injected `SandboxPort` (default: a refusing
  sandbox mirroring `NoneSandbox` — secure-by-default). Plus `approve(name)` (clears quarantine),
  `setSignature`, `get`, `list`.

- **Signing** (`sign.ts`): `generateSkillKeypair` (ed25519 via `node:crypto`), `signLock(lock,
  privateKeyPem)` (signs the canonical lock MINUS `signature`), `verifyLock(lock, publicKeyPem)`. A
  `SkillBank({ requireSigned: true, verifyKey })` refuses `use()` of an unsigned/invalid-signature
  skill. A tampered lock field flips verification to `false`.

**Deferred (explicitly out of scope — the §7.7/§0-C12 research bet, off by default):** the
self-evolution MUTATION loop (external optimizer, opt-in), automatic skill merge/prune by consolidation, multi-objective Pareto
optimization, cross-runtime registry import/verification against an external registry, per-skill
`.memory.md`→code refinement, and human-gated diff-review self-modification. v1 ships the SAFE
SUBSTRATE, not the optimizer.

# @eidentic/skills

## 0.2.2

### Patch Changes

- Updated dependencies [4cf1e3b]
  - @eidentic/types@0.5.0

## 0.2.1

### Patch Changes

- Updated dependencies [4b06c20]
  - @eidentic/types@0.4.0

## 0.2.0

### Minor Changes

- 2360146: Harden tenant identity propagation and modernize the release path.

  - Session ownership now carries API-key principals through core, server, Next.js, A2A, MCP,
    workflow agent steps, and first-party durable store adapters.
  - SQLite, LibSQL, Postgres, and Convex stores persist and filter sessions by `apiKey`.
  - Output guardrails now block or redact before assistant events are persisted or ingested into memory.
  - Pinecone and Qdrant vector adapters isolate logical IDs per scope, preventing cross-scope overwrite/delete.
  - Optional Ollama support stays peer-only instead of pulling the provider into CI.
  - Studio's Vite build now explicitly targets ES2022 to match the UI TypeScript target under the updated esbuild toolchain.
  - Memory and graph mutation tools now provide scope-aware idempotency keys.
  - Skills can pass cancellation signals into executable skills and configure sandbox timeouts.
  - Workflow run registries expose `flush()` for deterministic durable write-through and crash-safety tests.
  - Release automation now uses a single checked publish script with Changesets and npm Trusted Publishing/OIDC.

### Patch Changes

- Updated dependencies [2360146]
  - @eidentic/types@0.3.0

## 0.1.3

### Patch Changes

- Updated dependencies [9d3b98d]
  - @eidentic/types@0.2.1

## 0.1.2

### Patch Changes

- Updated dependencies
- Updated dependencies [7c454e5]
- Updated dependencies [de07ecc]
  - @eidentic/types@0.2.0

## 0.1.1

### Patch Changes

- Republish all packages via GitHub Actions trusted publishing (OIDC). This is the
  first release with provenance attestation — every package now carries a verifiable
  build provenance statement linking it to its source commit and workflow.
- Updated dependencies
  - @eidentic/types@0.1.1

## 0.1.0

### Minor Changes

- 3a605b5: Clarify public API names (pre-1.0 renames):

  - `LanceVectorStore` → `LanceDBVectorStore` (`@eidentic/lancedb`)
  - `agentRunner` → `createRunner` (`@eidentic/eval`)
  - `discoveryTools` → `lazyDiscoveryTools` (`@eidentic/core`)
  - `dedupeArchival` → `deduplicateArchival` (`@eidentic/memory` — method on `Memory` + `ConsolidationScheduler`)
  - `NoneSandbox` → `NoopSandbox` (`@eidentic/core`)
  - `EAGER_CORE` → `EAGER_TOOL_IDS` (`@eidentic/core`)
  - `globMatch` → `matchSkillGlob` (`@eidentic/skills` only; `@eidentic/core`'s `globMatch` is unchanged)

  Tooling bump (root dev dependency, no changeset required):

  - `typescript` `^5.7.0` → `^5.9.0`

  Note: `@electric-sql/pglite` bump to `^0.5.0` was attempted but reverted — pglite 0.5 removed
  the `./vector` sub-path entirely (pgvector no longer bundled, no standalone replacement package
  available as of 2026-06-07). Staying on `^0.4.6` until upstream ships a compatible upgrade path.

- 3a605b5: Executable skills + safety substrate (§7.1, §7.4, §7.6): the test-gated, versioned, signed executable
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

- 3a605b5: Retrospective security/correctness/performance hardening across the stack:

  - **Session safety:** `Session.open` now binds a session to its `agentId` (opening another agent's session throws), and turn-level event appends that conflict (e.g. a concurrent writer) yield a terminal `result{subtype:"error"}` instead of throwing out of the agent generator.
  - **Prompt-context integrity:** untrusted text (memory block label/value, recall snippets, skill name/description) is escaped when assembled into the `<memory>`/`<recall>`/`<skills>` system-prompt regions, and memory block labels are charset-validated at the tool boundary — preventing delimiter/structure injection.
  - **Scope isolation:** the `memories` re-index delete is now scope-filtered, and `VectorPort.delete` gained a required `scopeKey` argument (implemented across LanceDB/pgvector/Qdrant/Pinecone + fakes) so a duplicated id can't be deleted cross-tenant.
  - **Vector scores unified:** all adapters now report cosine similarity (exact match ≈ 1.0); a conformance case pins this.
  - **Consolidator:** model-supplied `confidence` is clamped to `[0,1]` (also in the `graph_assert` tool); facts rejected by the temporal-order guard are surfaced in a new `ConsolidationResult.rejected` bucket instead of being silently dropped.
  - **Performance:** single store read in `getAlwaysInContext`, targeted `StorePort.getBlock(scope, label)` lookup for block edits, a new `idx_facts_scope_active` index for currently-valid-fact queries, cached session events (no double `readEvents` per turn), and precomputed skill search tokens.

- 3a605b5: §7.7 skill self-evolution: agentic-context-engineering optimization pattern, native over ModelPort — test-gated, cost-bounded,
  human-gated, persisted, OFF BY DEFAULT.

  **Architecture decision:** the design references an external prompt-optimization library as the optimizer. That library ships
  its own model-client layer that conflicts with Eidentic's BYO-`ModelPort` architecture. The
  optimization algorithm is therefore implemented natively over `ModelPort` (the test-gate IS the reflection
  signal) and an `Optimizer` seam is exposed so an external optimizer can be plugged in later. No external optimizer library
  is added as a dependency.

  **New exports from `@eidentic/skills`:**

  - **`evolveSkill(skill, opts)`** — the optimization loop: establishes a baseline via the shared
    test-gate, then for up to `maxRounds` calls the proposer model with a `propose_skill_edit`
    tool (ADD/UPDATE/REMOVE on the skill's `instructions`/`description`). Each candidate is run
    through the real test-gate. The first candidate that passes all tests becomes `result.evolved`.
    Malformed proposer output (no tool call / unchanged instructions) skips the round without
    crashing. The loop stops on first passing candidate, round exhaustion, or `maxUsd` cost ceiling.
    `evolveSkill` NEVER auto-registers — the caller decides.

  - **`EvolveOptions`** — `model`, `maxRounds` (default 3), `maxUsd` (optional cost ceiling),
    `optimizer` (override the default `ModelOptimizer`), `now`.

  - **`EvolveResult`** — `evolved` (passing candidate or null), `baselinePassed`, `rounds`,
    `usage` (total proposer tokens, surface to `cost.background`), `history`.

  - **`Optimizer`** interface — the seam for a future external-optimizer adapter:
    `propose({ instructions, failures, tests }) → { instructions, usage }`.

  - **`ModelOptimizer`** — default `Optimizer` implementation using `ModelPort`. Builds a
    structured system+user prompt with the failing test names as the reflection signal, calls
    the model with the `propose_skill_edit` tool, and applies ADD/UPDATE/REMOVE semantics.

  - **`runSkillTests(def, callTool?, invoker?)`** — shared test-gate helper extracted from
    `SkillBank`. Both `SkillBank.register` and `evolveSkill` call this; test-gate logic is NOT
    duplicated. `SkillBank` passes its sandbox invoker for code-string skills; `evolveSkill` uses
    the default (typed-function skills only in the evolution surface).

  **Properties:**

  - **OFF BY DEFAULT:** `evolveSkill` is an opt-in function, never auto-runs in the Agent loop.
  - **Test-gated:** no candidate is returned unless it passes ALL declared `SkillTest`s.
  - **Cost-bounded:** `maxRounds` (default 3) + optional `maxUsd` ceiling stop the loop.
  - **Human-gated:** `evolveSkill` never calls `SkillBank.register`. The caller registers with
    `author: "agent"` → SkillBank quarantines it until `approve()` (the existing human gate).
  - **Persisted:** once the caller registers the evolved skill, `SkillBank` writes a versioned
    `skill.lock` with provenance (same as any other skill registration).

- 3a605b5: Skill System substrate (§7, v1): the durable foundation for reusable, discoverable skills. New drop-in `SkillPort` (`catalog`/`search`/`use`/`recordOutcome`) in `@eidentic/types`, mirroring `MemoryPort` so `@eidentic/core` depends only on `@eidentic/types`. New `@eidentic/skills` package (runtime-dep = only `@eidentic/types`) ships `parseSkillMd` — a dependency-free, agentskills.io-compatible `SKILL.md` frontmatter parser (`name`, multi-line `description`, inline `allowed-tools`) — and `SkillSet`, an in-memory + directory-backed implementation with 3-tier progressive disclosure (Tier-1 catalog, Tier-2 body on `skill_use`, Tier-3 per-skill `.memory.md`), description-scored search, and a `SkillProvenance` record (source + sha256 content hash + author). `@eidentic/core` exposes read-only `skill_search`/`skill_use` tools and injects a deterministic `<skills>` catalog block into the system prompt whenever an `Agent` is given `skills`. Drop-in unchanged: skills are opt-in and the no-skills loop/registry/prompt path is byte-for-byte identical. Explicitly deferred (off-by-default research bets, §7.7/§0-C12): the self-evolution loop and external optimizer integration, sandboxed executable-skill code execution (§10), signing/verification enforcement, `allowed-tools` capability enforcement (recorded, not enforced in v1), human-gated mutation, skill merge/prune consolidation, and registry import.

### Patch Changes

- 3a605b5: Internal refactor: deduplicate `canonicalJson` — move the single canonical implementation to `@eidentic/types` and remove the 6 copy-pasted copies in `core` and `skills`.

  The function was previously copy-pasted into `packages/core/src/tool.ts`, `packages/core/src/agent.ts`, `packages/core/src/replay-hash.ts`, `packages/core/src/loop.ts` (nested inside `chainHash`), `packages/skills/src/sign.ts`, and `packages/skills/src/executable.ts`. All 6 copies were confirmed byte-for-byte identical in output. The shared implementation lives in `packages/types/src/canonical-json.ts` and is re-exported from the `@eidentic/types` barrel.

  No behavior change — hashes, signatures, and idempotency keys are unaffected.

- 3a605b5: Full-audit remediation + feature wave (PRs #143–#162).

  Security: A2A task ownership + bounded store; per-tenant workflow runs (owner + UUID ids); pre-auth rate limiting + per-client anon buckets; apiKey session ownership; MCP transport auth hook; chunked body cap; prompt-injection escapes (skill_reference/user_input); web_fetch oversize + URL secret stripping; timing-safe OAuth compare; langfuse redaction hooks.

  Correctness: single-connection pg.Pool transactions; atomic libsql upsert; FTS5 quote escaping; pgvector composite (id,scope_key) key; lancedb filter hardening; workflow failed-run recording + composite map errors + abort propagation; react unmount/polling fixes; persisted structured-output retries; sandbox timeouts/abort.

  Features: workflow durable run store + suspend/resume (deterministic replay) + per-step retry + versioning + map collect mode; HMAC-signed webhooks; CORS + graceful drain; onPostToolUse hook; typed terminal result details; per-turn context injection; persistent memory ingest metadata (sqlite/libsql v10, postgres v8 migrations); Bun template; typed useAsyncRun + stream retry; studio share links.

- 3a605b5: Pre-publish audit fixes (packaging, correctness, security, quality).

  - **Packaging (all 21 packages)**: add `"files": ["dist"]` so npm publish ships only `dist/` and not `src/`, `test/`, or `.turbo/`.
  - **Cost governor (core)**: fold each reflection/planAndExecute sub-run's own-foreground spend into the shared budget after `drainReact`, mirroring `spawn_agent`'s double-count-safe accounting. Previously `policy.maxCostUsd` was enforced per-pass, not cumulatively.
  - **Umbrella strategy exports (eidentic)**: re-export `react`, `reflection`, `planAndExecute` values and `AgentStrategy`, `StrategyContext`, `GroundSignal` types from `@eidentic/core`.
  - **LIMIT parameterization (sqlite, libsql, postgres)**: bind `LIMIT` as a parameter in `listSessions` and `queryFacts` instead of string-interpolating.
  - **SSRF defense-in-depth (tools)**: `isBlockedHost` now catches non-dotted IPv4 encodings (decimal `2130706433`, hex `0x7f...`, octal).
  - **Recall denominator (bench)**: filter blank gold facts from the denominator in `recallAtK`; upgrade the `[0,1]` range assertion to a precise exact-value gate.
  - **Resume IDOR doc note (core, server)**: JSDoc and route comment clarify that `resume` does not verify session ownership per-principal; multi-tenant deployments must add an ownership layer.

- Updated dependencies [3a605b5]
- Updated dependencies [3a605b5]
- Updated dependencies [3a605b5]
- Updated dependencies [3a605b5]
- Updated dependencies [3a605b5]
- Updated dependencies [3a605b5]
- Updated dependencies [3a605b5]
- Updated dependencies [3a605b5]
- Updated dependencies [3a605b5]
- Updated dependencies [3a605b5]
- Updated dependencies [3a605b5]
- Updated dependencies [3a605b5]
- Updated dependencies [3a605b5]
- Updated dependencies [3a605b5]
- Updated dependencies [3a605b5]
- Updated dependencies [3a605b5]
- Updated dependencies [3a605b5]
- Updated dependencies [3a605b5]
- Updated dependencies [3a605b5]
- Updated dependencies [3a605b5]
- Updated dependencies [3a605b5]
- Updated dependencies [3a605b5]
- Updated dependencies [3a605b5]
- Updated dependencies [3a605b5]
- Updated dependencies [3a605b5]
- Updated dependencies [3a605b5]
- Updated dependencies [3a605b5]
- Updated dependencies [3a605b5]
- Updated dependencies [3a605b5]
- Updated dependencies [3a605b5]
- Updated dependencies [3a605b5]
- Updated dependencies [3a605b5]
- Updated dependencies [3a605b5]
- Updated dependencies [3a605b5]
- Updated dependencies [3a605b5]
- Updated dependencies [3a605b5]
- Updated dependencies [3a605b5]
- Updated dependencies [3a605b5]
- Updated dependencies [3a605b5]
- Updated dependencies [3a605b5]
- Updated dependencies [3a605b5]
- Updated dependencies [3a605b5]
  - @eidentic/types@0.1.0

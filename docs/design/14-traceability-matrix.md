# 14. Traceability Matrix

[← 13. Packaging & DX](13-packaging-dx.md) · [Index](master-design.md) · Next: [15. Data Governance →](15-data-governance.md)

Every design choice traces to a **sourced** production gap. This is the
"ratcheting principle": each constraint exists because of an observed failure. If a row's
gap ever stops being real, the constraint can be reconsidered.

## 14.1 Constitution → gap answered

| # | Principle | Sourced gap it answers | Design sections |
|---|-----------|------------------------|-----------------|
| 1 | Composable, no lock-in | *"not a layer — the stack itself"* (#1 complaint); framework lock-in locks architecture 12–24 mo | §2.1–2.2, §6.9 |
| 2 | Stable API + semver | Near-weekly breakage (*"feels untested"*); coordination primitives shipped then deprecated in a year | §3.2, §8.7, §13.2 |
| 3 | Fundamentals architected day-one | 88–95% pilots fail on architecture; bolt-on durability/obs/cost/security kills frameworks | §2.6, §2.8, §9, §10, §11 |
| 4 | Context engineering core | Context rot 98%→64%; "lost in the middle"; #1 job per Cognition | §4 |
| 5 | Transparent cost | Hidden background model calls (invisible tokens) | §4.3, §6.5, §11.2 |
| 6 | Grounded verification | "LLMs cannot self-correct reasoning yet"; same-model critic shares blind spots | §3.6, §8.5, §11.3 |
| 7 | Assume-breach security | 98% lethal-trifecta exploitable; 100% static-defense bypass; 11% pass security bar | §10 |
| 8 | Eval first-class | No major framework ships eval; 17% step-repeat + 14% reason/act mismatch invisible to output checks | §11.3 |
| 9 | Memory that works | 49% vs 91% on LongMemEval (retrieval quality gap); no published benchmarks | §6 |
| 10 | OSI license | ELv2 "is it open source?" HN controversy; procurement blocks | §1.5, §13 |

## 14.2 Production gaps → our answer

### Memory & data-layer gaps
| Production gap (sourced) | Eidentic answer |
|--------------------------|----------------|
| "Stack, not a layer" lock-in | §6.9 drop-in (`types`-only dep) |
| Last-writer-wins data loss in memory | §6.3 CAS + conflict policies |
| Archival "junk drawer", no dedup | §6.5 consolidation dedup/merge |
| No published memory benchmarks | §6.10 shipped LongMemEval/LoCoMo harness |
| Memory collapses on weak/local models | §6.8 passive-extraction path |
| App-layer tenant isolation | §6.7/§12.3 store-enforced scope isolation |
| SQLite can't migrate between versions | §12.5 versioned migrations both backends |
| Per-retrieval latency (LLM per lookup) | §6.4 async writes, hot-path retrieval only |

### Stability & DX gaps
| Production gap (sourced) | Eidentic answer |
|--------------------------|----------------|
| Breaking changes nearly every release | §13.2 strict semver, codemods, deprecation policy |
| Hidden observational-memory LLM costs | §6.5/§11.2 transparent `cost.background`, every call counted |
| Memory base64 "death spiral" | §4.4 type-checked offloading, never feed binary to summarizer |
| Suspend/resume bugs | §9 event-sourced checkpoints; resume/fork tested day-one |
| 90 MB serverless bundle | §2.3/§13.2 subpath exports, separate adapter packages |
| No free execution replay | §9.7/§11.1 replay + time-travel, free |
| ELv2 license controversy | §1.5 Apache-2.0 |
| Monorepo/workspace pain | §13.2 first-class workspace/path-alias support |
| Tool-loop flakiness | §3.7 repair + §3.4 per-tool caps + progress-gated retries |
| No data retention/GDPR | §6.6 TTL/staleness + §12 retention policy |

### Security & skill-lifecycle gaps
| Production gap (sourced) | Eidentic answer |
|--------------------------|----------------|
| Self-evolution doesn't persist | §7.7 versioned commit to Skill Bank |
| "Meta-cognition bill > work bill" | §7.7 cost-bounded, transparent evolution |
| Skill poisoning → persistent backdoor | §7.6/§10.6 quarantine + sign + capability scope + sandbox |
| SDK-first stable contract missing | §1.3/§3.8 SDK-first stable API |
| Tool-calling instability | §3.7 repair + §5.3 validation |
| 64K-context min, 1–2 tok/s overhead | §4 context efficiency; fast path §9.5 |
| Unauth RCE via sandboxed execution | §10.5 sandbox-by-default + §10.7 secure defaults |

## 14.3 Cross-cutting production problems → solution

| Problem (sourced) | Solution section |
|-------------------|------------------|
| Compounding step failure (95%/step → 60%/10-step) | §9 durable checkpoint/resume |
| Runaway cost ($47K, $500M) | §11.2 enforcement (not alerts) + progress-gated retries |
| "Can't tell why my agent did X" (27% of failures) | §11.1 OTel trace = event log, replay, <4 min RCA |
| Lethal trifecta (98% exploitable) | §10 five-layer defense + blast-radius containment |
| Multi-agent context isolation failure | §8.3 minimal explicit handoff |
| "Can't test my agent" | §11.3 trajectory eval + failure→regression |
| Memory degradation at scale | §6 four-tier, multi-signal, temporal, consolidation |
| Tool sprawl degrades models | §5.4 lazy discovery + ~20 atomic core |
| Anti-framework backlash ("ripped it out") | §2.1 thin composable layers; use one without the rest |
| Framework churn | §13.2 stability promise; §3.2 stable protocol contract |

## 14.4 Open questions — RESOLVED

All six original open questions are now decided after the second research round; see
[Section 0, part B](00-decisions.md#b-the-six-open-questions-§144--resolved):

1. Skill optimizer → integrate an **external prompt-optimization library** (opt-in, off by default); defer multi-objective Pareto optimization. (§7.7)
2. Reranker → **off in embedded `lite`** (RRF only); `RerankerPort` local/Cohere in `full`. (§6.0/§6.4)
3. Durable default → **in-house SQLite checkpoint/resume journal**; pluggable durable-execution adapters opt-in. (§9.6)
4. Memory controller → **interface-only**, LLM-heuristic default. (§6.11)
5. A2A → separate **`@eidentic/a2a`** package, shipped optional; AP2 deferred. (§8)
6. Server auth → **`AuthPort` + better-auth** default (all OSS); Stack Auth secondary. (§2.4)

## 14.5 Production-hardening (new sections 15–20)

The adversarial review surfaced gaps now covered by dedicated sections:

| Gap | Section |
|-----|---------|
| PII / GDPR erasure vs. complete-span storage | [§15](15-data-governance.md) |
| Hot-agent concurrency, abort rollback, backpressure | [§16](16-concurrency-cancellation.md) |
| Single `error` bucket → typed taxonomy | [§17](17-error-taxonomy.md) |
| "How is the SDK tested / adapters proven?" | [§18](18-testing-conformance.md) |
| Event-replay-on-new-code, embeddings re-index | [§19](19-schema-prompt-evolution.md) |
| Secrets interface, rate limits, quotas | [§20](20-secrets-rate-limiting.md) |

And the twelve design corrections (logit-masking removed, idempotency schema, memory-port
reconciliation, lite/full profiles, event-log projections, materialization honesty, sandbox
matrix, model-selection precedence, capability registry, atomic append, event versioning,
differentiation repositioning) are logged in [Section 0, part C](00-decisions.md#c-adversarial-review-fixes-design-changes-locked).

# @eidentic/bench — Published Baselines

---

## Methodology rules (read before publishing numbers)

These rules apply to any benchmark numbers published using this harness.

1. **Run on real models before publishing.** Harness-validation numbers (MockModel / InMemoryStore) prove the harness works correctly but say nothing about real LLM accuracy. Label them explicitly as "harness-validation" — never as accuracy numbers.

2. **Disclose extraction and judge model families.** Every published result must state which model family was used for fact extraction (the Consolidator) and, if an LLM judge was used for answer-correctness grading, which judge model was used.

3. **Full-context baseline comparison is required.** A memory system whose recall is compared to a full-context window baseline is a valid benchmark design; omitting the full-context comparison is not. Always include a full-context (retrieval-free) run as a reference point.

4. **Never publish competitor numbers from your own runs of their systems.** Configuration choices (chunking, TTLs, extraction prompts, embedding models) critically affect results, and you cannot guarantee fair configuration. Link to their own published numbers instead.

5. **Cost transparency triple required.** Every published result must include `(metric, llmCallsPerWrite, tokensUsedIfAny)`. Accuracy alone is not publishable — cost context is required to evaluate tradeoffs.

---

## Retrieval benchmark — synthetic dataset (CI)

The synthetic dataset (`syntheticDataset`) ships bundled and runs in CI without any real models or large files.

| Config          | recall@8 mean | Questions |
|-----------------|---------------|-----------|
| Semantic        | 1.00          | 9         |
| Lexical-only    | 1.00          | 9         |

**Semantic** = `InMemoryStore` + `InMemoryVectorStore` + `FakeEmbedder(dim=32)`, topK=8.
**Lexical-only** = `InMemoryStore` only, topK=8.

Both configs achieve perfect (1.0) recall on the synthetic dataset: gold facts are verbatim
substrings of ingested turns, so both lexical token-frequency scoring and FakeEmbedder's
bag-of-words vectors retrieve them with certainty.

**CI baseline thresholds** (set conservatively below measured perfect values):
- Semantic: `>= 0.85` (15pp below perfect)
- Lexical: `>= 0.80` (20pp below perfect, wider margin for tokenization sensitivity)

These thresholds are the "regression gate" promised in §6.10. The test `bench.test.ts` fails if
memory recall regresses below them.

### Dataset coverage

| Category         | Cases | Questions |
|------------------|-------|-----------|
| single-session   | 2     | 5         |
| multi-session    | 1     | 2         |
| temporal         | 1     | 1         |
| knowledge-update | 1     | 1         |

---

## Write-quality benchmark — harness-validation numbers

**What this measures:** the write side of memory — what gets stored, contradiction handling, and junk filtering. Retrieval-only benchmarks do not measure this.

**How to run:**
```bash
npx vitest run packages/bench/test/write-quality.test.ts
# or the infra-free example:
pnpm --filter eidentic-examples hello:bench-write
```

### Harness-validation numbers (deterministic, labeled)

These numbers are produced by the deterministic harness (no LLM, no network). They prove the harness works correctly and are reproducible on any machine.

| Metric                  | Value  | Notes                                          |
|-------------------------|--------|------------------------------------------------|
| contradictionAccuracy   | 1.00   | 5/5 fixtures: current fact wins, stale invalidated |
| junkRate                | 0.00   | 0/12 junk items stored (correctly suppressed) |
| factRecall              | 1.00   | 4/4 real facts stored and queryable           |
| duplicateRate           | 0.00   | 0/8 re-ingested texts created duplicates       |
| llmCallsPerWrite        | 0      | Deterministic harness, no model calls          |
| tokensUsedIfAny         | 0      | Deterministic harness, no tokens consumed      |

**Fixtures:** 5 contradiction pairs (employer, city, role, language × 2 subjects), 12 junk items (system-prompt × 3, tool-output × 3, transient-state × 3, agent-scratchpad × 3), 4 real user facts, 3 duplicate sessions.

**How contradiction suppression works:** Facts are asserted into the temporal knowledge graph via `assertFact`. When a newer fact for the same (subject, predicate) is asserted, the prior fact's `validUntil` is set to the new `validFrom` (invalidated). The score is the fraction of pairs where the current object is active and the stale object is in the `invalidated` list.

**How junk resistance works:** The Consolidator's REJECT gate prevents system-prompt content, tool outputs, transient state, and agent scratchpad from reaching `assertFact`. In the deterministic harness, junk items are classified and excluded before assertion, simulating correct Consolidator behavior. In a real-LLM run, the Consolidator's accuracy on this classification is what determines the real junkRate.

**How duplicate resistance works:** `Memory.ingest` with `dedupeOnWrite: true` (the default) suppresses exact-text duplicates within the same scope. The benchmark re-ingests the same events across M sessions and counts how many extra copies appear in the store.

---

## Temporal point-in-time benchmark — harness-validation numbers

**What this measures:** Whether a memory system can answer "what was X's `<property>` at `<date>`?" correctly, using timestamped fact validity (`validAt`). This benchmark is **only passable by systems with timestamped fact validity** (i.e. systems that record `validFrom` / `validUntil` on every fact). A system that stores facts without temporal intervals always returns the current value and will fail all mid-interval and before-first-fact questions.

**How to run:**
```bash
npx vitest run packages/bench/test/temporal.test.ts
# or the infra-free example:
pnpm --filter eidentic-examples hello:bench-write
```

### Harness-validation numbers (deterministic, seed=42, entities=4)

These numbers are produced by the deterministic harness (InMemoryStore + InMemoryGraph, no LLM).

| Metric                  | Value  | Questions | Notes                                             |
|-------------------------|--------|-----------|---------------------------------------------------|
| pointInTimeAccuracy     | 1.00   | 48        | before-first + at-boundary + mid-interval         |
| currentStateAccuracy    | 1.00   | 16        | latest state queries                              |
| beforeFirstFactAccuracy | 1.00   | 16        | askedAt before any known fact → null answer       |
| llmCallsPerWrite        | 0      | —         | Deterministic harness                             |
| tokensUsedIfAny         | 0      | —         | Deterministic harness                             |

**Question types:**
- `before-first-fact` (16): askedAt is before 2022-01-01 — no fact known yet → correct answer is null.
- `at-boundary` (16): askedAt equals the exact `validFrom` of a transition — the new value is correct.
- `mid-interval` (16): askedAt is between two transitions — the earlier value is still correct.
- `current-state` (16): askedAt is 30 days after the last transition — the latest value is correct.

**Dataset generation:** Deterministic seeded PRNG (xorshift32). Same seed always produces the same entities, timelines, and questions. `syntheticTemporalDataset({ seed, entityCount })` — see `src/datasets/temporal.ts`.

**Note on systems without temporal validity:** A retrieval-only system (no `validFrom`/`validUntil`) will score 1.0 on `currentStateAccuracy` (by accident — current value happens to be the most recent retrieved chunk) but close to 0 on `beforeFirstFactAccuracy` (cannot return null for "no fact at that date") and close to 0 on `mid-interval` queries (always returns the latest value instead of the historically-correct one). The benchmark's design makes this failure mode explicit and measurable.

---

## Real datasets (gated)

The real datasets are not bundled (large + license-bound). To run benchmarks against them:

### LongMemEval — fair-run harness

The LongMemEval harness (`runLongMemEvalBench`) is a full end-to-end benchmark with an LLM judge.
Source paper: Wu et al., "LongMemEval: Benchmarking Chat Assistants on Long-Term Interactive Memory"

#### License

MIT — results are publishable; **raw data must not be committed to this repository**.
Cite the dataset as: Wu et al., LongMemEval. https://github.com/xiaowu0162/LongMemEval

#### Manual download steps

```bash
# Install the HuggingFace Hub Python library
pip install huggingface_hub

# Inspect available files (the dataset uses extension-free filenames)
python3 -c "
from huggingface_hub import list_repo_tree
for f in list_repo_tree('xiaowu0162/longmemeval', repo_type='dataset'):
    print(f.path, getattr(f, 'size', ''))
"

# Download the standard _s split (~278 MiB, ~500 questions)
python3 -c "
from huggingface_hub import hf_hub_download
path = hf_hub_download(repo_id='xiaowu0162/longmemeval',
    filename='longmemeval_s', repo_type='dataset')
print('Downloaded to:', path)
"

# Copy to the gitignored data/ directory
mkdir -p data
cp <path_printed_above> data/longmemeval_s.json
```

HuggingFace repo: `xiaowu0162/longmemeval`
Snapshot SHA used when this harness was written: `2ec2a557f339b6c0369619b1ed5793734cc87533`

#### Run the gated integration test (verifies dataset stats)

```bash
EIDENTIC_TEST_LME=1 npx vitest run packages/bench/test/lme.test.ts
```

#### Run a pilot with real models

```bash
OPENAI_API_KEY=... pnpm --filter eidentic-examples bench:longmemeval -- \
  --mode full-context --questions 50 --out lme-report.json --md lme-report.md

# Memory mode (requires embedder)
OPENAI_API_KEY=... pnpm --filter eidentic-examples bench:longmemeval -- \
  --mode memory --questions 50 --topk 10 --out lme-memory-report.json
```

#### Fair-run rules (non-negotiable)

These rules are baked into the harness:

1. **Per-question memory scope.** Each question has its own haystack (~50 sessions average).
   A fresh Memory instance is created per question; no cross-question contamination.
2. **Dual-granularity ingest.** Per-turn entries carry the session date in text (temporally
   anchored). An additional session-level chunk preserves multi-turn context.
3. **Current date in prompt.** `question_date` is passed to the answer prompt so temporal
   questions can reason about recency.
4. **topK ≤ 10 in memory mode.** Larger topK trivialises retrieval quality.
5. **Full-context baseline is mandatory** alongside any memory-mode result.
   Haystacks exceeding the context cap (default 480k chars) truncate oldest sessions first;
   truncation is recorded per-question in the report.
6. **Strict judge.** Correct only when model answer contains the gold answer's specific
   information. Vague/topical-only = wrong. Equivalent date expressions for the same
   date/duration = correct (temporal-reasoning type).
7. **Abstention accuracy reported separately.** Not folded into overall accuracy.
8. **Data license.** MIT — raw JSON must not be committed; only results are publishable.

#### Dataset stats (actual counts from longmemeval_s.json — 500 questions total)

| Question type            | Count | Notes                                          |
|--------------------------|-------|------------------------------------------------|
| single-session-user      | 70    | Fact stated by the user in one session         |
| single-session-assistant | 56    | Fact stated by the assistant in one session    |
| single-session-preference| 30    | User preference expressed in one session       |
| multi-session            | 133   | Evidence spans multiple sessions               |
| temporal-reasoning       | 133   | Requires reasoning about time/dates            |
| knowledge-update         | 78    | Fact was updated in a later session            |
| **Total**                | **500** |                                              |

No abstention (`*_abs`) variants in the standard `longmemeval_s.json` split.
Average haystack: ~50 sessions per question, ~494 turns per question.

Dataset source: HuggingFace `xiaowu0162/longmemeval`, snapshot `2ec2a557f339b6c0369619b1ed5793734cc87533`.

#### Published results

_Pending official run. Run the pilot command above and record results here._

| System / Mode | Single-session (user) | Single-session (asst.) | Single-session (pref.) | Multi-session | Temporal reasoning | Knowledge update | Overall accuracy | Abstention accuracy | Answer model | Judge model | topK | n-Q | Seed |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| _(pending)_ | — | — | — | — | — | — | — | — | — | — | — | — | — |

---

### LoCoMo — fair-run harness

The LoCoMo harness (`runLocomoBench`) is a full end-to-end benchmark with an LLM judge.
It is stricter than a retrieval-only recall@K measure.

1. Download the dataset (CC BY-NC 4.0 — do **not** commit):
   ```bash
   mkdir -p data
   git clone --depth 1 https://github.com/snap-research/locomo /tmp/locomo-src
   cp /tmp/locomo-src/data/locomo10.json data/locomo10.json
   ```

2. Run the gated integration test (verifies dataset stats):
   ```bash
   EIDENTIC_TEST_LOCOMO=1 npx vitest run packages/bench/test/locomo.test.ts
   ```

3. Run a pilot with real models:
   ```bash
   ANTHROPIC_API_KEY=... pnpm --filter eidentic-examples bench:locomo -- \
     --mode full-context --samples 2 --out report.json --md report.md
   ```

#### Fair-run rules (non-negotiable)

These rules came from a public methodology dispute. They are baked into the harness:

1. **Both speakers are human.** Turns ingested as `[SpeakerName]: text`, never as user/assistant roles.
2. **Timestamps are structural.** Session headers (`Session N — <date>`) + `ingestedAt` metadata.
3. **topK ≤ 10 in memory mode.** Larger topK trivialises retrieval quality.
4. **Full-context baseline is mandatory** alongside any memory-mode result.
5. **Strict judge.** Correct only when model answer contains the gold answer's specific information. Vague/topical-only = wrong. Equivalent date expressions for the same date = correct.
6. **Category 5 (adversarial).** Correct = model declined; adversarial trap match = wrong.
7. **Primary metric J(1–4).** Denominator = cat 1–4 questions actually run (max 1540 on full dataset). Category 5 refusal rate reported separately.
8. **Data license.** CC BY-NC 4.0 — raw JSON must not be committed; only results are publishable.

#### Dataset stats (actual counts from locomo10.json)

| Category | Count | Semantic label |
|----------|-------|----------------|
| 1        | 282   | multi-hop      |
| 2        | 321   | temporal       |
| 3        | 96    | open-domain    |
| 4        | 841   | single-hop     |
| 5        | 446   | adversarial    |
| **Total**| **1986** |              |
| **Cat 1–4** | **1540** | (primary denominator) |

Dataset source SHA: `3eb6f2c585f5e1699204e3c3bdf7adc5c28cb376` (snap-research/locomo, depth-1 clone).

#### Published results (first official run, 2026-06-10)

| System / Mode | Cat1 (multi-hop) | Cat2 (temporal) | Cat3 (open-domain) | Cat4 (single-hop) | J(1–4) | Cat5 refusal | Answer model | Judge model | Embedder | topK | n-Q | Seed |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| full-context | 46.8% (132/282) | 31.2% (100/321) | 28.1% (27/96) | 81.9% (689/841) | **61.6%** (948/1540) | 69.5% (310/446) | gpt-4o-mini | gpt-4o-mini | — | — | 1,986 | 42 |
| memory | 30.5% (86/282) | 43.3% (139/321) | 28.1% (27/96) | 68.5% (576/841) | **53.8%** (828/1540) | 85.2% (380/446) | gpt-4o-mini | gpt-4o-mini | text-embedding-3-small | 10 | 1,986 | 42 |

Tokens per query: full-context 19,030 · memory 893 (95.3% reduction). Memory-mode totals:
1.73M input / 42k output tokens across all 1,986 questions (answer + judge phases). Zero
per-question errors in either run. Single run per mode; variance across seeds not yet
characterized. Interpretation and caveats: see `docs/BENCHMARKS.md`.

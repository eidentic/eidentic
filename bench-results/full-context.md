# LoCoMo Benchmark Results

Dataset: [LoCoMo](https://github.com/snap-research/locomo) (Snap Research) · CC BY-NC 4.0
Raw data is not redistributed. Only aggregate results are published here.

## Results

| System / Mode | Cat1 (multi-hop) | Cat2 (temporal) | Cat3 (open-domain) | Cat4 (single-hop) | J(1–4) overall | Cat5 refusal rate | Tokens/query | Est. cost/run | Answer model | Judge model | topK | n-Q | Seed | Dataset SHA |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| gpt-4o-mini / full-context | 46.8% (132/282) | 31.2% (100/321) | 28.1% (27/96) | 81.9% (689/841) | 61.6% (948/1540) | 69.5% (310/446) | 19,030 | — | gpt-4o-mini | gpt-4o-mini | 10 | 1,986 | 42 | 3eb6f2c5 |

## Run Configuration

### gpt-4o-mini / full-context

- **Mode**: full-context
- **Answer model**: gpt-4o-mini
- **Judge model**: gpt-4o-mini
- **topK**: 10
- **Dataset SHA**: `3eb6f2c585f5e1699204e3c3bdf7adc5c28cb376`
- **Seed**: 42
- **Categories**: 1, 2, 3, 4, 5
- **Samples run**: 10
- **Questions run**: 1986
- **Wall-clock**: 2426.3s
- **Errors**: 0
- **Tokens** (in/out): 37,742,611 / 50,098

## Methodology Notes

These results were produced using the Eidentic LoCoMo fair-run harness. The following rules apply:

1. **Both speakers are treated as humans.** Turns are ingested as `[SpeakerName]: text` — never mapped to user/assistant roles.
2. **Timestamps are structural.** Each session is prefixed with a header line `Session N — <date>` and `ingestedAt` metadata carries the epoch-ms.
3. **topK ≤ 10 in memory mode.** Larger topK values trivialise retrieval quality and are not permitted.
4. **Full-context baseline is required** alongside any memory-mode result.
5. **Judge is strict**: a model answer is correct only when it contains the gold answer's specific information. Vague/topical-only answers are wrong.
6. **Category 5 (adversarial)**: correct = model declined; adversarial-trap match = wrong.
7. **Primary metric J(1–4)**: denominator is the number of cat 1–4 questions actually run (max 1540 on full dataset).
8. **Dataset license**: CC BY-NC 4.0 — raw data is not redistributed; only aggregate results are published.

> Category mapping in locomo10.json: 1=multi-hop (282), 2=temporal (321), 3=open-domain (96), 4=single-hop (841), 5=adversarial (446).

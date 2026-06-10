---
"@eidentic/memory": minor
---

Memory `retrieve()`: optional recency-weighted ranking. Add `MemoryOptions.recency: { halfLifeMs, weight? }` to blend similarity with an exponential age-decay term (`score = (1-weight)*normSimilarity + weight*exp(-ln2*ageMs/halfLifeMs)`). OFF by default — existing behavior is unchanged when `recency` is omitted. Injectable `now` clock for deterministic tests.

---
"@eidentic/workflow": patch
---

`chain()` now uses a single recursive variadic-tuple type signature instead of the 7 hardcoded overloads (2–8 steps). Inference flows through chains of **any length** — `chain(s1, …, sN)` infers `Step<FirstInput, LastOutput>` exactly (no `unknown` collapse, no 8-step cap; verified up to 48 steps). Step adjacency is checked at compile time: if a step's output type isn't assignable to the next step's input, it's a type error positioned at the offending argument. The runtime is unchanged (the impl already looped over all steps). Type-only and backward compatible — anything that compiled before still compiles; more now compiles with better types.

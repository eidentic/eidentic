---
"@eidentic/postgres": patch
---

`PostgresStore.searchMemory` no longer throws on all-stop-word queries. It used
`to_tsquery`, which raises a syntax error when the English dictionary strips every token
(e.g. "at the"). Switched to `websearch_to_tsquery` (OR-joined tokens), which yields an
empty tsquery — matching nothing — instead of erroring.

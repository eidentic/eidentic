---
"@eidentic/types": minor
"@eidentic/core": minor
"@eidentic/cli": minor
"eidentic": minor
---

Add contextual, least-privilege tool secret capabilities with required-value access and strict
declaration validation. Resolved values are now sanitized before tool output, errors, hooks,
durable state, events, or model context can observe them. Directory projects automatically wire an
environment-backed capability from tool declarations, and `eidentic doctor` reports missing secret
names without printing values.

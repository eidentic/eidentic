---
"@eidentic/core": minor
"@eidentic/types": minor
"eidentic": minor
---

Add production ergonomics for multi-tenant SDK users:

- `Agent.query()` and `Agent.resume()` now accept `principal` separately from `memoryScope`, so session ownership/permissions can differ from the memory/tool scope used by a run.
- `Agent.query()` accepts `guardrailInput` for checking untrusted user text separately from a composed operator prompt.
- Guardrail results can include machine-readable `code` and `severity`, and terminal guardrail events surface them through `result.details`.
- Structured output parse/validation failures now include `result.details.errorKind`, `validationIssues`, and `rawOutput`.
- Add `eidenticGuardrails.pii()`, `policies.*` cost-policy presets, `permissions.*` permission presets, `scopes.*` constructors, and `Agent.eraseScopes()`.

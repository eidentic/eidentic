---
"@eidentic/a2a": patch
"@eidentic/cli": patch
"@eidentic/model": patch
"@eidentic/server": patch
"@eidentic/studio": patch
"@eidentic/tools": patch
"eidentic": patch
"create-eidentic": patch
---

Harden the SDK security posture.

Dependency updates remove known vulnerable transitive ranges and CI now runs a low-threshold audit gate. Server and Studio reject accidental `NoAuth` usage in production unless explicitly opted in with `EIDENTIC_ALLOW_NO_AUTH=1`. The sealed `web_fetch` tool now resolves allowlisted hostnames before fetch and rejects private, loopback, and link-local targets to reduce DNS rebinding SSRF risk. Studio auth token handoff now prefers URL fragments so bearer tokens are not sent in HTTP requests, while preserving legacy query-token support.

---
"@eidentic/a2a": minor
"@eidentic/mcp": minor
"@eidentic/nextjs": minor
"@eidentic/react": minor
"@eidentic/studio": minor
"@eidentic/server": patch
---

Harden integration boundaries across A2A, MCP, Next.js, React, and Studio. The
changes add fail-closed identity and authorization handling, bounded and
cancellable A2A I/O, strict JSON request and stream validation, append-only
regeneration safety, separate Studio run/admin authentication, credential
redaction, and explicit Node listener hostname support while preserving drain
semantics.

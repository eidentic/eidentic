---
"@eidentic/server": patch
---

Fix: `toUIMessageStream` / `toUIMessageStreamResponse` no longer duplicates a streamed assistant
message. When a turn streamed token-by-token (`stream.delta` events), the turn-final `assistant`
event carries the same accumulated text — it was being re-emitted as a second `text-start` /
`text-delta` / `text-end` block, so `useChat` rendered the reply twice. The converter now skips the
`assistant` text blocks for a turn that already streamed (and still emits them for non-streamed
turns, e.g. non-streaming model adapters). Fixes the double reply seen via `@eidentic/nextjs` + `useChat`.

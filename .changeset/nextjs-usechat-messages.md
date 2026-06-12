---
"@eidentic/nextjs": patch
---

`withEidentic` now accepts a Vercel `useChat` `{ messages: [...] }` request body, so the route works
with `useChat` out of the box on BOTH sides (it already emitted the UI-message stream `useChat`
consumes; it now also reads the request `useChat` sends). Previously it only read a plain
`input`/`message` string, so `useChat`'s default POST required a client-side `prepareSendMessagesRequest`
bridge. The newest user message's text is extracted (both the AI SDK v5+ `parts` array and the legacy
`content` string are supported); the agent reloads prior turns from the store via `sessionId`, so the
full history isn't replayed.

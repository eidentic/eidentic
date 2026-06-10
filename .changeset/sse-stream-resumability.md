---
"@eidentic/server": minor
---

SSE stream resumability: every streamed event now carries an `id:` field whose value is the corresponding `StoredEvent.seq`. Clients that disconnect mid-run can reconnect by sending the standard `Last-Event-ID` header — the server replays all durable events with seq > N and, for completed sessions, synthesizes a final `result` event without restarting the agent. The same ownership gate enforced on initial connections applies to reconnects. The default path (no `Last-Event-ID`) is byte-compatible with prior behaviour.

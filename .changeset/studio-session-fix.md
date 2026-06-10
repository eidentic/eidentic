---
"@eidentic/studio": patch
---

Fix: the Studio Run console now keeps a STABLE session id across messages in a conversation (it previously sent no sessionId, so each message started a fresh session and the agent had no memory of prior turns). Adds a "New session" action and shows the session id; conversation history now persists across turns as expected.

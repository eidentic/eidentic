---
"eidentic": patch
---

Update the package description and README hero to the new positioning sentence, and fix the
quickstart stream-event check (`ev.type === "stream.delta"` → `ev.delta.text`, terminal
`ev.type === "result"`).

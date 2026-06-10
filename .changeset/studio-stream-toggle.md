---
"@eidentic/studio": patch
---

Studio Run console now renders the model output token-by-token (consumes `stream.delta` events live) with a "Stream tokens" toggle and a blinking cursor; the toggle off-state shows the final message in one block. Also surfaces the terminal `subtype` on the done line.

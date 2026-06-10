---
"@eidentic/model": minor
---

`AIModel` now accepts generation settings as an optional second constructor argument —
`new AIModel(model, { temperature, maxOutputTokens, topP, topK, stopSequences, seed,
presencePenalty, frequencyPenalty, maxRetries, providerOptions, headers })`. They are
forwarded to every `generateText`/`streamText` call. Backward compatible: the single-arg
form sends no settings (provider defaults).

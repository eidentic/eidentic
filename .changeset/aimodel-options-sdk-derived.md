---
"@eidentic/model": patch
---

`AIModelOptions` is now derived from the AI SDK's `generateText` parameters via
`Pick<Parameters<typeof generateText>[0], …>` instead of being hand-typed. Every exposed
setting name (temperature, maxOutputTokens, topP, …) must exist on the installed SDK or it
is a compile error — eliminating any chance of a renamed/removed setting being silently
ignored at runtime. Public shape is unchanged.

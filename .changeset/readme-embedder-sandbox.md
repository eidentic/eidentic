---
"@eidentic/model": patch
"@eidentic/e2b": patch
---

Docs fix: correct the README code examples to the real (async factory) API.

- `@eidentic/model`: `new AIEmbedder(model, { dim })` → `await AIEmbedder.create(model)`. The
  constructor is private and the embedding dimension is probed automatically — the old example did
  not compile.
- `@eidentic/e2b`: `E2BSandbox.create(...)` → `await E2BSandbox.create(...)` (it returns a Promise).

---
"@eidentic/cli": minor
---

Add the `eidentic` CLI (`eidentic dev` + `eidentic doctor`) with jiti-powered TypeScript config loading (no build step). `doctor` checks Node version, model-provider env key, and config file presence. `dev` loads `eidentic.config.{ts,js,mjs}`, builds a Eidentic server, and serves it with `@hono/node-server`.

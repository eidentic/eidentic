---
"create-eidentic": minor
---

Add `nextjs-chat` template to the `create-eidentic` scaffolder.

Running `npm create eidentic@latest` (or `npm create eidentic@latest my-app --template nextjs-chat`) now offers a second template choice alongside the existing bare Node script default.

**What is generated:**
- `app/api/chat/route.ts` — Eidentic agent (AIModel + LibsqlStore) wrapped with `withEidentic` from `@eidentic/nextjs`. Uses the default `"ai-sdk-ui"` protocol + `export const runtime = "nodejs"`.
- `app/page.tsx` — minimal streaming chat UI using `useChat` from `@ai-sdk/react`. Protocol and hook are consistent: `withEidentic` default is `"ai-sdk-ui"`, `useChat` speaks that protocol natively.
- `next.config.ts` — uses `eidenticNextConfig()` to prevent native-addon bundling errors.
- `.env.local.example` — provider API key placeholder.
- `package.json` — correct deps: `eidentic`, `@eidentic/nextjs`, `@eidentic/libsql`, `@ai-sdk/react`, `ai`, `next`, `react`, `react-dom`, plus the chosen provider package.
- `tsconfig.json`, `README.md`, `.gitignore`.

The existing default (bare Node script) template is unchanged. Template selection is exposed as an interactive wizard prompt and via a `--template` CLI flag.

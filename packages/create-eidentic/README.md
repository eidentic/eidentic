# create-eidentic

Scaffold a new Eidentic agent project with a single command — choose your model provider
and project template, then get a ready-to-run TypeScript project with an agent, store,
and dev configuration wired up.

## Usage

```bash
npm create eidentic@latest my-agent
# or
npx create-eidentic my-agent
```

Follow the interactive prompts to choose:

- **Provider:** anthropic | openai | google | deepseek | mistral
- **Template:**
  - `default` — directory-first local agent with instructions, runtime config, and an example tool
  - `nextjs-chat` — Next.js App Router chat UI with `@eidentic/nextjs` + `useChat`
  - `bun-agent` — Bun-native agent script with `@eidentic/sqlite`

### Non-interactive

```bash
npm create eidentic@latest my-agent -- --provider anthropic --template nextjs-chat
```

### After scaffolding

```bash
cd my-agent
pnpm install
# Set your API key, e.g.:
export ANTHROPIC_API_KEY=sk-ant-...
pnpm dev
```

## Links

- [GitHub](https://github.com/eidentic/eidentic)
- [Issue tracker](https://github.com/eidentic/eidentic/issues)
- [Root README](https://github.com/eidentic/eidentic#readme)

Apache-2.0

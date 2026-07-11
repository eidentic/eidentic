# @eidentic/cli

The eidentic command-line tool — dev server with live-reload, `eidentic init` project
scaffold, `eidentic add component` UI component installer, `eidentic studio` local
dashboard launcher, and `eidentic doctor` health diagnostics. Bundled into the
`eidentic` umbrella package; also installable standalone.

## Install

```bash
npm install -g @eidentic/cli
# or use via the umbrella (eidentic ships the CLI)
npm install eidentic
```

## Usage

```bash
# Scaffold a new project
eidentic init

# Start the localhost-only dev server, interactive chat, and live reload
eidentic dev

# Open the local Studio dashboard
eidentic studio

# Add a built-in React component to your project
eidentic add component chat
eidentic add component run-status
eidentic add component workflow-trace

# Health check
eidentic doctor
```

The default scaffold is intentionally readable:

```text
agent/
  instructions.md
  agent.ts
  tools/get-time.ts
```

`instructions.md` owns the prompt, `agent.ts` selects the model and store, and each
module in `tools/` default-exports one Eidentic tool. Existing projects remain supported:

### Legacy `eidentic.config.ts` example

```ts
// eidentic.config.ts — export `agents` (and optionally `port`, `auth`, etc.)
// The CLI picks this up with jiti (no compile step needed).
export const agents = { support: myAgent };
export const port = 3000;
```

## Links

- [GitHub](https://github.com/eidentic/eidentic)
- [Issue tracker](https://github.com/eidentic/eidentic/issues)
- [Root README](https://github.com/eidentic/eidentic#readme)

Apache-2.0

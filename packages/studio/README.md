# @eidentic/studio

Local dev studio for Eidentic — inspect agent sessions, memory blocks, knowledge graph
facts, skill banks, and workflow run history via a built-in web dashboard. Designed as a
local development tool; not intended for production exposure without authentication.

## Install

```bash
pnpm add @eidentic/studio
```

Or run it without installing via the CLI:

```bash
eidentic studio
```

## Usage

```ts
import { createStudio, serveNode } from "@eidentic/studio";

const studio = createStudio({
  agents: { support: myAgent },
  // auth: ApiKeyAuth({ "dev-key": { userId: "dev" } }), // optional
});

await serveNode(studio, { port: 4000 });
// Open http://localhost:4000 in your browser
```

The Studio dashboard provides:

- **Sessions** — browse event streams for past and live sessions
- **Memory** — view and edit memory blocks and knowledge graph facts per scope
- **Skills** — list and approve skill bank entries
- **Workflows** — inspect step traces and outcomes of workflow runs
- **Costs** — per-session token usage and USD cost breakdown

## Links

- [GitHub](https://github.com/eidentic/eidentic)
- [Issue tracker](https://github.com/eidentic/eidentic/issues)
- [Root README](https://github.com/eidentic/eidentic#readme)

Apache-2.0

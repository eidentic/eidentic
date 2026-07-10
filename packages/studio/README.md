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
import { serveStudio, ApiKeyAuth } from "@eidentic/studio";

await serveStudio({
  agents: { support: myAgent },
  // Required before binding Studio beyond loopback:
  // adminAuth: ApiKeyAuth({ "dev-key": { userId: "studio-admin" } }),
});
// Safe default: http://127.0.0.1:3535
```

`serveStudio` binds to `127.0.0.1` by default. A non-loopback hostname requires `adminAuth` (or the
explicitly unsafe `allowRemoteNoAuth: true` migration flag). Use `authorizeAdmin` when only a subset
of authenticated principals may inspect or mutate Studio data. Management responses redact
credential fields, bearer/basic values, URL userinfo, and sensitive URL query parameters. `adminAuth`
does not grant agent run access, and `auth` never grants Studio admin access by default. Configure
both when `/v1` run routes and the management API must be networked. The deprecated
`allowRunAuthAsAdmin: true` option exists only to migrate legacy shared credentials.

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

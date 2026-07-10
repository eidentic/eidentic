# @eidentic/a2a

Agent-to-Agent (A2A) protocol interoperability for Eidentic — expose a Eidentic agent as
an A2A endpoint (Hono routes serving `.well-known/agent-card.json` and JSON-RPC), or
consume a remote A2A agent as a first-class Eidentic tool. Implements the A2A v0.3
specification.

## Install

```bash
pnpm add @eidentic/a2a
```

## Usage

### Expose an agent as an A2A server

```ts
import { a2aRoutes } from "@eidentic/a2a";
import { Hono } from "hono";

const app = new Hono();

app.route("/", a2aRoutes({
  agent: myAgent,
  card: {
    name: "Support Agent",
    description: "Handles customer support queries.",
    version: "1.0.0",
  },
  auth: {
    verify: async (req) => verifyBearer(req.headers.get("authorization")),
  },
  maxBodyBytes: 1_048_576,
  maxTextBytes: 262_144,
  maxParts: 128,
  maxOutputBytes: 1_048_576,
  maxRunMs: 60_000,
  maxConcurrentRuns: 32,
}));
```

Return a stable verified principal object when possible (`{ id, userId, orgId }`). A verifier that
returns a raw credential string remains supported, but the server hashes it to an opaque identity
and never forwards the credential into `Agent.query`. The legacy raw behavior requires the explicit
`allowRawCredentialIdentity: true` compatibility flag.

The JSON-RPC endpoint is fail-closed when `auth` is omitted; the discovery card remains public.
`unsafeAllowUnauthenticated: true` restores the old open endpoint only for a controlled migration.
Agent runs receive an abort signal and are bounded by concurrent-run, wall-clock, and output-byte
limits. Oversized results are neither stored nor returned.

Server request limits are enforced on streamed UTF-8 bytes, not only `Content-Length`. The HTTP
client applies a 30-second overall timeout and a 1 MiB decompressed response cap by default; both
are configurable, and per-call `AbortSignal` values are propagated from tool execution:

```ts
const remote = httpA2ATransport("https://agent.example", {
  timeoutMs: 15_000,
  maxResponseBytes: 512_000,
  headers: { Authorization: `Bearer ${token}` },
});
```

### Call a remote A2A agent as a Eidentic tool

```ts
import { a2aTool, httpA2ATransport } from "@eidentic/a2a";

const remoteTool = a2aTool(httpA2ATransport("https://agent.example.com"), {
  id: "remote_support",
  description: "Delegates to the remote support agent.",
});

const agent = new Agent({ id: "orchestrator", model, store, tools: [remoteTool] });
```

## Links

- [GitHub](https://github.com/eidentic/eidentic)
- [Issue tracker](https://github.com/eidentic/eidentic/issues)
- [Root README](https://github.com/eidentic/eidentic#readme)

Apache-2.0

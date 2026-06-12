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
}));
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

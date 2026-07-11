# @eidentic/e2b

E2B Firecracker sandbox adapter for Eidentic — implements `SandboxPort` by running
untrusted code in isolated E2B microVMs. Creates a fresh sandbox per `run()` call and
always tears it down afterward. Pass it to `Agent` for sandboxed code execution with a
hard isolation boundary.

## Install

```bash
pnpm add @eidentic/e2b @e2b/code-interpreter
```

## Usage

```ts
import { E2BSandbox } from "@eidentic/e2b";
import { Sandbox } from "@e2b/code-interpreter";
import { Agent } from "eidentic";

const sandbox = await E2BSandbox.create({
  client: Sandbox,
  apiKey: process.env.E2B_API_KEY,
  defaultTimeoutMs: 10_000, // optional; defaults to 60 seconds
  maxOutputBytes: 512 * 1024, // per stdout/stderr/error field
});

const agent = new Agent({
  id: "coder",
  instructions: "Run requested code only in the configured sandbox.",
  model,
  store,
  sandbox,
});

// The agent can now execute code safely inside E2B microVMs
for await (const ev of agent.query("Run: print(1 + 1)", { sessionId: "s-1" })) {
  if (ev.type === "stream.delta") process.stdout.write(ev.delta.text);
}
```

Abort signals are honored during both provisioning and execution. If an abort wins while E2B is
still creating the microVM, the late handle is killed as soon as it arrives. Returned stdout,
stderr, and execution-error text are independently capped by `maxOutputBytes`.
Large line arrays are accumulated only up to that cap rather than joined into an unbounded string.

## Links

- [GitHub](https://github.com/eidentic/eidentic)
- [Issue tracker](https://github.com/eidentic/eidentic/issues)
- [Root README](https://github.com/eidentic/eidentic#readme)

Apache-2.0

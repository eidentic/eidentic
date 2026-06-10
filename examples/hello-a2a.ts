/**
 * A2A (Agent-to-Agent) interop demo — infrastructure-free.
 *
 * Shows both sides of @eidentic/a2a:
 *   SERVER: expose Agent A via a2aRoutes (Hono routes, no real HTTP server needed)
 *   CLIENT: consume Agent A as a Eidentic Tool on Agent B via a2aTool
 *
 * The in-process A2ATransport routes requests directly to Hono's app.request(),
 * so no network is involved — same pattern as @eidentic/mcp's in-process fake.
 *
 * Run:  pnpm hello:a2a
 */
import { a2aRoutes, a2aTool, type A2ATransport, type AgentLike } from "@eidentic/a2a";

// ---------------------------------------------------------------------------
// 1. Define Agent A — an answer generator exposed via A2A
// ---------------------------------------------------------------------------

/**
 * Minimal AgentLike: async generator that yields a terminal result event.
 * In production, pass a real @eidentic/core Agent instance.
 */
const agentA: AgentLike = {
  async *query(input: string, opts?: { sessionId?: string }) {
    // Simulate reasoning + produce a single result
    const sessionNote = opts?.sessionId ? ` [session: ${opts.sessionId}]` : "";
    yield {
      kind: "result",
      output: `Agent A received: "${input}" — responding with: The answer is always context-dependent.${sessionNote}`,
    };
  },
};

// ---------------------------------------------------------------------------
// 2. Expose Agent A as an A2A endpoint (Hono routes — no real HTTP server)
// ---------------------------------------------------------------------------

const appA = a2aRoutes({
  card: {
    name: "Agent A",
    description: "A Eidentic agent exposed via the A2A protocol.",
    url: "http://localhost:3100",
    version: "1.0.0",
    skills: [
      {
        id: "answer",
        name: "Answer",
        description: "Answer questions with context-aware reasoning.",
      },
    ],
  },
  agent: agentA,
});

// ---------------------------------------------------------------------------
// 3. Fetch and print Agent A's card (in-process)
// ---------------------------------------------------------------------------

async function getCard() {
  const res = await appA.request("/.well-known/agent-card.json");
  return res.json();
}

// ---------------------------------------------------------------------------
// 4. Build an in-process A2ATransport (no network — routes via app.request)
// ---------------------------------------------------------------------------

const inProcessTransport: A2ATransport = {
  async send(method, params) {
    const res = await appA.request("/", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: Date.now(), method, params }),
    });
    return res.json();
  },
};

// ---------------------------------------------------------------------------
// 5. Wrap Agent A as a Eidentic Tool on Agent B's side
// ---------------------------------------------------------------------------

const delegateTool = a2aTool(inProcessTransport, {
  id: "delegate_to_agent_a",
  description: "Delegate a question to Agent A via the A2A protocol.",
  sessionId: "session_demo_42",
});

// ---------------------------------------------------------------------------
// 6. Run the demo
// ---------------------------------------------------------------------------

async function main() {
  console.log("=== Agent A: card ===");
  const card = await getCard();
  console.log(JSON.stringify(card, null, 2));

  console.log("\n=== Agent B delegates to Agent A via a2aTool ===");
  const result = await delegateTool.execute({ message: "What is the meaning of life?" });
  console.log("Delegated result:", result);

  console.log("\n=== Direct message/send via A2A JSON-RPC ===");
  const rpcResult = await inProcessTransport.send("message/send", {
    message: {
      kind: "message",
      messageId: "msg_demo_1",
      role: "user",
      contextId: "ctx_demo",
      parts: [{ kind: "text", text: "Explain A2A in one sentence." }],
    },
  });
  const envelope = rpcResult as { result: { kind: string; status: { state: string }; history: Array<{ parts: Array<{ text: string }> }> } };
  console.log("Task kind:", envelope.result.kind);
  console.log("Task state:", envelope.result.status.state);
  console.log("Agent reply:", envelope.result.history[0]?.parts[0]?.text);

  console.log("\nDone.");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

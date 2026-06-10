/**
 * hello-embedded.ts — embed Eidentic directly in your OWN backend (no @eidentic/server).
 *
 * Eidentic is a library first: you `import { Agent } from "eidentic"` and call `agent.query()`
 * inside any Node/Bun/Deno/Worker request handler — a Next.js route, an Express handler, a
 * plain node:http server, etc. The agent runs server-side (it holds your model API key); your
 * frontend just calls your endpoint. No separate Eidentic process is required.
 *
 * This demo stands up a plain node:http server whose POST /chat streams the agent's events as
 * NDJSON, then fires one in-process request against it and prints the stream — all infra-free
 * (MockModel + in-memory SQLite), so it runs to completion with no API key.
 *
 * Run: tsx examples/hello-embedded.ts
 */
import { createServer } from "node:http";
import { AddressInfo } from "node:net";
import { Agent, SqliteStore, createTool } from "eidentic";
import { MockModel } from "@eidentic/types/testing";
import { toolUseBlock, textBlock } from "eidentic";
import { z } from "zod";

// --- your agent, constructed once (stateless to serve; state lives in the store) ----------
const weather = createTool({
  id: "get_weather",
  description: "Get the current weather for a city.",
  inputSchema: z.object({ city: z.string() }),
  execute: async ({ input }) => ({ city: input.city, tempC: 18, sky: "clear" }),
});

const store = new SqliteStore(":memory:"); // real store; ":memory:" keeps the demo file-free
await store.migrate();

const agent = new Agent({
  id: "support",
  instructions: "You are a concise assistant. Use tools when relevant, then answer.",
  // Swap for a real provider: new AIModel(anthropic("claude-sonnet-4-5"))
  model: new MockModel([
    { content: [toolUseBlock("c1", "get_weather", { city: "Istanbul" })], usage: { inputTokens: 6, outputTokens: 3 } },
    { content: [textBlock("It's 18°C and clear in Istanbul.")], usage: { inputTokens: 8, outputTokens: 9 } },
  ]),
  tools: [weather],
  store,
});

// --- embed it in a request handler: stream the run as NDJSON --------------------------------
const server = createServer((req, res) => {
  if (req.method !== "POST" || req.url !== "/chat") {
    res.writeHead(404).end();
    return;
  }
  let body = "";
  req.on("data", (c) => (body += c));
  req.on("end", async () => {
    const { message, sessionId } = JSON.parse(body || "{}");
    res.writeHead(200, { "content-type": "application/x-ndjson" });
    // A client disconnect aborts the run (§16.4): abort only if the response closes before we finish.
    const controller = new AbortController();
    res.on("close", () => {
      if (!res.writableEnded) controller.abort();
    });
    for await (const ev of agent.query(message, { sessionId: sessionId ?? "session-1", signal: controller.signal })) {
      res.write(JSON.stringify(ev) + "\n");
    }
    res.end();
  });
});

// --- demo: start, fire one request, print the stream, shut down -----------------------------
await new Promise<void>((resolve) => server.listen(0, resolve));
const { port } = server.address() as AddressInfo;

const resp = await fetch(`http://127.0.0.1:${port}/chat`, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ message: "What's the weather in Istanbul?", sessionId: "demo" }),
});

const reader = resp.body!.getReader();
const decoder = new TextDecoder();
let buf = "";
for (;;) {
  const { value, done } = await reader.read();
  if (done) break;
  buf += decoder.decode(value, { stream: true });
  const lines = buf.split("\n");
  buf = lines.pop() ?? "";
  for (const line of lines) {
    if (!line.trim()) continue;
    const ev = JSON.parse(line);
    if (ev.type === "result") console.log("RESULT:", ev.output);
    else console.log("event:", ev.type);
  }
}

server.close();

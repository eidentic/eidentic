/**
 * hello-chat-ui.ts — illustrative demo of the AI SDK UI integration path.
 *
 * This file shows the two pieces that make a Eidentic-powered chat UI work:
 *
 *   1. Backend route  — withEidentic(agent) emits the AI SDK UI wire format
 *   2. Client hook    — useChat from @ai-sdk/react points straight at it
 *
 * The backend part is exercised here via app.request() (no real socket needed),
 * the same pattern used in hello-server.ts.  The client code is shown as
 * TypeScript source snippets — it lives in a Next.js App Router project.
 *
 * Run:
 *   pnpm --filter eidentic-examples tsx hello-chat-ui.ts
 */

// ---------------------------------------------------------------------------
// Backend — simulate withEidentic + MockModel
// ---------------------------------------------------------------------------
//
// In a real Next.js project this lives in app/api/chat/route.ts:
//
//   import { withEidentic } from "@eidentic/nextjs";
//   import { agent } from "@/lib/agent";
//
//   export const runtime = "nodejs";          // required
//   export const POST = withEidentic(agent);   // protocol defaults to "ai-sdk-ui"
//
// withEidentic:
//   - reads { message, sessionId, userId? } from the JSON body
//   - calls agent.query() and streams the result
//   - default protocol "ai-sdk-ui" is compatible with useChat from @ai-sdk/react
//     and the broader AI SDK UI component ecosystem
//
// ---------------------------------------------------------------------------

import { Agent } from "@eidentic/core";
import { MockModel, InMemoryStore } from "@eidentic/types/testing";
import { toUIMessageStreamResponse } from "@eidentic/server";

const store = new InMemoryStore();
const model = new MockModel([
  {
    content: [{ type: "text", text: "Hi! How can I help you today?" }],
    usage: { inputTokens: 10, outputTokens: 9 },
  },
]);

const agent = new Agent({
  id: "chat",
  instructions: "You are a helpful assistant.",
  model,
  store,
});

// Replicate what withEidentic does internally for the "ai-sdk-ui" protocol.
async function handleChatRoute(req: Request): Promise<Response> {
  const body = (await req.json()) as { message?: string; input?: string; sessionId?: string };
  const input = body.message ?? body.input ?? "";
  const sessionId = body.sessionId ?? crypto.randomUUID();
  return toUIMessageStreamResponse(agent.query(input, { sessionId }));
}

// ---------------------------------------------------------------------------
// Drive the route in-process (no real HTTP socket needed)
// ---------------------------------------------------------------------------

console.log("--- Sending a chat message (AI SDK UI protocol) ---");

const req = new Request("http://localhost/api/chat", {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ message: "Hello!", sessionId: "demo-session" }),
});

const res = await handleChatRoute(req);

console.log("Status:", res.status);
console.log("Content-Type:", res.headers.get("content-type"));

const raw = await res.text();
console.log("\n--- Raw AI SDK UI stream ---");
console.log(raw.slice(0, 500), raw.length > 500 ? "\n…(truncated)" : "");

// ---------------------------------------------------------------------------
// Client — useChat (Next.js App Router, app/page.tsx)
// ---------------------------------------------------------------------------
//
// In a real Next.js project:
//
//   "use client";
//   import { useChat } from "@ai-sdk/react";
//
//   export default function ChatPage() {
//     const { messages, input, handleInputChange, handleSubmit, status } =
//       useChat({ api: "/api/chat" });
//
//     return (
//       <div>
//         <ul>
//           {messages.map((m) => (
//             <li key={m.id}>
//               <strong>{m.role}:</strong> {m.content}
//             </li>
//           ))}
//         </ul>
//         <form onSubmit={handleSubmit}>
//           <input value={input} onChange={handleInputChange} />
//           <button type="submit" disabled={status === "streaming"}>Send</button>
//         </form>
//       </div>
//     );
//   }
//
// useChat needs no configuration beyond `api: "/api/chat"` because the backend
// speaks the AI SDK UI wire format by default.
//
// For component libraries built on the same protocol (AI Elements, assistant-ui),
// swap or supplement the JSX above — the route stays the same.
//
// ---------------------------------------------------------------------------
// Headless hooks alternative (protocol: "ndjson")
// ---------------------------------------------------------------------------
//
// If you need raw StreamEvent access (tool calls, cost, suspension), set:
//
//   export const POST = withEidentic(agent, { protocol: "ndjson" });
//
// Then on the client use @eidentic/react instead of useChat:
//
//   import { useAgent } from "@eidentic/react";
//
//   export default function ChatPage() {
//     const { messages, status, send, stop } = useAgent("chat");
//     // messages[].streaming is true while the token is still arriving
//     // status: "idle" | "streaming" | "done" | "error" | "suspended"
//     // send(input) starts a new turn
//     // stop() aborts an in-flight stream
//     ...
//   }
//
// useAgent targets /v1/agents/<id>/query on the same origin by default.
// Use useEidenticStream(fullUrl, opts) for a different origin.
//
// ---------------------------------------------------------------------------

console.log("\n--- Done. See comments above for the Next.js client code. ---");

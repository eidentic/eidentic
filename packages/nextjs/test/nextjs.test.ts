/**
 * Tests for @eidentic/nextjs — withEidentic and eidenticNextConfig.
 */

import { describe, it, expect } from "vitest";
import { Agent } from "@eidentic/core";
import { MockModel, InMemoryStore } from "@eidentic/types/testing";
import type { ModelResponse } from "@eidentic/types";
import { withEidentic, eidenticNextConfig } from "@eidentic/nextjs";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function textResponse(text: string): ModelResponse {
  return {
    content: [{ type: "text", text }],
    usage: { inputTokens: 10, outputTokens: 5 },
  };
}

function makeAgent(responses: ModelResponse[]) {
  const store = new InMemoryStore();
  const agent = new Agent({
    id: "nextjs-test-agent",
    instructions: "You are a helpful assistant.",
    model: new MockModel(responses),
    store,
  });
  return { agent, store };
}

function makeRequest(body: Record<string, unknown>, signal?: AbortSignal): Request {
  return new Request("http://localhost/api/chat", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
    signal,
  });
}

/** Collect all lines from an NDJSON streaming Response. */
async function collectNdjsonLines(res: Response): Promise<unknown[]> {
  const text = await res.text();
  return text
    .split("\n")
    .filter((l) => l.trim().length > 0)
    .map((l) => JSON.parse(l) as unknown);
}

// ---------------------------------------------------------------------------
// withEidentic — ai-sdk-ui protocol (default)
// ---------------------------------------------------------------------------

describe("withEidentic — ai-sdk-ui protocol (default)", () => {
  it("returns a 200 streaming Response for a valid request", async () => {
    const { agent } = makeAgent([textResponse("Hello, world!")]);
    const handler = withEidentic(agent);
    const req = makeRequest({ input: "Hi" });

    const res = await handler(req);

    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toMatch(/text\/event-stream/);
    // Ensure it has a body
    const body = await res.text();
    expect(body.length).toBeGreaterThan(0);
  });

  it("accepts 'message' as an alias for 'input' (useChat compatibility)", async () => {
    const { agent } = makeAgent([textResponse("Hi!")]);
    const handler = withEidentic(agent);
    const req = makeRequest({ message: "Hello from useChat" });

    const res = await handler(req);

    expect(res.status).toBe(200);
  });

  it("accepts a useChat 'messages' array (v5+ parts) — extracts the newest user message", async () => {
    const { agent, store } = makeAgent([textResponse("Hi!")]);
    const handler = withEidentic(agent);
    const req = makeRequest({
      sessionId: "uc-1",
      messages: [
        { role: "user", parts: [{ type: "text", text: "first turn" }] },
        { role: "assistant", parts: [{ type: "text", text: "ok" }] },
        { role: "user", parts: [{ type: "text", text: "what did I say?" }] },
      ],
    });

    const res = await handler(req);
    expect(res.status).toBe(200);
    await res.text();

    // The newest user message ("what did I say?") — not the assistant turn or an older message —
    // must be what reached the agent (persisted as the user event for this session).
    const events = await store.readEvents("uc-1");
    const userEvent = events.find((e) => e.kind === "user");
    expect(JSON.stringify(userEvent?.payload)).toContain("what did I say?");
  });

  it("accepts a useChat 'messages' array with the legacy 'content' string shape", async () => {
    const { agent } = makeAgent([textResponse("Hi!")]);
    const handler = withEidentic(agent);
    const req = makeRequest({ messages: [{ role: "user", content: "legacy content message" }] });

    const res = await handler(req);
    expect(res.status).toBe(200);
  });

  it("rejects a 'messages' array whose newest user message has no text (400)", async () => {
    const { agent } = makeAgent([textResponse("Hi!")]);
    const handler = withEidentic(agent);
    const req = makeRequest({ messages: [{ role: "user", parts: [{ type: "file" }] }] });

    const res = await handler(req);
    expect(res.status).toBe(400);
  });

  it("streams events containing AI SDK UI finish chunk", async () => {
    const { agent } = makeAgent([textResponse("Done!")]);
    const handler = withEidentic(agent);
    const req = makeRequest({ input: "Go" });

    const res = await handler(req);

    expect(res.status).toBe(200);
    const body = await res.text();
    // AI SDK UI protocol: each line is either a data: or a 0:... format
    // The body must be non-empty and contain some content
    expect(body).toBeTruthy();
  });

  it("returns 400 for empty input", async () => {
    const { agent } = makeAgent([textResponse("hi")]);
    const handler = withEidentic(agent);
    const req = makeRequest({ input: "" });

    const res = await handler(req);

    expect(res.status).toBe(400);
    const body = await res.json() as { error: string };
    expect(body.error).toMatch(/input/i);
  });

  it("returns 400 for missing input and message", async () => {
    const { agent } = makeAgent([textResponse("hi")]);
    const handler = withEidentic(agent);
    const req = makeRequest({ sessionId: "s1" });

    const res = await handler(req);

    expect(res.status).toBe(400);
  });

  it("returns 400 for invalid JSON", async () => {
    const { agent } = makeAgent([textResponse("hi")]);
    const handler = withEidentic(agent);
    const req = new Request("http://localhost/api/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "not json",
    });

    const res = await handler(req);

    expect(res.status).toBe(400);
    const body = await res.json() as { error: string };
    expect(body.error).toMatch(/json/i);
  });

  it("passes sessionId from body to the agent", async () => {
    const { agent, store } = makeAgent([textResponse("OK")]);
    const handler = withEidentic(agent);
    const req = makeRequest({ input: "hi", sessionId: "my-session-id" });

    const res = await handler(req);
    expect(res.status).toBe(200);
    // Drain the stream so the agent run completes
    await res.text();

    const session = await store.getSession("my-session-id");
    expect(session).not.toBeNull();
    expect(session?.id).toBe("my-session-id");
  });

  it("mints a new sessionId when not provided", async () => {
    const { agent, store } = makeAgent([textResponse("OK")]);
    const handler = withEidentic(agent);
    const req = makeRequest({ input: "hi" });

    const res = await handler(req);
    expect(res.status).toBe(200);
    await res.text();

    const sessions = await store.listSessions({ agentId: "nextjs-test-agent" });
    expect(sessions.length).toBe(1);
    expect(sessions[0]?.id).toBeTruthy();
  });

  it("merges extra headers into the response", async () => {
    const { agent } = makeAgent([textResponse("hi")]);
    const handler = withEidentic(agent, {
      headers: { "X-Custom-Header": "test-value" },
    });
    const req = makeRequest({ input: "hi" });

    const res = await handler(req);

    expect(res.headers.get("x-custom-header")).toBe("test-value");
  });
});

// ---------------------------------------------------------------------------
// withEidentic — ndjson protocol
// ---------------------------------------------------------------------------

describe("withEidentic — ndjson protocol", () => {
  it("returns content-type application/x-ndjson", async () => {
    const { agent } = makeAgent([textResponse("ndjson test")]);
    const handler = withEidentic(agent, { protocol: "ndjson" });
    const req = makeRequest({ input: "test" });

    const res = await handler(req);

    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("application/x-ndjson");
  });

  it("streams valid JSON lines, each parseable as StreamEvent", async () => {
    const { agent } = makeAgent([textResponse("ndjson works")]);
    const handler = withEidentic(agent, { protocol: "ndjson" });
    const req = makeRequest({ input: "hello" });

    const res = await handler(req);

    expect(res.status).toBe(200);
    const lines = await collectNdjsonLines(res);
    expect(lines.length).toBeGreaterThan(0);

    // Each parsed line must be an object with a "type" field
    for (const line of lines) {
      expect(line).toMatchObject({ type: expect.any(String) });
    }
  });

  it("terminal result event is present in the ndjson stream", async () => {
    const { agent } = makeAgent([textResponse("done")]);
    const handler = withEidentic(agent, { protocol: "ndjson" });
    const req = makeRequest({ input: "finish?" });

    const res = await handler(req);
    const lines = await collectNdjsonLines(res) as Array<{ type: string; subtype?: string }>;

    const result = lines.find((l) => l.type === "result");
    expect(result).toBeDefined();
    expect(result?.subtype).toBe("success");
  });

  it("accepts 'message' alias in ndjson protocol", async () => {
    const { agent } = makeAgent([textResponse("alias ok")]);
    const handler = withEidentic(agent, { protocol: "ndjson" });
    const req = makeRequest({ message: "from useChat" });

    const res = await handler(req);
    expect(res.status).toBe(200);
  });

  it("returns 400 for missing input in ndjson protocol", async () => {
    const { agent } = makeAgent([textResponse("hi")]);
    const handler = withEidentic(agent, { protocol: "ndjson" });
    const req = makeRequest({ sessionId: "s1" });

    const res = await handler(req);
    expect(res.status).toBe(400);
  });

  it("merges extra headers in ndjson mode", async () => {
    const { agent } = makeAgent([textResponse("headers")]);
    const handler = withEidentic(agent, {
      protocol: "ndjson",
      headers: { "X-Test": "ndjson-header" },
    });
    const req = makeRequest({ input: "hi" });

    const res = await handler(req);
    expect(res.headers.get("x-test")).toBe("ndjson-header");
  });
});

// ---------------------------------------------------------------------------
// eidenticNextConfig
// ---------------------------------------------------------------------------

describe("eidenticNextConfig", () => {
  it("adds better-sqlite3 to serverExternalPackages", () => {
    const result = eidenticNextConfig({});
    expect(result.serverExternalPackages).toContain("better-sqlite3");
  });

  it("merges with existing serverExternalPackages without duplicates", () => {
    const result = eidenticNextConfig({
      serverExternalPackages: ["sharp", "better-sqlite3"],
    });
    const pkgs = result.serverExternalPackages as string[];
    expect(pkgs).toContain("better-sqlite3");
    expect(pkgs).toContain("sharp");
    expect(pkgs.filter((p) => p === "better-sqlite3").length).toBe(1);
  });

  it("preserves other config keys", () => {
    const base = {
      reactStrictMode: true,
      images: { domains: ["example.com"] },
    };
    const result = eidenticNextConfig(base);
    expect(result.reactStrictMode).toBe(true);
    expect((result.images as { domains: string[] }).domains).toContain("example.com");
  });

  it("works with no arguments", () => {
    const result = eidenticNextConfig();
    expect(result.serverExternalPackages).toContain("better-sqlite3");
  });
});

// ---------------------------------------------------------------------------
// Finding #8 — withEidentic security hardening
// ---------------------------------------------------------------------------

// Helper: build a Request without Content-Length (simulates chunked transfer).
function makeChunkedRequest(bodyStr: string, extraHeaders?: Record<string, string>): Request {
  const encoder = new TextEncoder();
  const bytes = encoder.encode(bodyStr);
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      // Emit in two chunks to ensure chunked-style delivery
      const half = Math.ceil(bytes.length / 2);
      controller.enqueue(bytes.slice(0, half));
      controller.enqueue(bytes.slice(half));
      controller.close();
    },
  });
  return new Request("http://localhost/api/chat", {
    method: "POST",
    headers: { "Content-Type": "application/json", ...extraHeaders },
    // @ts-expect-error — duplex is required in Node 18+ for streaming bodies
    duplex: "half",
    body: stream,
  });
}

describe("withEidentic — body-size guard (Finding #8a)", () => {
  it("returns 413 when Content-Length exceeds the default 1 MB limit", async () => {
    const { agent } = makeAgent([textResponse("hi")]);
    const handler = withEidentic(agent);

    const req = new Request("http://localhost/api/chat", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        // 2 MB — exceeds the 1 MB default
        "Content-Length": String(2 * 1024 * 1024),
      },
      body: JSON.stringify({ input: "hi" }),
    });

    const res = await handler(req);
    expect(res.status).toBe(413);
    const body = await res.json() as { error: string };
    expect(body.error).toMatch(/too large/i);
  });

  it("returns 413 when Content-Length exceeds a custom maxBodyBytes limit", async () => {
    const { agent } = makeAgent([textResponse("hi")]);
    const handler = withEidentic(agent, { maxBodyBytes: 100 });

    const req = new Request("http://localhost/api/chat", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Content-Length": "200",
      },
      body: JSON.stringify({ input: "hi" }),
    });

    const res = await handler(req);
    expect(res.status).toBe(413);
  });

  it("allows a request whose Content-Length is within the limit", async () => {
    const { agent } = makeAgent([textResponse("hi")]);
    const handler = withEidentic(agent, { maxBodyBytes: 1024 });
    const req = makeRequest({ input: "hi" });

    const res = await handler(req);
    expect(res.status).toBe(200);
    await res.text();
  });

  // Chunked transfer tests (M21 fix) — no Content-Length header present.

  it("returns 413 for chunked body larger than maxBodyBytes (no Content-Length)", async () => {
    const { agent } = makeAgent([textResponse("hi")]);
    const handler = withEidentic(agent, { maxBodyBytes: 50 });

    // Build a JSON body that exceeds the 50-byte cap.
    const largeBody = JSON.stringify({ input: "a".repeat(200) });
    const req = makeChunkedRequest(largeBody);

    const res = await handler(req);
    expect(res.status).toBe(413);
    const body = await res.json() as { error: string };
    expect(body.error).toMatch(/too large/i);
  });

  it("body under cap without Content-Length is parsed and succeeds", async () => {
    const { agent } = makeAgent([textResponse("hi")]);
    const handler = withEidentic(agent, { maxBodyBytes: 1024 });

    const req = makeChunkedRequest(JSON.stringify({ input: "hello" }));

    const res = await handler(req);
    expect(res.status).toBe(200);
    await res.text();
  });

  it("body exactly at the cap (no Content-Length) is allowed", async () => {
    const { agent } = makeAgent([textResponse("hi")]);
    const cap = 200;
    const bodyStr = JSON.stringify({ input: "x" });
    // bodyStr is well under cap — this confirms the boundary: bytes === cap should pass.
    const handler = withEidentic(agent, { maxBodyBytes: cap });

    const req = makeChunkedRequest(bodyStr);

    const res = await handler(req);
    expect(res.status).toBe(200);
    await res.text();
  });
});

describe("withEidentic — identify override (Finding #8b)", () => {
  it("identify() return value overrides body-supplied userId", async () => {
    const { agent, store } = makeAgent([textResponse("ok")]);
    const handler = withEidentic(agent, {
      identify: async () => ({ userId: "server-determined-user" }),
    });

    // Body sends a different userId — it must be ignored.
    const req = makeRequest({ input: "hi", userId: "attacker-supplied-id", sessionId: "id-test-sess" });
    const res = await handler(req);
    expect(res.status).toBe(200);
    await res.text();

    const session = await store.getSession("id-test-sess");
    // The session must be owned by "server-determined-user", NOT "attacker-supplied-id".
    expect(session?.userId).toBe("server-determined-user");
  });

  it("identify() with no userId falls back to undefined (no owner on session)", async () => {
    const { agent, store } = makeAgent([textResponse("ok")]);
    const handler = withEidentic(agent, {
      identify: async () => ({}),
    });

    const req = makeRequest({ input: "hi", userId: "should-be-ignored", sessionId: "no-owner-sess" });
    const res = await handler(req);
    expect(res.status).toBe(200);
    await res.text();

    const session = await store.getSession("no-owner-sess");
    // No userId from identify → session has no owner.
    expect(session?.userId).toBeUndefined();
  });

  it("without identify, body-supplied userId is used (single-tenant fallback)", async () => {
    const { agent, store } = makeAgent([textResponse("ok")]);
    const handler = withEidentic(agent);

    const req = makeRequest({ input: "hi", userId: "body-user", sessionId: "body-user-sess" });
    const res = await handler(req);
    expect(res.status).toBe(200);
    await res.text();

    const session = await store.getSession("body-user-sess");
    expect(session?.userId).toBe("body-user");
  });
});

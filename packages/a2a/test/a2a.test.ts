import { afterEach, describe, it, expect, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { a2aRoutes as guardedA2aRoutes, drainIterableAgent, drainPromiseResult, type AgentLike, type A2AAgentCard } from "../src/index.js";
import {
  a2aTool,
  fetchAgentCard,
  httpA2ATransport,
  type A2ATransport,
} from "../src/index.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const a2aRoutes: typeof guardedA2aRoutes = (opts) => guardedA2aRoutes({
  unsafeAllowUnauthenticated: opts.auth === undefined,
  ...opts,
});

/** Send a JSON-RPC request to a Hono app using app.request (no network). */
async function rpc(app: ReturnType<typeof a2aRoutes>, method: string, params: unknown, id: number = 1) {
  const res = await app.request("/", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id, method, params }),
  });
  return res.json();
}

// ---------------------------------------------------------------------------
// Minimal faithful AgentLike fake
//
// Mirrors how the real @eidentic/core Agent works: async generator that yields
// a terminal { kind: "result", output: string } event.
// ---------------------------------------------------------------------------

function makeAgent(outputText: string): AgentLike {
  return {
    async *query(_input: string, _opts?: { sessionId?: string; userId?: string; orgId?: string; apiKey?: string; signal?: AbortSignal }) {
      yield { kind: "result", output: outputText };
    },
  };
}

const card: A2AAgentCard = {
  name: "Test Agent",
  description: "A test agent.",
  url: "http://localhost:3000",
  version: "1.0.0",
  skills: [{ id: "greet", name: "Greet", description: "Greet the user." }],
};

// ---------------------------------------------------------------------------
// SERVER TESTS
// ---------------------------------------------------------------------------

describe("a2aRoutes — agent card", () => {
  it("GET /.well-known/agent-card.json returns the agent card", async () => {
    const app = a2aRoutes({ card, agent: makeAgent("hello") });
    const res = await app.request("/.well-known/agent-card.json");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.name).toBe("Test Agent");
    expect(body.description).toBe("A test agent.");
    expect(body.version).toBe("1.0.0");
    expect(body.skills).toHaveLength(1);
    expect(body.skills[0].id).toBe("greet");
    expect(body.capabilities).toBeDefined();
    expect(body.capabilities.streaming).toBe(false);
  });
});

describe("a2aRoutes — message/send", () => {
  it("returns a completed Task with the agent output as a text part in history", async () => {
    const app = a2aRoutes({ card, agent: makeAgent("World says hi") });
    const result = await rpc(app, "message/send", {
      message: {
        kind: "message",
        messageId: "msg-1",
        role: "user",
        contextId: "ctx-test-1",
        parts: [{ kind: "text", text: "Hello?" }],
      },
    });
    expect(result.jsonrpc).toBe("2.0");
    expect(result.id).toBe(1);
    expect(result.error).toBeUndefined();
    const task = result.result;
    expect(task.kind).toBe("task");
    expect(task.status.state).toBe("completed");
    expect(task.history).toHaveLength(1);
    expect(task.history[0].role).toBe("agent");
    expect(task.history[0].parts[0].kind).toBe("text");
    expect(task.history[0].parts[0].text).toBe("World says hi");
  });

  it("joins multiple text parts from the user message", async () => {
    let captured = "";
    const agent: AgentLike = {
      async *query(input) {
        captured = input;
        yield { kind: "result", output: `echo: ${input}` };
      },
    };
    const app = a2aRoutes({ card, agent });
    await rpc(app, "message/send", {
      message: {
        kind: "message",
        messageId: "msg-2",
        role: "user",
        parts: [
          { kind: "text", text: "Hello" },
          { kind: "text", text: "World" },
        ],
      },
    });
    expect(captured).toBe("Hello\nWorld");
  });

  it("returns -32601 for unknown method", async () => {
    const app = a2aRoutes({ card, agent: makeAgent("x") });
    const result = await rpc(app, "agent/teleport", {});
    expect(result.error).toBeDefined();
    expect(result.error.code).toBe(-32601);
  });

  it("returns -32600 for malformed request (missing method)", async () => {
    const app = a2aRoutes({ card, agent: makeAgent("x") });
    const res = await app.request("/", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, notmethod: "message/send" }),
    });
    const body = await res.json();
    expect(body.error).toBeDefined();
    expect(body.error.code).toBe(-32600);
  });

  it("returns -32602 for message/send with missing message", async () => {
    const app = a2aRoutes({ card, agent: makeAgent("x") });
    const result = await rpc(app, "message/send", { notmessage: true });
    expect(result.error).toBeDefined();
    expect(result.error.code).toBe(-32602);
  });

  it("returns -32700 for non-JSON body", async () => {
    const app = a2aRoutes({ card, agent: makeAgent("x") });
    const res = await app.request("/", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "this is not json{{{{",
    });
    const body = await res.json();
    expect(body.error.code).toBe(-32700);
  });
});

describe("a2aRoutes — tasks/get", () => {
  it("returns the task by id after message/send (no-auth mode)", async () => {
    const app = a2aRoutes({ card, agent: makeAgent("stored") });
    const sendResult = await rpc(app, "message/send", {
      message: {
        kind: "message",
        messageId: "msg-3",
        role: "user",
        parts: [{ kind: "text", text: "store this" }],
      },
    });
    const taskId = sendResult.result.id;
    const getResult = await rpc(app, "tasks/get", { id: taskId }, 2);
    expect(getResult.error).toBeUndefined();
    expect(getResult.result.id).toBe(taskId);
    expect(getResult.result.status.state).toBe("completed");
  });

  it("does not expose the internal owner field in tasks/get response", async () => {
    const app = a2aRoutes({ card, agent: makeAgent("no-leak") });
    const sendResult = await rpc(app, "message/send", {
      message: { kind: "message", messageId: "m-owner-leak", role: "user", parts: [{ kind: "text", text: "hi" }] },
    });
    const taskId = sendResult.result.id;
    const getResult = await rpc(app, "tasks/get", { id: taskId }, 2);
    expect(getResult.error).toBeUndefined();
    expect(getResult.result).not.toHaveProperty("owner");
  });

  it("returns -32001 for unknown task id", async () => {
    const app = a2aRoutes({ card, agent: makeAgent("x") });
    const result = await rpc(app, "tasks/get", { id: "task_nonexistent" }, 2);
    expect(result.error).toBeDefined();
    expect(result.error.code).toBe(-32001);
  });
});

// ---------------------------------------------------------------------------
// Task ownership — tasks/get authorization
// ---------------------------------------------------------------------------

describe("a2aRoutes — task ownership (tasks/get authz)", () => {
  /** Helper: send a message with a specific x-api-key header and return the raw response. */
  async function sendWithKey(app: ReturnType<typeof a2aRoutes>, apiKey: string) {
    const res = await app.request("/", {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-api-key": apiKey },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "message/send",
        params: {
          message: { kind: "message", messageId: "m", role: "user", parts: [{ kind: "text", text: "hi" }] },
        },
      }),
    });
    return res.json();
  }

  /** Helper: call tasks/get with a specific x-api-key header. */
  async function getWithKey(app: ReturnType<typeof a2aRoutes>, taskId: string, apiKey: string) {
    const res = await app.request("/", {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-api-key": apiKey },
      body: JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tasks/get", params: { id: taskId } }),
    });
    return res.json();
  }

  it("same caller can retrieve their own task", async () => {
    const app = a2aRoutes({
      card,
      agent: makeAgent("owned"),
      auth: { verify: (req) => req.headers.get("x-api-key") ?? false },
    });
    const sendResult = await sendWithKey(app, "caller-a");
    expect(sendResult.error).toBeUndefined();
    const taskId: string = sendResult.result.id;

    const getResult = await getWithKey(app, taskId, "caller-a");
    expect(getResult.error).toBeUndefined();
    expect(getResult.result.id).toBe(taskId);
  });

  it("different caller gets -32001 (indistinguishable from not-found)", async () => {
    const app = a2aRoutes({
      card,
      agent: makeAgent("secret output"),
      auth: { verify: (req) => req.headers.get("x-api-key") ?? false },
    });
    const sendResult = await sendWithKey(app, "caller-a");
    expect(sendResult.error).toBeUndefined();
    const taskId: string = sendResult.result.id;

    // caller-b tries to fetch caller-a's task
    const getResult = await getWithKey(app, taskId, "caller-b");
    expect(getResult.error).toBeDefined();
    expect(getResult.error.code).toBe(-32001);
    // Error message must not reveal the task exists — same wording as not-found
    expect(getResult.error.message).toContain("Task not found");
  });

  it("keeps the same user isolated across organizations", async () => {
    const app = a2aRoutes({
      card,
      agent: makeAgent("tenant-a secret"),
      auth: {
        verify: (req) => ({
          userId: "shared-user-id",
          orgId: req.headers.get("x-api-key") ?? "",
        }),
      },
    });
    const sendResult = await sendWithKey(app, "org-a");
    const taskId: string = sendResult.result.id;

    const sameTenant = await getWithKey(app, taskId, "org-a");
    const otherTenant = await getWithKey(app, taskId, "org-b");

    expect(sameTenant.error).toBeUndefined();
    expect(otherTenant.error?.code).toBe(-32001);
    expect(otherTenant.error?.message).toContain("Task not found");
  });

  it("unauthorized tasks/get is indistinguishable from a nonexistent task id", async () => {
    const app = a2aRoutes({
      card,
      agent: makeAgent("secret"),
      auth: { verify: (req) => req.headers.get("x-api-key") ?? false },
    });
    const sendResult = await sendWithKey(app, "caller-a");
    const existingTaskId: string = sendResult.result.id;

    const notFoundResult = await getWithKey(app, "totally-nonexistent-id", "caller-b");
    const unauthorizedResult = await getWithKey(app, existingTaskId, "caller-b");

    // Both should return the same error code
    expect(notFoundResult.error.code).toBe(-32001);
    expect(unauthorizedResult.error.code).toBe(-32001);
  });

  it("denies the JSON-RPC endpoint when auth is omitted by default", async () => {
    const app = guardedA2aRoutes({ card, agent: makeAgent("closed") });
    const res = await app.request("/", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tasks/get", params: { id: "x" } }),
    });
    expect(res.status).toBe(401);
  });

  it("explicit unsafe no-auth mode preserves the legacy single-tenant behavior", async () => {
    const app = a2aRoutes({ card, agent: makeAgent("open result") });
    const sendResult = await rpc(app, "message/send", {
      message: { kind: "message", messageId: "m-open", role: "user", parts: [{ kind: "text", text: "hi" }] },
    });
    expect(sendResult.error).toBeUndefined();
    const taskId: string = sendResult.result.id;

    // A second rpc call (simulating a different caller) can still fetch the task
    const getResult = await rpc(app, "tasks/get", { id: taskId }, 2);
    expect(getResult.error).toBeUndefined();
    expect(getResult.result.id).toBe(taskId);
  });

  it("boolean-true verifier (single-identity mode) grants access to tasks/get for same session", async () => {
    // A verifier that returns boolean true maps to the sentinel identity "*"
    // so tasks created under it are accessible to all callers of that server.
    const app = a2aRoutes({
      card,
      agent: makeAgent("bool-true"),
      auth: { verify: () => true },
    });
    const sendResult = await rpc(app, "message/send", {
      message: { kind: "message", messageId: "m-bt", role: "user", parts: [{ kind: "text", text: "hi" }] },
    });
    expect(sendResult.error).toBeUndefined();
    const taskId: string = sendResult.result.id;

    const getResult = await rpc(app, "tasks/get", { id: taskId }, 2);
    expect(getResult.error).toBeUndefined();
    expect(getResult.result.id).toBe(taskId);
  });

  it("passes verified user/org identity but never persists a raw credential", async () => {
    let captured: { sessionId?: string; userId?: string; orgId?: string; apiKey?: string; signal?: AbortSignal } | undefined;
    const agent: AgentLike = {
      async *query(_input, opts) {
        captured = opts;
        yield { kind: "result", output: "ok" };
      },
    };
    const app = a2aRoutes({
      card,
      agent,
      auth: { verify: () => ({ id: "owner-a", userId: "u1", orgId: "o1", apiKey: "key-a" }) },
    });

    const result = await rpc(app, "message/send", {
      message: {
        kind: "message",
        messageId: "m",
        role: "user",
        contextId: "ctx-a",
        parts: [{ kind: "text", text: "hi" }],
      },
    });
    expect(result.error).toBeUndefined();
    expect(captured).toMatchObject({ sessionId: "ctx-a", userId: "u1", orgId: "o1" });
    expect(captured?.signal).toBeInstanceOf(AbortSignal);
    expect(JSON.stringify(captured)).not.toContain("key-a");
  });

  it("keeps task ownership stable when a verified principal rotates credentials", async () => {
    let activeKey = "rotating-key-v1";
    const app = a2aRoutes({
      card,
      agent: makeAgent("stable task"),
      auth: {
        verify: () => ({ id: "stable-subject", userId: "u1", orgId: "o1", apiKey: activeKey }),
      },
    });
    const created = await rpc(app, "message/send", {
      message: { kind: "message", messageId: "rotate", role: "user", parts: [{ kind: "text", text: "hi" }] },
    });

    activeKey = "rotating-key-v2";
    const fetched = await rpc(app, "tasks/get", { id: created.result.id }, 2);

    expect(fetched.error).toBeUndefined();
    expect(JSON.stringify(fetched)).not.toContain("rotating-key");
  });

  it("maps a raw string credential to a stable opaque identity before Agent.query", async () => {
    const captures: Array<{ sessionId?: string; userId?: string; orgId?: string; apiKey?: string }> = [];
    const agent: AgentLike = {
      async *query(_input, opts) {
        captures.push(opts ?? {});
        yield { kind: "result", output: "ok" };
      },
    };
    const app = a2aRoutes({
      card,
      agent,
      auth: { verify: (req) => req.headers.get("x-api-key") ?? false },
    });

    await sendWithKey(app, "raw-secret-a");
    await sendWithKey(app, "raw-secret-a");
    await sendWithKey(app, "raw-secret-b");

    expect(captures).toHaveLength(3);
    expect(captures[0]?.userId).toMatch(/^a2a:[a-f0-9]{64}$/);
    expect(captures[0]?.userId).toBe(captures[1]?.userId);
    expect(captures[0]?.userId).not.toBe(captures[2]?.userId);
    expect(captures.every((value) => value.apiKey === undefined)).toBe(true);
    expect(JSON.stringify(captures)).not.toContain("raw-secret");
  });

  it("keeps raw credential forwarding behind an explicit unsafe compatibility opt-in", async () => {
    let captured: { sessionId?: string; userId?: string; orgId?: string; apiKey?: string } | undefined;
    const agent: AgentLike = {
      async *query(_input, opts) {
        captured = opts;
        yield { kind: "result", output: "ok" };
      },
    };
    const app = a2aRoutes({
      card,
      agent,
      auth: { verify: () => "legacy-secret" },
      allowRawCredentialIdentity: true,
    });

    const result = await rpc(app, "message/send", {
      message: { kind: "message", messageId: "legacy", role: "user", parts: [{ kind: "text", text: "hi" }] },
    });
    expect(captured?.apiKey).toBe("legacy-secret");
    expect(result.result.owner).toBeUndefined();
    expect(JSON.stringify(result)).not.toContain("legacy-secret");
  });

  it("rejects cross-owner reuse of an existing contextId", async () => {
    const app = a2aRoutes({
      card,
      agent: makeAgent("ok"),
      auth: { verify: (req) => req.headers.get("x-api-key") ?? false },
    });
    const first = await app.request("/", {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-api-key": "owner-a" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "message/send",
        params: {
          message: {
            kind: "message",
            messageId: "m1",
            role: "user",
            contextId: "shared-context",
            parts: [{ kind: "text", text: "hi" }],
          },
        },
      }),
    });
    expect((await first.json()).error).toBeUndefined();

    const second = await app.request("/", {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-api-key": "owner-b" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 2,
        method: "message/send",
        params: {
          message: {
            kind: "message",
            messageId: "m2",
            role: "user",
            contextId: "shared-context",
            parts: [{ kind: "text", text: "intrude" }],
          },
        },
      }),
    });
    const body = await second.json();
    expect(body.error?.code).toBe(-32001);
  });

  it("binds an id-only subject inside an organization to downstream session ownership", async () => {
    const captures: Array<{ sessionId?: string; userId?: string; orgId?: string; signal?: AbortSignal }> = [];
    const app = a2aRoutes({
      card,
      agent: {
        async *query(_input, opts) {
          captures.push(opts ?? {});
          yield { kind: "result", output: "ok" };
        },
      },
      auth: {
        verify: (req) => ({ id: req.headers.get("x-api-key") ?? "", orgId: "shared-org" }),
      },
    });

    const first = await app.request("/", {
      method: "POST",
      headers: { "content-type": "application/json", "x-api-key": "subject-a" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "message/send",
        params: {
          message: {
            kind: "message",
            messageId: "a",
            role: "user",
            contextId: "shared-org-context",
            parts: [{ kind: "text", text: "hi" }],
          },
        },
      }),
    });
    expect((await first.json()).error).toBeUndefined();
    expect(captures[0]).toMatchObject({
      sessionId: "shared-org-context",
      userId: "subject-a",
      orgId: "shared-org",
    });
    expect(captures[0]?.signal).toBeInstanceOf(AbortSignal);

    const second = await app.request("/", {
      method: "POST",
      headers: { "content-type": "application/json", "x-api-key": "subject-b" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 2,
        method: "message/send",
        params: {
          message: {
            kind: "message",
            messageId: "b",
            role: "user",
            contextId: "shared-org-context",
            parts: [{ kind: "text", text: "intrude" }],
          },
        },
      }),
    });
    expect((await second.json()).error?.code).toBe(-32001);
    expect(captures).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// Request resource limits
// ---------------------------------------------------------------------------

describe("a2aRoutes — request resource limits", () => {
  function messageBody(parts: unknown[]) {
    return JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "message/send",
      params: {
        message: { kind: "message", messageId: "limited", role: "user", parts },
      },
    });
  }

  it("rejects a streamed JSON body above maxBodyBytes before invoking the agent", async () => {
    let calls = 0;
    const app = a2aRoutes({
      card,
      agent: { async query() { calls++; return "no"; } },
      maxBodyBytes: 96,
    });

    const res = await app.request("/", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: messageBody([{ kind: "text", text: "x".repeat(256) }]),
    });

    expect(res.status).toBe(413);
    expect(calls).toBe(0);
  });

  it("rejects too many message parts", async () => {
    const app = a2aRoutes({ card, agent: makeAgent("no"), maxParts: 1 });
    const res = await app.request("/", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: messageBody([
        { kind: "text", text: "one" },
        { kind: "text", text: "two" },
      ]),
    });

    expect(res.status).toBe(413);
    expect(await res.json()).toMatchObject({ error: { message: expect.stringMatching(/parts|large/i) } });
  });

  it("measures the text cap in UTF-8 bytes", async () => {
    const app = a2aRoutes({ card, agent: makeAgent("no"), maxTextBytes: 4 });
    const res = await app.request("/", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: messageBody([{ kind: "text", text: "ééé" }]),
    });

    expect(res.status).toBe(413);
    expect(await res.json()).toMatchObject({ error: { message: expect.stringMatching(/text|large/i) } });
  });

  it("rejects invalid non-positive resource-limit configuration", () => {
    expect(() => a2aRoutes({ card, agent: makeAgent("no"), maxParts: 0 }))
      .toThrow(/maxParts|positive/i);
  });

  it("rejects oversized agent output", async () => {
    const app = a2aRoutes({ card, agent: makeAgent("12345"), maxOutputBytes: 4 });
    const res = await app.request("/", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: messageBody([{ kind: "text", text: "hi" }]),
    });
    expect(res.status).toBe(502);
    expect(await res.json()).toMatchObject({ error: { message: expect.stringMatching(/output|bytes/i) } });
  });

  it("aborts and times out a slow agent run", async () => {
    let sawAbort = false;
    const app = a2aRoutes({
      card,
      maxRunMs: 5,
      agent: {
        query(_input, opts) {
          return new Promise((_resolve, reject) => {
            opts?.signal?.addEventListener("abort", () => {
              sawAbort = true;
              reject(opts.signal?.reason);
            }, { once: true });
          });
        },
      },
    });
    const res = await app.request("/", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: messageBody([{ kind: "text", text: "hi" }]),
    });
    expect(res.status).toBe(504);
    expect(sawAbort).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Bounded task store — eviction
// ---------------------------------------------------------------------------

describe("a2aRoutes — bounded task store (maxTasks)", () => {
  async function sendMsg(app: ReturnType<typeof a2aRoutes>, text: string) {
    return rpc(app, "message/send", {
      message: { kind: "message", messageId: randomUUID(), role: "user", parts: [{ kind: "text", text }] },
    });
  }

  it("respects the maxTasks cap — store never exceeds the limit", async () => {
    const app = a2aRoutes({ card, agent: makeAgent("ok"), maxTasks: 3 });
    await sendMsg(app, "a");
    await sendMsg(app, "b");
    await sendMsg(app, "c");
    // Adding a 4th should evict the oldest
    const result4 = await sendMsg(app, "d");
    expect(result4.error).toBeUndefined();
    // The 4th task must be retrievable
    expect(result4.result.kind).toBe("task");
  });

  it("evicts the oldest settled task first, preserving newer ones", async () => {
    const app = a2aRoutes({ card, agent: makeAgent("ok"), maxTasks: 3 });
    const r1 = await sendMsg(app, "first");
    const r2 = await sendMsg(app, "second");
    const r3 = await sendMsg(app, "third");
    const id1 = r1.result.id as string;
    const id2 = r2.result.id as string;
    const id3 = r3.result.id as string;

    // Adding 4th should evict id1 (oldest settled)
    const r4 = await sendMsg(app, "fourth");
    const id4 = r4.result.id as string;

    // id1 should be evicted
    const gone = await rpc(app, "tasks/get", { id: id1 }, 10);
    expect(gone.error).toBeDefined();
    expect(gone.error.code).toBe(-32001);

    // id2, id3, id4 should still be present
    const get2 = await rpc(app, "tasks/get", { id: id2 }, 11);
    const get3 = await rpc(app, "tasks/get", { id: id3 }, 12);
    const get4 = await rpc(app, "tasks/get", { id: id4 }, 13);
    expect(get2.error).toBeUndefined();
    expect(get3.error).toBeUndefined();
    expect(get4.error).toBeUndefined();
  });

  it("maxTasks: 1 — always keeps only the latest task", async () => {
    const app = a2aRoutes({ card, agent: makeAgent("ok"), maxTasks: 1 });
    const r1 = await sendMsg(app, "first");
    const id1 = r1.result.id as string;

    const r2 = await sendMsg(app, "second");
    const id2 = r2.result.id as string;

    const gone = await rpc(app, "tasks/get", { id: id1 }, 5);
    expect(gone.error).toBeDefined();

    const present = await rpc(app, "tasks/get", { id: id2 }, 6);
    expect(present.error).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// CLIENT TESTS
// ---------------------------------------------------------------------------

describe("a2aTool — fake transport", () => {
  /** A canned A2ATransport that returns a completed Task with a text part. */
  function makeFakeTransport(responseText: string): A2ATransport {
    return {
      async send(_method, _params) {
        // Returns a JSON-RPC success envelope (what httpA2ATransport returns)
        return {
          jsonrpc: "2.0",
          id: 1,
          result: {
            kind: "task",
            id: "task_fake_1",
            contextId: "ctx_fake",
            status: { state: "completed", timestamp: new Date().toISOString() },
            history: [
              {
                kind: "message",
                messageId: "msg_agent_1",
                role: "agent",
                parts: [{ kind: "text", text: responseText }],
                contextId: "ctx_fake",
              },
            ],
          },
        };
      },
    };
  }

  it("returns { text } from the canned task", async () => {
    const tool = a2aTool(makeFakeTransport("Hello from remote!"), {
      id: "remote_agent",
      description: "A remote test agent.",
    });
    expect(tool.id).toBe("remote_agent");
    expect(tool.description).toBe("A remote test agent.");

    const result = await tool.execute({ message: "hi" });
    expect((result as { text: string }).text).toBe("Hello from remote!");
  });

  it("returns { error } on transport throw (no throw out of execute)", async () => {
    const errorTransport: A2ATransport = {
      async send() { throw new Error("network unreachable"); },
    };
    const tool = a2aTool(errorTransport);
    const result = await tool.execute({ message: "hi" }) as { error: string };
    expect(result.error).toContain("A2A transport error");
    expect(result.error).toContain("network unreachable");
  });

  it("redacts credentials from transport and remote protocol errors", async () => {
    const throwing = a2aTool({
      async send() { throw new Error("Bearer transport-secret-value"); },
    });
    const thrown = await throwing.execute({ message: "hi" }) as { error: string };
    expect(thrown.error).toContain("Bearer [REDACTED]");
    expect(thrown.error).not.toContain("transport-secret-value");

    const remote = a2aTool({
      async send() {
        return { error: { message: "request failed for sk-abcdefghijklmnopqrstuvwxyz" } };
      },
    });
    const returned = await remote.execute({ message: "hi" }) as { error: string };
    expect(returned.error).toContain("[REDACTED_CREDENTIAL]");
    expect(returned.error).not.toContain("sk-abcdefghijklmnopqrstuvwxyz");
  });

  it("returns { error } on JSON-RPC error response (no throw)", async () => {
    const errTransport: A2ATransport = {
      async send() {
        return { jsonrpc: "2.0", id: 1, error: { code: -32601, message: "Method not found" } };
      },
    };
    const tool = a2aTool(errTransport);
    const result = await tool.execute({ message: "hi" }) as { error: string };
    expect(result.error).toContain("A2A error");
    expect(result.error).toContain("Method not found");
  });

  it("validates input schema: message must be a string", async () => {
    const tool = a2aTool(makeFakeTransport("x"));
    const parsed = tool.parse({ message: 123 });
    expect(parsed.ok).toBe(false);
  });

  it("passes message text to the transport's message/send params", async () => {
    let capturedParams: unknown;
    const capturingTransport: A2ATransport = {
      async send(_method, params) {
        capturedParams = params;
        return { jsonrpc: "2.0", id: 1, result: { kind: "message", messageId: "m", role: "agent", parts: [{ kind: "text", text: "ok" }], contextId: "c" } };
      },
    };
    const tool = a2aTool(capturingTransport);
    await tool.execute({ message: "test input" });
    const p = capturedParams as Record<string, unknown>;
    const msg = p["message"] as Record<string, unknown>;
    expect(msg["role"]).toBe("user");
    const parts = msg["parts"] as Array<Record<string, unknown>>;
    expect(parts[0]?.["kind"]).toBe("text");
    expect(parts[0]?.["text"]).toBe("test input");
  });

  it("propagates the tool AbortSignal to the transport", async () => {
    let capturedSignal: AbortSignal | undefined;
    const transport: A2ATransport = {
      async send(_method, _params, opts) {
        capturedSignal = opts?.signal;
        return { result: { kind: "message", parts: [] } };
      },
    };
    const controller = new AbortController();

    await a2aTool(transport).execute(
      { message: "cancelable" },
      { signal: controller.signal },
    );

    expect(capturedSignal).toBe(controller.signal);
  });
});

describe("httpA2ATransport resource limits", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("rejects a response that exceeds the streaming byte cap", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(
      JSON.stringify({ result: { text: "x".repeat(256) } }),
      { status: 200 },
    )));
    const transport = httpA2ATransport("https://agent.example", {
      maxResponseBytes: 64,
    });

    await expect(transport.send("message/send", {})).rejects.toThrow(/response|large|64/i);
  });

  it("aborts a request when its timeout expires", async () => {
    vi.stubGlobal("fetch", vi.fn((_url: string, init?: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(init.signal?.reason), { once: true });
      })));
    const transport = httpA2ATransport("https://agent.example", { timeoutMs: 10 });

    await expect(transport.send("message/send", {})).rejects.toThrow(/timed out|timeout/i);
  });

  it("honors a per-call AbortSignal", async () => {
    vi.stubGlobal("fetch", vi.fn((_url: string, init?: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(init.signal?.reason), { once: true });
      })));
    const transport = httpA2ATransport("https://agent.example", { timeoutMs: 60_000 });
    const controller = new AbortController();
    const pending = transport.send("message/send", {}, { signal: controller.signal });

    controller.abort(new Error("caller cancelled"));

    await expect(pending).rejects.toThrow(/caller cancelled/i);
  });

  it("applies the same response cap to agent-card discovery", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(
      JSON.stringify({ name: "x".repeat(128), description: "large" }),
      { status: 200 },
    )));

    await expect(fetchAgentCard("https://agent.example", {
      maxResponseBytes: 32,
    })).rejects.toThrow(/response|large|32/i);
  });
});

// ---------------------------------------------------------------------------
// Fix 3b — A2A auth guard
// ---------------------------------------------------------------------------

describe("a2aRoutes — auth guard (Fix 3b)", () => {
  it("unauthenticated message/send → 401 when auth is configured", async () => {
    const app = a2aRoutes({
      card,
      agent: makeAgent("should not reach"),
      auth: {
        verify: (req) => req.headers.get("x-api-key") === "secret",
      },
    });

    const result = await rpc(app, "message/send", {
      message: {
        kind: "message",
        messageId: "msg-auth-1",
        role: "user",
        parts: [{ kind: "text", text: "Hello?" }],
      },
    });
    // The response should be a JSON-RPC error (the HTTP status is 401, and rpc() parses body)
    expect(result.error).toBeDefined();
    expect(result.error.code).toBe(-32001);
  });

  it("authenticated message/send with valid credential → succeeds", async () => {
    const app = a2aRoutes({
      card,
      agent: makeAgent("auth ok"),
      auth: {
        verify: (req) => req.headers.get("x-api-key") === "secret",
      },
    });

    const res = await app.request("/", {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-api-key": "secret" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "message/send",
        params: {
          message: {
            kind: "message",
            messageId: "msg-auth-2",
            role: "user",
            parts: [{ kind: "text", text: "Hello!" }],
          },
        },
      }),
    });
    const result = await res.json();
    expect(result.error).toBeUndefined();
    expect(result.result.status.state).toBe("completed");
    expect(result.result.history[0].parts[0].text).toBe("auth ok");
  });

  it("agent card is always public (no auth check on GET /.well-known/agent-card.json)", async () => {
    // Even when auth is configured, the agent card endpoint is open for A2A discovery.
    const app = a2aRoutes({
      card,
      agent: makeAgent("x"),
      auth: {
        verify: () => false, // rejects everything
      },
    });

    const res = await app.request("/.well-known/agent-card.json");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.name).toBe("Test Agent");
  });

  it("task IDs are unguessable UUIDs (Fix 3b)", async () => {
    // Task IDs should be random UUIDs, not sequential Date.now()-based strings.
    const app = a2aRoutes({ card, agent: makeAgent("task-id-test") });
    const result1 = await rpc(app, "message/send", {
      message: { kind: "message", messageId: "m1", role: "user", parts: [{ kind: "text", text: "a" }] },
    });
    const result2 = await rpc(app, "message/send", {
      message: { kind: "message", messageId: "m2", role: "user", parts: [{ kind: "text", text: "b" }] },
    });
    const id1: string = result1.result.id;
    const id2: string = result2.result.id;
    // Both should look like UUIDs
    expect(id1).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
    expect(id2).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
    // They must be different
    expect(id1).not.toBe(id2);
  });

  it("no auth configured → endpoint is open (backward-compatible)", async () => {
    // Without auth option, the endpoint is open.
    const app = a2aRoutes({ card, agent: makeAgent("open") });
    const result = await rpc(app, "message/send", {
      message: { kind: "message", messageId: "m-open", role: "user", parts: [{ kind: "text", text: "hi" }] },
    });
    expect(result.error).toBeUndefined();
    expect(result.result.status.state).toBe("completed");
  });
});

// ---------------------------------------------------------------------------
// ROUND-TRIP TEST — Eidentic a2aTool <-> Eidentic a2aRoutes via app.request()
// ---------------------------------------------------------------------------

describe("round-trip: a2aTool -> a2aRoutes via in-process transport", () => {
  it("agent B (via a2aTool) can delegate to agent A (via a2aRoutes) end-to-end", async () => {
    // Agent A: exposed via a2aRoutes
    const agentA = makeAgent("Agent A says: 42 is the answer");
    const appA = a2aRoutes({
      card: {
        name: "Agent A",
        description: "The answering agent.",
        version: "1.0.0",
      },
      agent: agentA,
    });

    // In-process A2ATransport: routes requests to appA via app.request (no network)
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

    // Agent B uses a2aTool to call Agent A
    const toolForB = a2aTool(inProcessTransport, {
      id: "delegate_to_a",
      description: "Delegate to Agent A.",
    });

    // B calls A via the tool
    const result = await toolForB.execute({ message: "What is the answer?" }) as { text: string };
    expect(result.text).toBe("Agent A says: 42 is the answer");
  });

  it("agent card is fetchable in-process (verify card shape)", async () => {
    const appA = a2aRoutes({
      card: {
        name: "My Agent",
        description: "Does things.",
        version: "2.0.0",
        skills: [{ id: "s1", name: "Skill One", description: "Does skill one." }],
      },
      agent: makeAgent("ok"),
    });

    const res = await appA.request("/.well-known/agent-card.json");
    const card2 = await res.json();
    expect(card2.name).toBe("My Agent");
    expect(card2.version).toBe("2.0.0");
    expect(card2.skills).toHaveLength(1);
    expect(card2.capabilities.streaming).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// drainIterableAgent — split function tests (item 4)
// ---------------------------------------------------------------------------

describe("drainIterableAgent", () => {
  it("extracts output from { kind: 'result', output: string } terminal event", async () => {
    async function* gen() { yield { kind: "result", output: "hello world" }; }
    expect(await drainIterableAgent(gen())).toBe("hello world");
  });

  it("JSON-stringifies non-string output", async () => {
    async function* gen() { yield { kind: "result", output: { nested: 42 } }; }
    expect(await drainIterableAgent(gen())).toBe(JSON.stringify({ nested: 42 }));
  });

  it("falls back to JSON.stringify for events without output field", async () => {
    async function* gen() { yield { kind: "unknown", data: "foo" }; }
    expect(await drainIterableAgent(gen())).toBe(JSON.stringify({ kind: "unknown", data: "foo" }));
  });

  it("returns empty string when iterable yields nothing", async () => {
    async function* gen() { /* empty */ }
    expect(await drainIterableAgent(gen())).toBe("");
  });

  it("uses only the last event for the result", async () => {
    async function* gen() {
      yield { kind: "chunk", text: "ignored" };
      yield { kind: "chunk", text: "also ignored" };
      yield { kind: "result", output: "final output" };
    }
    expect(await drainIterableAgent(gen())).toBe("final output");
  });

  it("returns a plain string event as-is", async () => {
    async function* gen() { yield "plain string result"; }
    expect(await drainIterableAgent(gen())).toBe("plain string result");
  });
});

// ---------------------------------------------------------------------------
// drainPromiseResult — split function tests (item 4)
// ---------------------------------------------------------------------------

describe("drainPromiseResult", () => {
  it("returns a string result as-is", () => {
    expect(drainPromiseResult("direct string")).toBe("direct string");
  });

  it("extracts output from { output: string }", () => {
    expect(drainPromiseResult({ output: "extracted" })).toBe("extracted");
  });

  it("JSON-stringifies non-string output in { output: unknown }", () => {
    expect(drainPromiseResult({ output: [1, 2, 3] })).toBe(JSON.stringify([1, 2, 3]));
  });

  it("JSON-stringifies arbitrary objects", () => {
    expect(drainPromiseResult({ some: "object" })).toBe(JSON.stringify({ some: "object" }));
  });

  it("returns empty string for undefined", () => {
    expect(drainPromiseResult(undefined)).toBe("");
  });

  it("JSON-stringifies null (preserves original behavior)", () => {
    // The original drainAgent returned JSON.stringify(null) === "null" for non-undefined values.
    expect(drainPromiseResult(null)).toBe("null");
  });
});

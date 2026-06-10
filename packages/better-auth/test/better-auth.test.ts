import { describe, it, expect } from "vitest";
import { betterAuthPort } from "@eidentic/better-auth";
import type { BetterAuthLike } from "@eidentic/better-auth";
import { Agent } from "@eidentic/core";
import { MockModel, InMemoryStore } from "@eidentic/types/testing";
import { createServer } from "@eidentic/server";
import type { ModelResponse } from "@eidentic/types";

// ---------------------------------------------------------------------------
// Fake BetterAuthLike helpers
// ---------------------------------------------------------------------------

function makeFake(
  response: Awaited<ReturnType<BetterAuthLike["getSession"]>>,
): BetterAuthLike {
  return {
    async getSession() {
      return response;
    },
  };
}

function makeThrowing(): BetterAuthLike {
  return {
    async getSession() {
      throw new Error("DB unavailable");
    },
  };
}

// ---------------------------------------------------------------------------
// Unit tests — betterAuthPort authenticate
// ---------------------------------------------------------------------------

describe("betterAuthPort — authenticate", () => {
  const baseReq = {
    method: "POST",
    path: "/v1/agents/demo/query",
    headers: { "cookie": "session=abc123", "authorization": undefined },
  };

  it("returns AuthPrincipal with userId when session is valid", async () => {
    const fake = makeFake({
      user: { id: "user-123" },
      session: { activeOrganizationId: null },
    });
    const port = betterAuthPort(fake);
    const principal = await port.authenticate(baseReq);
    expect(principal).toEqual({ userId: "user-123", orgId: undefined });
  });

  it("sets orgId from session.activeOrganizationId", async () => {
    const fake = makeFake({
      user: { id: "user-456" },
      session: { activeOrganizationId: "org-789" },
    });
    const port = betterAuthPort(fake);
    const principal = await port.authenticate(baseReq);
    expect(principal).toEqual({ userId: "user-456", orgId: "org-789" });
  });

  it("returns null when getSession returns null (no session)", async () => {
    const fake = makeFake(null);
    const port = betterAuthPort(fake);
    const principal = await port.authenticate(baseReq);
    expect(principal).toBeNull();
  });

  it("returns null when user is missing from session result", async () => {
    const fake = makeFake({
      user: null,
      session: { activeOrganizationId: "org-1" },
    });
    const port = betterAuthPort(fake);
    const principal = await port.authenticate(baseReq);
    expect(principal).toBeNull();
  });

  it("is fail-closed: returns null when getSession throws", async () => {
    const port = betterAuthPort(makeThrowing());
    // Must not throw — must return null.
    const principal = await port.authenticate(baseReq);
    expect(principal).toBeNull();
  });

  it("merges principalFrom override into the base principal", async () => {
    const fake = makeFake({
      user: { id: "user-999" },
      session: { activeOrganizationId: "org-from-session" },
    });
    const port = betterAuthPort(fake, {
      principalFrom: ({ session }) => ({
        orgId: "override-" + (session?.activeOrganizationId ?? "none"),
        apiKey: "derived-key",
      }),
    });
    const principal = await port.authenticate(baseReq);
    expect(principal).toEqual({
      userId: "user-999",
      orgId: "override-org-from-session",
      apiKey: "derived-key",
    });
  });

  it("accepts { api: BetterAuthLike } shape (the real better-auth instance shape)", async () => {
    const inner = makeFake({ user: { id: "user-api" }, session: null });
    const port = betterAuthPort({ api: inner });
    const principal = await port.authenticate(baseReq);
    expect(principal).toEqual({ userId: "user-api", orgId: undefined });
  });
});

// ---------------------------------------------------------------------------
// Header record → Headers conversion
// ---------------------------------------------------------------------------

describe("betterAuthPort — header conversion", () => {
  it("passes headers correctly (skips undefined values)", async () => {
    const capturedHeaders: string[] = [];
    const spyFake: BetterAuthLike = {
      async getSession({ headers }) {
        headers.forEach((_v, key) => capturedHeaders.push(key));
        return { user: { id: "u1" }, session: null };
      },
    };

    const port = betterAuthPort(spyFake);
    await port.authenticate({
      method: "GET",
      path: "/",
      headers: {
        "cookie": "token=abc",
        "x-forwarded-for": "1.2.3.4",
        "authorization": undefined, // must be skipped
      },
    });

    expect(capturedHeaders).toContain("cookie");
    expect(capturedHeaders).toContain("x-forwarded-for");
    expect(capturedHeaders).not.toContain("authorization");
  });
});

// ---------------------------------------------------------------------------
// Server integration: betterAuthPort with createServer
// ---------------------------------------------------------------------------

function textResponse(text: string): ModelResponse {
  return {
    content: [{ type: "text", text }],
    usage: { inputTokens: 10, outputTokens: 5 },
  };
}

function parseSseEvents(body: string) {
  const results: Array<{ event: string; data: unknown }> = [];
  const lines = body.split("\n");
  let event = "";
  let data = "";
  for (const line of lines) {
    if (line.startsWith("event:")) {
      event = line.slice("event:".length).trim();
    } else if (line.startsWith("data:")) {
      data = line.slice("data:".length).trim();
    } else if (line === "" && event && data) {
      try {
        results.push({ event, data: JSON.parse(data) });
      } catch {
        results.push({ event, data });
      }
      event = "";
      data = "";
    }
  }
  return results;
}

describe("betterAuthPort — server integration", () => {
  // A fake that returns a session only when the magic header is present.
  const MAGIC = "valid-session-token";
  const sessionFake: BetterAuthLike = {
    async getSession({ headers }) {
      const cookie = headers.get("x-session-token");
      if (cookie === MAGIC) {
        return { user: { id: "server-user-1" }, session: { activeOrganizationId: "org-a" } };
      }
      return null;
    },
  };

  function makeServer() {
    const store = new InMemoryStore();
    const agent = new Agent({
      id: "demo",
      instructions: "Be helpful.",
      model: new MockModel([textResponse("Hello!")]),
      store,
    });
    const app = createServer({
      agents: { demo: agent },
      auth: betterAuthPort(sessionFake),
    });
    return app;
  }

  it("request with valid session reaches agent and returns 200 SSE", async () => {
    const app = makeServer();
    const res = await app.request("/v1/agents/demo/query", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-session-token": MAGIC,
      },
      body: JSON.stringify({ input: "Hi", sessionId: "int-sess-1" }),
    });

    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toMatch(/text\/event-stream/);

    const text = await res.text();
    const events = parseSseEvents(text);
    const types = events.map((e) => e.event);
    expect(types).toContain("result");
    const result = events.find((e) => e.event === "result");
    expect((result?.data as { subtype: string }).subtype).toBe("success");
  });

  it("request without session returns 401", async () => {
    const app = makeServer();
    const res = await app.request("/v1/agents/demo/query", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ input: "Hi" }),
    });

    expect(res.status).toBe(401);
    const body = await res.json() as { error: string };
    expect(body.error).toBe("Unauthorized");
  });

  it("request with wrong token returns 401", async () => {
    const app = makeServer();
    const res = await app.request("/v1/agents/demo/query", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-session-token": "wrong-token",
      },
      body: JSON.stringify({ input: "Hi" }),
    });

    expect(res.status).toBe(401);
  });

  it("fail-closed: throwing auth returns 401 not 500", async () => {
    const throwingFake = makeThrowing();
    const store = new InMemoryStore();
    const agent = new Agent({
      id: "demo",
      instructions: "Be helpful.",
      model: new MockModel([textResponse("Hi!")]),
      store,
    });
    const app = createServer({
      agents: { demo: agent },
      auth: betterAuthPort(throwingFake),
    });

    const res = await app.request("/v1/agents/demo/query", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ input: "Hi" }),
    });

    expect(res.status).toBe(401);
  });
});

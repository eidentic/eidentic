import { describe, it, expect, beforeEach, vi } from "vitest";
import { Agent } from "@eidentic/core";
import type { Tool } from "@eidentic/core";
import { MockModel, InMemoryStore } from "@eidentic/types/testing";
import type { ModelResponse, ContentBlock } from "@eidentic/types";
import { toolUseBlock } from "@eidentic/types";
import { SkillBank, SkillSet } from "@eidentic/skills";
import type { ExecutableSkillDef } from "@eidentic/skills";
import { createStudioApi, createStudio, ApiKeyAuth } from "@eidentic/studio";
import { pricesUpdatedAt } from "@eidentic/model";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function textResponse(text: string): ModelResponse {
  return {
    content: [{ type: "text", text }],
    usage: { inputTokens: 10, outputTokens: 5 },
  };
}

/** Parse raw SSE body text into an array of parsed event objects. */
function parseSseEvents(body: string): Array<{ event: string; data: unknown }> {
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

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------

const AGENT_ID = "studio-agent";
const SESSION_ID = "studio-session-1";

let store: InMemoryStore;
let agent: Agent;
let bank: SkillBank;

/** Minimal no-op sandbox that always returns success (for test-gate only). */
const testSandbox = {
  async run(_code: string, _opts?: unknown) {
    return { stdout: "EIDENTIC_RESULT:null", stderr: "", exitCode: 0 };
  },
};

const agentSkill: ExecutableSkillDef = {
  name: "greet",
  description: "Greets a user.",
  allowedTools: [],
  // code-string skill so agent-authored quarantine security check passes
  tests: [{ name: "greet-test", input: null, check: () => true }],
  code: "console.log('EIDENTIC_RESULT:\"hello\"')",
};

beforeEach(async () => {
  store = new InMemoryStore();
  await store.migrate();
  agent = new Agent({
    id: AGENT_ID,
    instructions: "You are a helpful assistant.",
    model: new MockModel([textResponse("Hello from studio agent!")]),
    store,
  });

  // Seed a block
  await store.upsertBlock(
    { kind: "agent", agentId: AGENT_ID },
    { label: "profile", value: "test user" },
  );

  // Seed a fact
  await store.assertFact(
    { kind: "agent", agentId: AGENT_ID },
    {
      subject: "user",
      predicate: "name",
      object: "Alice",
      validFrom: "2026-01-01T00:00:00.000Z",
    },
  );

  // Seed memory
  await store.indexMemory([
    {
      scope: { kind: "agent", agentId: AGENT_ID },
      id: "m1",
      text: "Alice loves TypeScript",
    },
  ]);

  // Register a quarantined skill (agent-authored, code-string with a fake sandbox)
  bank = new SkillBank({ sandbox: testSandbox });
  const result = await bank.register(agentSkill, { author: "agent" });
  if (!result.ok) throw new Error(`SkillBank.register failed: ${JSON.stringify(result)}`);
});

// ---------------------------------------------------------------------------
// Health
// ---------------------------------------------------------------------------

describe("GET /api/health", () => {
  it("returns {ok:true} without auth", async () => {
    const app = createStudioApi({
      agents: { [AGENT_ID]: agent },
      adminAuth: ApiKeyAuth({ "test-key": { userId: "u1" } }),
    });
    const res = await app.request("/api/health");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean };
    expect(body.ok).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Auth
// ---------------------------------------------------------------------------

describe("Auth enforcement", () => {
  it("requires an explicit NoAuth override in production", () => {
    try {
      vi.stubEnv("NODE_ENV", "production");
      vi.stubEnv("EIDENTIC_ALLOW_NO_AUTH", "");
      expect(() => createStudioApi({ agents: { [AGENT_ID]: agent } })).toThrow(/Studio NoAuth is disabled/);

      vi.stubEnv("EIDENTIC_ALLOW_NO_AUTH", "1");
      expect(() => createStudioApi({ agents: { [AGENT_ID]: agent } })).not.toThrow();
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("returns 401 on protected routes without key", async () => {
    const app = createStudioApi({
      agents: { [AGENT_ID]: agent },
      adminAuth: ApiKeyAuth({ "test-key": { userId: "u1" } }),
    });
    const res = await app.request("/api/agents");
    expect(res.status).toBe(401);
  });

  it("allows access with valid key", async () => {
    const app = createStudioApi({
      agents: { [AGENT_ID]: agent },
      adminAuth: ApiKeyAuth({ "test-key": { userId: "u1" } }),
    });
    const res = await app.request("/api/agents", {
      headers: { authorization: "Bearer test-key" },
    });
    expect(res.status).toBe(200);
  });

  it("never promotes a run-route credential to Studio admin by default", async () => {
    const app = createStudioApi({
      agents: { [AGENT_ID]: agent },
      auth: ApiKeyAuth({ "run-key": { userId: "runner" } }),
    });

    const res = await app.request("http://studio.example/api/agents", {
      headers: { authorization: "Bearer run-key" },
    });
    expect(res.status).toBe(403);
  });

  it("keeps shared run/admin auth behind an explicit unsafe migration option", async () => {
    const app = createStudioApi({
      agents: { [AGENT_ID]: agent },
      auth: ApiKeyAuth({ "legacy-key": { userId: "legacy-admin" } }),
      allowRunAuthAsAdmin: true,
    });

    const denied = await app.request("http://studio.example/api/agents");
    const allowed = await app.request("http://studio.example/api/agents", {
      headers: { authorization: "Bearer legacy-key" },
    });
    expect(denied.status).toBe(401);
    expect(allowed.status).toBe(200);
  });

  it("runs an explicit admin authorizer after authentication", async () => {
    const seen: unknown[] = [];
    const app = createStudioApi({
      agents: { [AGENT_ID]: agent },
      adminAuth: ApiKeyAuth({
        "reader-key": { userId: "reader" },
        "admin-key": { userId: "admin" },
      }),
      authorizeAdmin: (principal, req) => {
        seen.push({ principal, path: new URL(req.url).pathname });
        return principal.userId === "admin";
      },
    });

    const denied = await app.request("/api/agents", {
      headers: { authorization: "Bearer reader-key" },
    });
    const allowed = await app.request("/api/agents", {
      headers: { authorization: "Bearer admin-key" },
    });
    expect(denied.status).toBe(403);
    expect(allowed.status).toBe(200);
    expect(seen).toEqual([
      { principal: { userId: "reader" }, path: "/api/agents" },
      { principal: { userId: "admin" }, path: "/api/agents" },
    ]);
  });

  it("keeps NoAuth in local-only mode unless remote access is explicitly opted in", async () => {
    const safe = createStudioApi({ agents: { [AGENT_ID]: agent } });
    const remote = await safe.request("http://studio.example/api/agents");
    expect(remote.status).toBe(403);

    const optedIn = createStudioApi({
      agents: { [AGENT_ID]: agent },
      allowRemoteNoAuth: true,
    });
    const legacy = await optedIn.request("http://studio.example/api/agents");
    expect(legacy.status).toBe(200);
  });

  it("uses the TCP peer instead of a spoofable localhost Host header", async () => {
    const app = createStudioApi({ agents: { [AGENT_ID]: agent } });
    const remoteNodeEnv = {
      incoming: {
        socket: {
          remoteAddress: "203.0.113.8",
          remotePort: 44321,
          remoteFamily: "IPv4",
        },
      },
    };

    const response = await app.request(
      "http://localhost/api/agents",
      undefined,
      remoteNodeEnv,
    );

    expect(response.status).toBe(403);
  });
});

describe("credential redaction", () => {
  it("redacts ownership credentials and nested query tokens from management responses", async () => {
    await store.createSession({
      id: "credential-session",
      agentId: AGENT_ID,
      apiKey: "raw-session-secret",
      createdAt: "2026-01-01T00:00:00.000Z",
    });
    await store.appendEvents([{
      id: "credential-event",
      sessionId: "credential-session",
      seq: 0,
      kind: "tool_result",
      schemaVersion: 1,
      payload: {
        authorization: "Bearer raw-bearer-secret",
        callbackUrl: "https://example.test/callback?token=raw-query-secret&safe=ok",
        basicAuth: "Basic dXNlcjpwYXNzd29yZA==",
        userInfoUrl: "https://db-user:db-password@example.test/private",
        nested: { apiKey: "raw-nested-secret" },
      },
      createdAt: "2026-01-01T00:00:00.000Z",
    }]);
    const app = createStudioApi({ agents: { [AGENT_ID]: agent } });

    const sessionsText = await (await app.request(`/api/agents/${AGENT_ID}/sessions`)).text();
    const eventsText = await (await app.request(
      `/api/agents/${AGENT_ID}/sessions/credential-session/events`,
    )).text();
    const combined = sessionsText + eventsText;

    expect(combined).not.toContain("raw-session-secret");
    expect(combined).not.toContain("raw-bearer-secret");
    expect(combined).not.toContain("raw-query-secret");
    expect(combined).not.toContain("raw-nested-secret");
    expect(combined).not.toContain("dXNlcjpwYXNzd29yZA==");
    expect(combined).not.toContain("db-user");
    expect(combined).not.toContain("db-password");
    expect(combined).toContain("[REDACTED]");
    expect(eventsText).toContain("safe=ok");
  });
});

// ---------------------------------------------------------------------------
// GET /api/agents
// ---------------------------------------------------------------------------

describe("GET /api/agents", () => {
  it("lists agents without leaking secrets or model keys", async () => {
    const app = createStudioApi({
      agents: { [AGENT_ID]: agent },
      skillBanks: { [AGENT_ID]: bank },
    });
    const res = await app.request("/api/agents");
    expect(res.status).toBe(200);
    const body = (await res.json()) as Array<{
      id: string;
      hasMemory: boolean;
      hasSkills: boolean;
      hasGraph: boolean;
      model?: unknown;
      instructions?: unknown;
      secrets?: unknown;
    }>;
    expect(body).toHaveLength(1);
    const entry = body[0]!;
    expect(entry.id).toBe(AGENT_ID);
    expect(entry.hasMemory).toBe(true);
    expect(entry.hasSkills).toBe(true);
    expect(entry.hasGraph).toBe(true);
    // Must NOT leak model or instructions or secrets
    expect(entry.model).toBeUndefined();
    expect(entry.instructions).toBeUndefined();
    expect(entry.secrets).toBeUndefined();
  });

  it("unknown agent 404", async () => {
    const app = createStudioApi({ agents: { [AGENT_ID]: agent } });
    const res = await app.request("/api/agents/does-not-exist/sessions");
    expect(res.status).toBe(404);
  });
});

// ---------------------------------------------------------------------------
// Sessions
// ---------------------------------------------------------------------------

describe("GET /api/agents/:id/sessions", () => {
  it("lists sessions after a run", async () => {
    // Run the agent to create a session — consume the body to ensure streaming completes
    const app = createStudio({
      agents: { [AGENT_ID]: agent },
    });
    const runRes = await app.request(`/v1/agents/${AGENT_ID}/query`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ input: "Hello", sessionId: SESSION_ID }),
    });
    await runRes.text(); // consume SSE stream so session is fully committed

    const res = await app.request(`/api/agents/${AGENT_ID}/sessions`);
    expect(res.status).toBe(200);
    const sessions = (await res.json()) as Array<{ id: string; agentId: string }>;
    expect(sessions.some((s) => s.id === SESSION_ID)).toBe(true);
    expect(sessions.every((s) => s.agentId === AGENT_ID)).toBe(true);
  });

  it("respects ?limit=1", async () => {
    // Seed two sessions directly
    await store.createSession({ id: "s-old", agentId: AGENT_ID, createdAt: "2026-01-01T00:00:00.000Z" });
    await store.createSession({ id: "s-new", agentId: AGENT_ID, createdAt: "2026-02-01T00:00:00.000Z" });

    const app = createStudioApi({ agents: { [AGENT_ID]: agent } });
    const res = await app.request(`/api/agents/${AGENT_ID}/sessions?limit=1`);
    const sessions = (await res.json()) as Array<{ id: string }>;
    expect(sessions).toHaveLength(1);
    expect(sessions[0]!.id).toBe("s-new");
  });
});

// ---------------------------------------------------------------------------
// Events / trace
// ---------------------------------------------------------------------------

describe("GET /api/agents/:id/sessions/:sid/events", () => {
  it("returns events for a session after a run", async () => {
    const app = createStudio({ agents: { [AGENT_ID]: agent } });
    const runRes = await app.request(`/v1/agents/${AGENT_ID}/query`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ input: "Hello", sessionId: SESSION_ID }),
    });
    await runRes.text(); // consume SSE stream so events are fully written

    const res = await app.request(`/api/agents/${AGENT_ID}/sessions/${SESSION_ID}/events`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { events: unknown[] };
    expect(Array.isArray(body.events)).toBe(true);
    expect(body.events.length).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// Blocks — list + PUT (CAS)
// ---------------------------------------------------------------------------

describe("GET /api/agents/:id/blocks", () => {
  it("lists blocks in agent scope", async () => {
    const app = createStudioApi({ agents: { [AGENT_ID]: agent } });
    const res = await app.request(`/api/agents/${AGENT_ID}/blocks`);
    expect(res.status).toBe(200);
    const blocks = (await res.json()) as Array<{ label: string; value: string }>;
    expect(blocks.some((b) => b.label === "profile")).toBe(true);
  });

  it("lists blocks in user scope with ?userId=", async () => {
    await store.upsertBlock(
      { kind: "user", agentId: AGENT_ID, userId: "u99" },
      { label: "notes", value: "user notes" },
    );
    const app = createStudioApi({ agents: { [AGENT_ID]: agent } });
    const res = await app.request(`/api/agents/${AGENT_ID}/blocks?userId=u99`);
    expect(res.status).toBe(200);
    const blocks = (await res.json()) as Array<{ label: string }>;
    expect(blocks.some((b) => b.label === "notes")).toBe(true);
  });
});

describe("PUT /api/agents/:id/blocks/:label", () => {
  it("updates a block and returns the updated block", async () => {
    const app = createStudioApi({ agents: { [AGENT_ID]: agent } });
    const res = await app.request(`/api/agents/${AGENT_ID}/blocks/profile`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ value: "updated user" }),
    });
    expect(res.status).toBe(200);
    const block = (await res.json()) as { label: string; value: string; version: number };
    expect(block.label).toBe("profile");
    expect(block.value).toBe("updated user");
    expect(block.version).toBe(1);
  });

  it("returns 409 on CAS conflict (stale expectVersion)", async () => {
    const app = createStudioApi({ agents: { [AGENT_ID]: agent } });
    // Profile is at version 0; sending expectVersion: 5 should conflict
    const res = await app.request(`/api/agents/${AGENT_ID}/blocks/profile`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ value: "new value", expectVersion: 5 }),
    });
    expect(res.status).toBe(409);
  });

  it("returns 400 on missing value", async () => {
    const app = createStudioApi({ agents: { [AGENT_ID]: agent } });
    const res = await app.request(`/api/agents/${AGENT_ID}/blocks/profile`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ notValue: "oops" }),
    });
    expect(res.status).toBe(400);
  });
});

// ---------------------------------------------------------------------------
// Facts
// ---------------------------------------------------------------------------

describe("GET /api/agents/:id/facts", () => {
  it("returns facts from the graph", async () => {
    const app = createStudioApi({ agents: { [AGENT_ID]: agent } });
    const res = await app.request(`/api/agents/${AGENT_ID}/facts`);
    expect(res.status).toBe(200);
    const facts = (await res.json()) as Array<{ subject: string; object: string }>;
    expect(facts.some((f) => f.subject === "user" && f.object === "Alice")).toBe(true);
  });

  it("filters by ?subject=", async () => {
    const app = createStudioApi({ agents: { [AGENT_ID]: agent } });
    const res = await app.request(`/api/agents/${AGENT_ID}/facts?subject=user`);
    const facts = (await res.json()) as Array<{ subject: string }>;
    expect(facts.every((f) => f.subject === "user")).toBe(true);
  });

  it("returns [] when store has no graph support", async () => {
    // Create a store-like without queryFacts
    const noGraphStore = {
      ...store,
      queryFacts: undefined,
    };
    const noGraphAgent = new Agent({
      id: "no-graph-agent",
      instructions: "No graph",
      model: new MockModel([]),
      store: noGraphStore as unknown as InMemoryStore,
    });
    const app = createStudioApi({ agents: { "no-graph-agent": noGraphAgent } });
    const res = await app.request("/api/agents/no-graph-agent/facts");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Memories
// ---------------------------------------------------------------------------

describe("GET /api/agents/:id/memories", () => {
  it("searches memory with ?q=", async () => {
    const app = createStudioApi({ agents: { [AGENT_ID]: agent } });
    const res = await app.request(`/api/agents/${AGENT_ID}/memories?q=TypeScript`);
    expect(res.status).toBe(200);
    const snippets = (await res.json()) as Array<{ id: string; text: string }>;
    expect(snippets.some((s) => s.id === "m1")).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Skills
// ---------------------------------------------------------------------------

describe("GET /api/agents/:id/skills", () => {
  it("lists executable skills with quarantine status and type='executable'", async () => {
    const app = createStudioApi({
      agents: { [AGENT_ID]: agent },
      skillBanks: { [AGENT_ID]: bank },
    });
    const res = await app.request(`/api/agents/${AGENT_ID}/skills`);
    expect(res.status).toBe(200);
    const skills = (await res.json()) as Array<{ name: string; quarantined: boolean; type: string }>;
    const greet = skills.find((s) => s.name === "greet");
    expect(greet).toBeDefined();
    expect(greet?.quarantined).toBe(true);
    expect(greet?.type).toBe("executable");
  });

  it("returns [] when neither skill bank nor prompt skills configured", async () => {
    const app = createStudioApi({ agents: { [AGENT_ID]: agent } });
    const res = await app.request(`/api/agents/${AGENT_ID}/skills`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual([]);
  });

  it("returns prompt skills (type='prompt') for agent with SkillSet but no bank", async () => {
    const skillSet = SkillSet.fromManifests([
      {
        content: `---\nname: test-skill\ndescription: A test prompt skill.\n---\nDo the thing.`,
        source: "inline:test-skill",
      },
    ]);
    const agentWithSkills = new Agent({
      id: "skills-agent",
      instructions: "I have prompt skills.",
      model: new MockModel([]),
      store: new InMemoryStore(),
      skills: skillSet,
    });
    const app = createStudioApi({ agents: { "skills-agent": agentWithSkills } });
    const res = await app.request(`/api/agents/skills-agent/skills`);
    expect(res.status).toBe(200);
    const skills = (await res.json()) as Array<{ name: string; description: string; type: string }>;
    expect(skills.length).toBe(1);
    expect(skills[0]?.type).toBe("prompt");
    expect(skills[0]?.name).toBe("test-skill");
    expect(skills[0]?.description).toBe("A test prompt skill.");
  });

  it("returns both prompt and executable skills when both configured", async () => {
    const skillSet = SkillSet.fromManifests([
      {
        content: `---\nname: prompt-skill\ndescription: Always in context.\n---\nDo it.`,
        source: "inline:prompt-skill",
      },
    ]);
    const agentWithBoth = new Agent({
      id: "both-agent",
      instructions: "I have both kinds of skills.",
      model: new MockModel([]),
      store: new InMemoryStore(),
      skills: skillSet,
    });
    const app = createStudioApi({
      agents: { "both-agent": agentWithBoth },
      skillBanks: { "both-agent": bank },
    });
    const res = await app.request(`/api/agents/both-agent/skills`);
    expect(res.status).toBe(200);
    const skills = (await res.json()) as Array<{ name: string; type: string; quarantined?: boolean }>;
    expect(skills.some((s) => s.type === "prompt" && s.name === "prompt-skill")).toBe(true);
    expect(skills.some((s) => s.type === "executable" && s.name === "greet")).toBe(true);
  });
});

describe("POST /api/agents/:id/skills/:skillId/approve", () => {
  it("approves a quarantined skill", async () => {
    const app = createStudioApi({
      agents: { [AGENT_ID]: agent },
      skillBanks: { [AGENT_ID]: bank },
    });
    const approveRes = await app.request(`/api/agents/${AGENT_ID}/skills/greet/approve`, {
      method: "POST",
    });
    expect(approveRes.status).toBe(200);
    const body = (await approveRes.json()) as { approved: boolean; name: string };
    expect(body.approved).toBe(true);
    expect(body.name).toBe("greet");

    // Now the skill should not be quarantined
    const skillsRes = await app.request(`/api/agents/${AGENT_ID}/skills`);
    const skills = (await skillsRes.json()) as Array<{ name: string; quarantined: boolean; type: string }>;
    const greet = skills.find((s) => s.name === "greet");
    expect(greet?.quarantined).toBe(false);
    expect(greet?.type).toBe("executable");
  });

  it("returns 404 for unknown skill", async () => {
    const app = createStudioApi({
      agents: { [AGENT_ID]: agent },
      skillBanks: { [AGENT_ID]: bank },
    });
    const res = await app.request(`/api/agents/${AGENT_ID}/skills/does-not-exist/approve`, {
      method: "POST",
    });
    expect(res.status).toBe(404);
  });
});

// ---------------------------------------------------------------------------
// GET /api/agents (with toolCount)
// ---------------------------------------------------------------------------

describe("GET /api/agents — toolCount", () => {
  it("includes toolCount on each agent summary", async () => {
    const app = createStudioApi({ agents: { [AGENT_ID]: agent } });
    const res = await app.request("/api/agents");
    expect(res.status).toBe(200);
    const body = (await res.json()) as Array<{ id: string; toolCount: number }>;
    const entry = body.find((a) => a.id === AGENT_ID);
    expect(entry).toBeDefined();
    // Agent has no tools configured → toolCount should be 0
    expect(typeof entry!.toolCount).toBe("number");
    expect(entry!.toolCount).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// GET /api/agents/:id — detail endpoint
// ---------------------------------------------------------------------------

describe("GET /api/agents/:id", () => {
  it("returns agent detail with tools, model, instructions", async () => {
    const app = createStudioApi({ agents: { [AGENT_ID]: agent } });
    const res = await app.request(`/api/agents/${AGENT_ID}`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      id: string;
      instructions: string;
      model: unknown;
      tools: Array<{ name: string; description: string }>;
      hasMemory: boolean;
      hasSkills: boolean;
      hasGraph: boolean;
    };
    expect(body.id).toBe(AGENT_ID);
    expect(body.instructions).toBe("You are a helpful assistant.");
    // tools must be an array
    expect(Array.isArray(body.tools)).toBe(true);
    // hasMemory / hasSkills / hasGraph should be present
    expect(typeof body.hasMemory).toBe("boolean");
    expect(typeof body.hasSkills).toBe("boolean");
    expect(typeof body.hasGraph).toBe("boolean");
  });

  it("does not leak secrets (no 'secrets' field)", async () => {
    const app = createStudioApi({ agents: { [AGENT_ID]: agent } });
    const res = await app.request(`/api/agents/${AGENT_ID}`);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body["secrets"]).toBeUndefined();
  });

  it("returns 404 for unknown agent", async () => {
    const app = createStudioApi({ agents: { [AGENT_ID]: agent } });
    const res = await app.request("/api/agents/does-not-exist");
    expect(res.status).toBe(404);
  });

  it("returns 401 for unauthenticated request when admin auth is configured", async () => {
    const app = createStudioApi({
      agents: { [AGENT_ID]: agent },
      adminAuth: ApiKeyAuth({ "test-key": { userId: "u1" } }),
    });
    const res = await app.request(`/api/agents/${AGENT_ID}`);
    expect(res.status).toBe(401);
  });

  it("toolCount in list equals tools.length in detail", async () => {
    const app = createStudioApi({ agents: { [AGENT_ID]: agent } });
    const listRes = await app.request("/api/agents");
    const list = (await listRes.json()) as Array<{ id: string; toolCount: number }>;
    const summary = list.find((a) => a.id === AGENT_ID)!;

    const detailRes = await app.request(`/api/agents/${AGENT_ID}`);
    const detail = (await detailRes.json()) as { tools: unknown[] };

    expect(summary.toolCount).toBe(detail.tools.length);
  });
});

// ---------------------------------------------------------------------------
// createStudio — combined run + management
// ---------------------------------------------------------------------------

describe("createStudio — combined run + management", () => {
  it("SSE run route works alongside studio API", async () => {
    const combinedStore = new InMemoryStore();
    const combinedAgent = new Agent({
      id: "combined",
      instructions: "Combined agent",
      model: new MockModel([textResponse("combined response")]),
      store: combinedStore,
    });
    const app = createStudio({ agents: { combined: combinedAgent } });

    // Run — consume full SSE body
    const runRes = await app.request("/v1/agents/combined/query", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ input: "Hello", sessionId: "combined-session" }),
    });
    expect(runRes.status).toBe(200);
    const body = await runRes.text(); // consume stream
    const events = parseSseEvents(body);
    expect(events.some((e) => e.event === "result")).toBe(true);

    // Studio health
    const healthRes = await app.request("/api/health");
    expect(healthRes.status).toBe(200);

    // Studio sessions
    const sessRes = await app.request("/api/agents/combined/sessions");
    expect(sessRes.status).toBe(200);
    const sessions = (await sessRes.json()) as Array<{ id: string }>;
    expect(sessions.some((s) => s.id === "combined-session")).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Backend shape-pinning tests — pin the SSE event/field shapes the UI depends on.
// A future shape change in core/server will be caught here before it silently
// breaks the RunView rendering.
// ---------------------------------------------------------------------------

describe("SSE event shape pinning", () => {
  it("stored events endpoint returns events with kind + payload fields", async () => {
    const app = createStudio({ agents: { [AGENT_ID]: agent } });
    const runRes = await app.request(`/v1/agents/${AGENT_ID}/query`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ input: "Hello", sessionId: SESSION_ID }),
    });
    await runRes.text();

    const res = await app.request(`/api/agents/${AGENT_ID}/sessions/${SESSION_ID}/events`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { events: Array<Record<string, unknown>> };
    expect(Array.isArray(body.events)).toBe(true);
    for (const ev of body.events) {
      expect(typeof ev["kind"]).toBe("string");
      expect("payload" in ev).toBe(true);
    }
  });

  it("tool-using run SSE stream contains a 'tool.result' event with toolName + output in payload", async () => {
    // Build a tool-using agent: first response uses the tool, second is a text terminal.
    // Construct a raw Tool object (no zod dep needed) that echoes its input back.
    const echoTool: Tool = {
      id: "echo",
      description: "Echoes input",
      sideEffect: "read-only",
      jsonSchema: { type: "object", properties: { msg: { type: "string" } }, required: ["msg"] },
      parse: (input) => ({ ok: true, value: input }),
      execute: async (input) => ({ echoed: (input as Record<string, unknown>)["msg"] }),
    };

    const toolUsingStore = new InMemoryStore();
    const toolUsingAgent = new Agent({
      id: "tool-agent",
      instructions: "Use the echo tool",
      model: new MockModel([
        // Turn 1: tool_use
        { content: [toolUseBlock("call-1", "echo", { msg: "hello" })], usage: { inputTokens: 5, outputTokens: 3 } },
        // Turn 2: terminal text
        { content: [{ type: "text", text: "Done" }], usage: { inputTokens: 5, outputTokens: 2 } },
      ]),
      tools: [echoTool],
      store: toolUsingStore,
    });

    const app = createStudio({ agents: { "tool-agent": toolUsingAgent } });
    const runRes = await app.request("/v1/agents/tool-agent/query", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ input: "Echo hello", sessionId: "tool-session" }),
    });
    expect(runRes.status).toBe(200);
    const body = await runRes.text();
    const events = parseSseEvents(body);

    // The SSE stream must contain an event with event name "tool.result" (dotted, not underscored).
    const toolResultEvent = events.find((e) => e.event === "tool.result");
    expect(toolResultEvent).toBeDefined();

    // The payload must contain toolName and output — the exact fields RunView reads.
    const payload = toolResultEvent!.data as Record<string, unknown>;
    expect(typeof payload["toolName"]).toBe("string");
    expect(payload["toolName"]).toBe("echo");
    expect("output" in payload).toBe(true);
    expect("isError" in payload).toBe(true);
    expect(payload["isError"]).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Cost / usage endpoints
// ---------------------------------------------------------------------------

describe("GET /api/agents/:id/sessions — usage + usd enrichment", () => {
  it("includes usage and usd on each session after a run", async () => {
    // Use "claude-3-haiku" which is in defaultPrices: { inputPerMTok: 0.25, outputPerMTok: 1.25 }.
    // MockModel returns { inputTokens: 100, outputTokens: 40 }.
    // Expected usd = (100 * 0.25 + 40 * 1.25) / 1_000_000 = 75 / 1_000_000 = 0.000075
    const costStore = new InMemoryStore();
    await costStore.migrate();
    const costAgent = new Agent({
      id: "cost-agent",
      instructions: "Cost test agent",
      model: new MockModel([
        { content: [{ type: "text", text: "hi" }], usage: { inputTokens: 100, outputTokens: 40 } },
      ]),
      store: costStore,
      modelId: "claude-3-haiku",
    });
    const app = createStudio({ agents: { "cost-agent": costAgent } });

    // Run
    const runRes = await app.request("/v1/agents/cost-agent/query", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ input: "Hello", sessionId: "cost-session-1" }),
    });
    await runRes.text(); // consume stream

    // Sessions list
    const sessRes = await app.request("/api/agents/cost-agent/sessions");
    expect(sessRes.status).toBe(200);
    const sessions = (await sessRes.json()) as Array<{
      id: string;
      usage?: { inputTokens: number; outputTokens: number; cachedInputTokens: number; messages: number };
      usd?: number;
    }>;
    const s = sessions.find((s) => s.id === "cost-session-1");
    expect(s).toBeDefined();
    expect(s!.usage).toBeDefined();
    expect(s!.usage!.inputTokens).toBe(100);
    expect(s!.usage!.outputTokens).toBe(40);
    expect(s!.usage!.cachedInputTokens).toBe(0);
    expect(s!.usage!.messages).toBe(1);
    expect(s!.usd).toBeCloseTo(0.000075, 10);
  });

  it("usd is undefined when model has no price in the price table", async () => {
    const costStore = new InMemoryStore();
    await costStore.migrate();
    const nopriceAgent = new Agent({
      id: "noprice-agent",
      instructions: "No price agent",
      model: new MockModel([
        { content: [{ type: "text", text: "hi" }], usage: { inputTokens: 50, outputTokens: 20 } },
      ]),
      store: costStore,
      // modelId not in defaultPrices → usd should be undefined
      modelId: "some-unknown-model-xyz",
    });
    const app = createStudio({ agents: { "noprice-agent": nopriceAgent } });
    const runRes = await app.request("/v1/agents/noprice-agent/query", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ input: "Hello", sessionId: "noprice-session" }),
    });
    await runRes.text();

    const sessRes = await app.request("/api/agents/noprice-agent/sessions");
    const sessions = (await sessRes.json()) as Array<{ id: string; usd?: number }>;
    const s = sessions.find((s) => s.id === "noprice-session");
    expect(s).toBeDefined();
    expect(s!.usd).toBeUndefined();
  });
});

describe("GET /api/agents/:id/cost — per-agent aggregate", () => {
  it("aggregates tokens + usd across multiple sessions", async () => {
    // 2 sessions, each with 100 inputTokens + 40 outputTokens at claude-3-haiku.
    // Total usd = 2 * 0.000075 = 0.000150
    const costStore2 = new InMemoryStore();
    await costStore2.migrate();
    const costAgent2 = new Agent({
      id: "cost-agent2",
      instructions: "Cost aggregate test",
      model: new MockModel([
        { content: [{ type: "text", text: "r1" }], usage: { inputTokens: 100, outputTokens: 40 } },
        { content: [{ type: "text", text: "r2" }], usage: { inputTokens: 100, outputTokens: 40 } },
      ]),
      store: costStore2,
      modelId: "claude-3-haiku",
    });
    const app = createStudio({ agents: { "cost-agent2": costAgent2 } });

    // Session 1
    const r1 = await app.request("/v1/agents/cost-agent2/query", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ input: "Hello", sessionId: "ca2-s1" }),
    });
    await r1.text();

    // Session 2
    const r2 = await app.request("/v1/agents/cost-agent2/query", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ input: "Hello again", sessionId: "ca2-s2" }),
    });
    await r2.text();

    // Cost aggregate
    const costRes = await app.request("/api/agents/cost-agent2/cost");
    expect(costRes.status).toBe(200);
    const body = (await costRes.json()) as {
      inputTokens: number;
      outputTokens: number;
      cachedInputTokens: number;
      usd: number | undefined;
      messages: number;
      sessions: number;
      modelId: string | null;
      pricedFrom: string;
      pricesUpdatedAt: string;
    };

    expect(body.inputTokens).toBe(200);
    expect(body.outputTokens).toBe(80);
    expect(body.cachedInputTokens).toBe(0);
    expect(body.messages).toBe(2);
    expect(body.sessions).toBe(2);
    expect(body.modelId).toBe("claude-3-haiku");
    expect(body.pricedFrom).toBe("default");
    expect(body.pricesUpdatedAt).toBe(pricesUpdatedAt);
    expect(body.usd).toBeCloseTo(0.000150, 10);
  });

  it("allows custom prices via StudioOptions.prices", async () => {
    // Inject a tiny price table with a deterministic price.
    // mock-model-x: inputPerMTok=10, outputPerMTok=20 (no cache)
    // 100 input + 50 output → (100*10 + 50*20) / 1_000_000 = (1000 + 1000) / 1_000_000 = 0.002
    const custStore = new InMemoryStore();
    await custStore.migrate();
    const custAgent = new Agent({
      id: "cust-agent",
      instructions: "Custom price agent",
      model: new MockModel([
        { content: [{ type: "text", text: "ok" }], usage: { inputTokens: 100, outputTokens: 50 } },
      ]),
      store: custStore,
      modelId: "mock-model-x",
    });
    const customPrices = { "mock-model-x": { inputPerMTok: 10, outputPerMTok: 20 } };
    const app = createStudio({ agents: { "cust-agent": custAgent }, prices: customPrices });

    const runRes = await app.request("/v1/agents/cust-agent/query", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ input: "hi", sessionId: "cust-s1" }),
    });
    await runRes.text();

    const costRes = await app.request("/api/agents/cust-agent/cost");
    expect(costRes.status).toBe(200);
    const body = (await costRes.json()) as { usd: number; pricedFrom: string };
    expect(body.pricedFrom).toBe("configured");
    expect(body.usd).toBeCloseTo(0.002, 10);
  });

  it("returns 404 for unknown agent", async () => {
    const app = createStudioApi({ agents: { [AGENT_ID]: agent } });
    const res = await app.request("/api/agents/does-not-exist/cost");
    expect(res.status).toBe(404);
  });
});

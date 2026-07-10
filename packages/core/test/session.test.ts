import { describe, it, expect, vi } from "vitest";
import { InMemoryStore } from "@eidentic/types/testing";
import { StoreConflictError } from "@eidentic/types";
import { Session } from "../src/session.js";

describe("Session", () => {
  it("creates, appends events with monotonic seq, and reloads", async () => {
    const store = new InMemoryStore();
    await store.migrate();

    const s = await Session.open(store, { sessionId: "s1", agentId: "a1", now: () => "t0", newId: ((n) => () => `id${n++}`)(0) });
    await s.append("user", "hello");
    await s.append("assistant", { content: [] });
    expect(s.seq).toBe(2);

    const reloaded = await Session.open(store, { sessionId: "s1", agentId: "a1", now: () => "t1", newId: () => "x" });
    const events = reloaded.events();
    expect(events.map((e) => e.kind)).toEqual(["user", "assistant"]);
    expect(reloaded.seq).toBe(2); // resumes from existing log
  });

  it("Fix 1 — throws StoreConflictError when opening an existing session with a mismatched agentId", async () => {
    const store = new InMemoryStore();
    await store.migrate();

    // Agent A creates the session.
    await Session.open(store, { sessionId: "sx", agentId: "agentA", now: () => "t0", newId: () => "id0" });

    // Agent B tries to open the same session — must throw.
    await expect(
      Session.open(store, { sessionId: "sx", agentId: "agentB", now: () => "t1", newId: () => "id1" }),
    ).rejects.toThrow(StoreConflictError);

    // The error message should identify the session.
    await expect(
      Session.open(store, { sessionId: "sx", agentId: "agentB", now: () => "t1", newId: () => "id1" }),
    ).rejects.toThrow(/session sx belongs to a different agent/);
  });

  it("Fix 1 — opening an existing session with the MATCHING agentId succeeds and replays prior events", async () => {
    const store = new InMemoryStore();
    await store.migrate();

    const s = await Session.open(store, { sessionId: "s2", agentId: "agentA", now: () => "t0", newId: ((n) => () => `e${n++}`)(0) });
    await s.append("user", "first message");

    // Same agent reopening — must succeed.
    const reloaded = await Session.open(store, { sessionId: "s2", agentId: "agentA", now: () => "t1", newId: () => "eX" });
    const events = reloaded.events();
    expect(events.map((e) => e.kind)).toEqual(["user"]);
    expect(reloaded.seq).toBe(1);
  });

  it("Fix 2 — events() returns the cached list; store.readEvents is NOT called after open()", async () => {
    const store = new InMemoryStore();
    await store.migrate();

    const s = await Session.open(store, { sessionId: "s3", agentId: "a1", now: () => "t0", newId: ((n) => () => `id${n++}`)(0) });
    await s.append("user", "hello");

    // Spy AFTER open so we only catch post-open reads.
    const spy = vi.spyOn(store, "readEvents");

    // events() must not call the store.
    const ev = s.events();
    expect(spy).not.toHaveBeenCalled();
    expect(ev.map((e) => e.kind)).toEqual(["user"]);

    // append() pushes onto the cache; subsequent events() still doesn't hit the store.
    await s.append("assistant", { content: [] });
    expect(spy).not.toHaveBeenCalled();
    expect(s.events().map((e) => e.kind)).toEqual(["user", "assistant"]);

    spy.mockRestore();
  });

  // Finding #1 (defense-in-depth) — Session.open rejects cross-tenant access at the core layer.
  it("Finding #1 — throws StoreConflictError when a different userId opens an existing owned session", async () => {
    const store = new InMemoryStore();
    await store.migrate();

    // Alice creates the session.
    await Session.open(store, {
      sessionId: "owned-sess",
      agentId: "a1",
      now: () => "t0",
      newId: () => "id0",
      userId: "alice",
    });

    // Bob tries to open Alice's session with his own userId → must throw.
    await expect(
      Session.open(store, {
        sessionId: "owned-sess",
        agentId: "a1",
        now: () => "t1",
        newId: () => "id1",
        userId: "bob",
      }),
    ).rejects.toThrow(StoreConflictError);

    await expect(
      Session.open(store, {
        sessionId: "owned-sess",
        agentId: "a1",
        now: () => "t1",
        newId: () => "id1",
        userId: "bob",
      }),
    ).rejects.toThrow(/owned by a different principal/);
  });

  it("Finding #1 — same userId can re-open their own session (not accidentally blocked)", async () => {
    const store = new InMemoryStore();
    await store.migrate();

    // Alice creates the session.
    const s = await Session.open(store, {
      sessionId: "alice-sess",
      agentId: "a1",
      now: () => "t0",
      newId: () => "id0",
      userId: "alice",
    });
    await s.append("user", "hello");

    // Alice re-opens her own session — must succeed.
    const reloaded = await Session.open(store, {
      sessionId: "alice-sess",
      agentId: "a1",
      now: () => "t1",
      newId: () => "id1",
      userId: "alice",
    });
    expect(reloaded.events().length).toBe(1);
  });

  it("rejects opening an owned session when the caller provides no identity", async () => {
    const store = new InMemoryStore();
    await store.migrate();

    await Session.open(store, {
      sessionId: "owned-without-caller",
      agentId: "a1",
      now: () => "t0",
      newId: () => "id0",
      userId: "alice",
    });

    await expect(
      Session.open(store, {
        sessionId: "owned-without-caller",
        agentId: "a1",
        now: () => "t1",
        newId: () => "id1",
      }),
    ).rejects.toThrow(/owned by a different principal/);
  });

  it("does not let an org match override a mismatched user owner", async () => {
    const store = new InMemoryStore();
    await store.migrate();

    await Session.open(store, {
      sessionId: "user-and-org-owned",
      agentId: "a1",
      now: () => "t0",
      newId: () => "id0",
      userId: "alice",
      orgId: "acme",
    });

    await expect(
      Session.open(store, {
        sessionId: "user-and-org-owned",
        agentId: "a1",
        now: () => "t1",
        newId: () => "id1",
        userId: "bob",
        orgId: "acme",
      }),
    ).rejects.toThrow(/owned by a different principal/);
  });

  it("H1 — throws StoreConflictError when a different apiKey opens an existing owned session", async () => {
    const store = new InMemoryStore();
    await store.migrate();

    await Session.open(store, {
      sessionId: "apikey-owned-sess",
      agentId: "a1",
      now: () => "t0",
      newId: () => "id0",
      apiKey: "key-a",
    });
    expect((await store.getSession("apikey-owned-sess"))?.apiKey).toMatch(/^eidentic\.credential\.sha256:[0-9a-f]{64}$/);
    expect((await store.getSession("apikey-owned-sess"))?.apiKey).not.toContain("key-a");

    await expect(
      Session.open(store, {
        sessionId: "apikey-owned-sess",
        agentId: "a1",
        now: () => "t1",
        newId: () => "id1",
        apiKey: "key-b",
      }),
    ).rejects.toThrow(StoreConflictError);
  });

  it("upgrades a verified legacy plaintext credential in place", async () => {
    const store = new InMemoryStore();
    await store.createSession({ id: "legacy-key", agentId: "a1", createdAt: "t0", apiKey: "raw-secret" });
    await Session.open(store, {
      sessionId: "legacy-key",
      agentId: "a1",
      now: () => "t1",
      newId: () => "id1",
      apiKey: "raw-secret",
    });
    expect((await store.getSession("legacy-key"))?.apiKey).toMatch(/^eidentic\.credential\.sha256:[0-9a-f]{64}$/);
    expect((await store.getSession("legacy-key"))?.apiKey).not.toContain("raw-secret");
  });

  it("Finding #1 — session with no owner (legacy) is openable by any identity (back-compat)", async () => {
    const store = new InMemoryStore();
    await store.migrate();

    // Create a legacy session with no userId/orgId.
    await store.createSession({ id: "legacy-sess", agentId: "a1", createdAt: "t0" });

    // Bob can open it — back-compat path.
    const s = await Session.open(store, {
      sessionId: "legacy-sess",
      agentId: "a1",
      now: () => "t1",
      newId: () => "id1",
      userId: "bob",
    });
    expect(s.id).toBe("legacy-sess");
  });
});

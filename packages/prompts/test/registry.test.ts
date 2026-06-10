import { describe, it, expect, beforeEach } from "vitest";
import {
  createPromptRegistry,
  memoryPromptStore,
} from "../src/index.js";
import type { PromptRegistry } from "../src/index.js";

// ─── Helpers ──────────────────────────────────────────────────────────────────

function makeRegistry(): PromptRegistry {
  return createPromptRegistry(memoryPromptStore());
}

// ─── register — immutability / dedup ─────────────────────────────────────────

describe("register — immutability and dedup", () => {
  it("returns version 1 for a new prompt", async () => {
    const r = makeRegistry();
    const v = await r.register("greet", "Hello, world!");
    expect(v.version).toBe(1);
    expect(v.name).toBe("greet");
    expect(v.body).toBe("Hello, world!");
    expect(typeof v.hash).toBe("string");
    expect(v.hash).toHaveLength(64); // SHA-256 hex
  });

  it("re-registering the SAME body is a no-op — same version returned", async () => {
    const r = makeRegistry();
    const v1 = await r.register("greet", "Hello, world!");
    const v2 = await r.register("greet", "Hello, world!");
    expect(v2.version).toBe(v1.version);
    expect(v2.hash).toBe(v1.hash);
  });

  it("a new body produces version 2 with a different hash", async () => {
    const r = makeRegistry();
    const v1 = await r.register("greet", "Hello, world!");
    const v2 = await r.register("greet", "Hello, updated world!");
    expect(v2.version).toBe(2);
    expect(v2.hash).not.toBe(v1.hash);
  });

  it("version numbers increment monotonically across multiple changes", async () => {
    const r = makeRegistry();
    const a = await r.register("p", "body a");
    const b = await r.register("p", "body b");
    const c = await r.register("p", "body c");
    expect(a.version).toBe(1);
    expect(b.version).toBe(2);
    expect(c.version).toBe(3);
  });

  it("identical body on DIFFERENT names creates independent version 1s", async () => {
    const r = makeRegistry();
    const a = await r.register("name-a", "shared body");
    const b = await r.register("name-b", "shared body");
    expect(a.version).toBe(1);
    expect(b.version).toBe(1);
    expect(a.hash).toBe(b.hash); // same body → same hash
  });

  it("attaches tags and meta to the version", async () => {
    const r = makeRegistry();
    const v = await r.register("p", "body", {
      tags: { env: "prod" },
      meta: { owner: "alice", ticket: "PROJ-42" },
    });
    expect(v.tags).toEqual({ env: "prod" });
    expect(v.meta).toEqual({ owner: "alice", ticket: "PROJ-42" });
  });
});

// ─── get ─────────────────────────────────────────────────────────────────────

describe("get", () => {
  it("returns latest when ref is undefined", async () => {
    const r = makeRegistry();
    await r.register("p", "v1 body");
    await r.register("p", "v2 body");
    const latest = await r.get("p");
    expect(latest.version).toBe(2);
  });

  it("retrieves a specific version by number", async () => {
    const r = makeRegistry();
    await r.register("p", "v1 body");
    await r.register("p", "v2 body");
    const v1 = await r.get("p", 1);
    expect(v1.body).toBe("v1 body");
  });

  it("throws when the prompt name has no versions", async () => {
    const r = makeRegistry();
    await expect(r.get("nonexistent")).rejects.toThrow(/no versions registered/);
  });

  it("throws when a version number is not found", async () => {
    const r = makeRegistry();
    await r.register("p", "body");
    await expect(r.get("p", 99)).rejects.toThrow(/version 99 not found/);
  });

  it("throws when a tag ref is not found", async () => {
    const r = makeRegistry();
    await r.register("p", "body");
    await expect(r.get("p", "stable")).rejects.toThrow(/tag "stable" not found/);
  });

  it("resolves a tag ref after tagging", async () => {
    const r = makeRegistry();
    await r.register("p", "v1 body");
    await r.tag("p", 1, "stable");
    const v = await r.get("p", "stable");
    expect(v.version).toBe(1);
  });
});

// ─── tag / untag + rollback + audit ──────────────────────────────────────────

describe("tag / untag / rollback / history", () => {
  it("creates a tag on a version", async () => {
    const r = makeRegistry();
    await r.register("p", "body");
    await r.tag("p", 1, "stable");
    const v = await r.get("p", "stable");
    expect(v.version).toBe(1);
  });

  it("moving a tag to an earlier version is a rollback", async () => {
    const r = makeRegistry();
    await r.register("p", "v1 body");
    await r.register("p", "v2 body");
    await r.tag("p", 2, "stable");
    // Rollback: move stable back to v1
    await r.tag("p", 1, "stable");
    const v = await r.get("p", "stable");
    expect(v.version).toBe(1);
    expect(v.body).toBe("v1 body");
  });

  it("untag removes the deployment tag", async () => {
    const r = makeRegistry();
    await r.register("p", "body");
    await r.tag("p", 1, "stable");
    await r.untag("p", "stable");
    await expect(r.get("p", "stable")).rejects.toThrow(/tag "stable" not found/);
  });

  it("untag throws when the tag does not exist", async () => {
    const r = makeRegistry();
    await r.register("p", "body");
    await expect(r.untag("p", "stable")).rejects.toThrow(/tag "stable" not found/);
  });

  it("history records all events in order", async () => {
    const r = makeRegistry();
    await r.register("p", "v1");
    await r.register("p", "v2");
    await r.tag("p", 2, "stable");
    await r.tag("p", 1, "stable"); // rollback
    await r.untag("p", "stable");

    const h = await r.history("p");
    expect(h).toHaveLength(5);
    expect(h[0]!.kind).toBe("version_registered");
    expect(h[1]!.kind).toBe("version_registered");
    expect(h[2]!.kind).toBe("tag_moved");
    expect(h[3]!.kind).toBe("tag_moved");
    expect(h[4]!.kind).toBe("tag_removed");
  });

  it("history tag_moved records fromVersion correctly", async () => {
    const r = makeRegistry();
    await r.register("p", "v1");
    await r.register("p", "v2");
    await r.tag("p", 1, "stable"); // fromVersion = null (new tag)
    await r.tag("p", 2, "stable"); // fromVersion = 1

    const h = await r.history("p");
    const tagEvents = h.filter((e) => e.kind === "tag_moved") as Array<{
      fromVersion: number | null;
      toVersion: number;
      kind: string;
    }>;
    expect(tagEvents[0]!.fromVersion).toBeNull();
    expect(tagEvents[0]!.toVersion).toBe(1);
    expect(tagEvents[1]!.fromVersion).toBe(1);
    expect(tagEvents[1]!.toVersion).toBe(2);
  });

  it("history is scoped to a single prompt name", async () => {
    const r = makeRegistry();
    await r.register("alpha", "a");
    await r.register("beta", "b");
    const h = await r.history("alpha");
    expect(h.every((e) => e.name === "alpha")).toBe(true);
    expect(h).toHaveLength(1);
  });

  it("tag throws when the version does not exist", async () => {
    const r = makeRegistry();
    await r.register("p", "body");
    await expect(r.tag("p", 99, "stable")).rejects.toThrow(/version 99 not found/);
  });
});

// ─── canary ───────────────────────────────────────────────────────────────────

describe("canary", () => {
  it("same key always resolves to the same arm", async () => {
    const r = makeRegistry();
    await r.register("p", "stable body");
    await r.register("p", "candidate body");
    await r.tag("p", 1, "stable");
    await r.tag("p", 2, "candidate");

    const a = await r.canary("p", { stable: "stable", candidate: "candidate", fraction: 0.5, key: "user-123" });
    const b = await r.canary("p", { stable: "stable", candidate: "candidate", fraction: 0.5, key: "user-123" });
    expect(a.arm).toBe(b.arm);
    expect(a.version).toBe(b.version);
  });

  it("fraction=0 → all keys go to stable", async () => {
    const r = makeRegistry();
    await r.register("p", "stable body");
    await r.register("p", "candidate body");
    await r.tag("p", 1, "stable");
    await r.tag("p", 2, "candidate");

    for (let i = 0; i < 50; i++) {
      const result = await r.canary("p", {
        stable: "stable",
        candidate: "candidate",
        fraction: 0,
        key: `key-${i}`,
      });
      expect(result.arm).toBe("stable");
    }
  });

  it("fraction=1 → all keys go to candidate", async () => {
    const r = makeRegistry();
    await r.register("p", "stable body");
    await r.register("p", "candidate body");
    await r.tag("p", 1, "stable");
    await r.tag("p", 2, "candidate");

    for (let i = 0; i < 50; i++) {
      const result = await r.canary("p", {
        stable: "stable",
        candidate: "candidate",
        fraction: 1,
        key: `key-${i}`,
      });
      expect(result.arm).toBe("candidate");
    }
  });

  it("fraction respected within ±5% over 1000 keys", async () => {
    const r = makeRegistry();
    await r.register("p", "stable body");
    await r.register("p", "candidate body");
    await r.tag("p", 1, "stable");
    await r.tag("p", 2, "candidate");

    const KEYS = 1000;
    const FRACTION = 0.1;
    let candidateCount = 0;

    for (let i = 0; i < KEYS; i++) {
      const result = await r.canary("p", {
        stable: "stable",
        candidate: "candidate",
        fraction: FRACTION,
        key: `session-${i}`,
      });
      if (result.arm === "candidate") candidateCount++;
    }

    const actualFraction = candidateCount / KEYS;
    // Allow ±5% absolute tolerance (0.05 to 0.15 for a 10% target)
    expect(actualFraction).toBeGreaterThanOrEqual(FRACTION - 0.05);
    expect(actualFraction).toBeLessThanOrEqual(FRACTION + 0.05);
  });

  it("result includes body and version number", async () => {
    const r = makeRegistry();
    await r.register("p", "stable body");
    await r.register("p", "candidate body");
    await r.tag("p", 1, "stable");
    await r.tag("p", 2, "candidate");

    const result = await r.canary("p", {
      stable: "stable",
      candidate: "candidate",
      fraction: 1, // force candidate
      key: "any",
    });
    expect(result.body).toBe("candidate body");
    expect(result.version).toBe(2);
    expect(result.arm).toBe("candidate");
  });

  it("resolves arms by version number refs too", async () => {
    const r = makeRegistry();
    await r.register("p", "v1 body");
    await r.register("p", "v2 body");

    const result = await r.canary("p", {
      stable: 1,
      candidate: 2,
      fraction: 0,
      key: "any",
    });
    expect(result.arm).toBe("stable");
    expect(result.version).toBe(1);
  });

  it("throws on fraction outside [0, 1]", async () => {
    const r = makeRegistry();
    await r.register("p", "body");
    await expect(
      r.canary("p", { fraction: 1.5, key: "k", stable: 1, candidate: 1 }),
    ).rejects.toThrow(/fraction must be in \[0, 1\]/);
  });
});

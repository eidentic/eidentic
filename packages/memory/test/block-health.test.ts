import { describe, it, expect } from "vitest";
import { InMemoryStore } from "@eidentic/types/testing";
import { Memory } from "../src/memory.js";
import type { Scope } from "@eidentic/types";

const scope: Scope = { kind: "user", agentId: "health-test", userId: "u1" };

describe("Memory.blockHealth", () => {
  it("reports each block's length, limit, fillRatio, isEmpty, and required", async () => {
    const store = new InMemoryStore();
    await store.migrate();
    const mem = new Memory({
      store,
      blocks: {
        human: { value: "", limit: 20 },
        persona: { value: "hi" },
      },
      requiredBlocks: ["human", "missing"],
    });

    const health = await mem.blockHealth(scope);

    // human: empty, required, fillRatio 0
    const human = health.find((b) => b.label === "human");
    expect(human).toBeDefined();
    expect(human?.length).toBe(0);
    expect(human?.limit).toBe(20);
    expect(human?.fillRatio).toBe(0);
    expect(human?.isEmpty).toBe(true);
    expect(human?.required).toBe(true);

    // persona: "hi" = 2 chars, not required, no limit → fillRatio undefined
    const persona = health.find((b) => b.label === "persona");
    expect(persona).toBeDefined();
    expect(persona?.length).toBe(2);
    expect(persona?.limit).toBeUndefined();
    expect(persona?.fillRatio).toBeUndefined();
    expect(persona?.isEmpty).toBe(false);
    expect(persona?.required).toBe(false);

    // missing: synthetic — not in store, but in requiredBlocks
    const missing = health.find((b) => b.label === "missing");
    expect(missing).toBeDefined();
    expect(missing?.length).toBe(0);
    expect(missing?.isEmpty).toBe(true);
    expect(missing?.required).toBe(true);
    expect(missing?.limit).toBeUndefined();
    expect(missing?.fillRatio).toBeUndefined();
  });

  it("fillRatio reflects actual content length vs limit", async () => {
    const store = new InMemoryStore();
    await store.migrate();
    const mem = new Memory({
      store,
      blocks: { bio: { value: "hello", limit: 20 } },
    });

    const health = await mem.blockHealth(scope);
    const bio = health.find((b) => b.label === "bio");
    expect(bio?.length).toBe(5);
    expect(bio?.limit).toBe(20);
    expect(bio?.fillRatio).toBeCloseTo(5 / 20);
    expect(bio?.isEmpty).toBe(false);
  });

  it("returns empty array when no blocks configured and store has none", async () => {
    const store = new InMemoryStore();
    await store.migrate();
    const mem = new Memory({ store });
    const health = await mem.blockHealth(scope);
    expect(health).toEqual([]);
  });

  it("synthetic entry not duplicated when requiredBlock is also in store blocks", async () => {
    const store = new InMemoryStore();
    await store.migrate();
    const mem = new Memory({
      store,
      blocks: { human: { value: "name: Baran", limit: 100 } },
      requiredBlocks: ["human"],
    });

    const health = await mem.blockHealth(scope);
    const humans = health.filter((b) => b.label === "human");
    // human appears only once (from getAlwaysInContext), not as a synthetic duplicate
    expect(humans).toHaveLength(1);
    expect(humans[0]?.required).toBe(true);
  });
});

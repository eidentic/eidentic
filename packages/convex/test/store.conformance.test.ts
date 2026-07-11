// @vitest-environment edge-runtime
import { describe, expect, it } from "vitest";
import { storeConformanceCases } from "@eidentic/types/testing";
import { ConvexStore, defaultStoreFns } from "../src/index.js";
import { makeTestRunner } from "./helpers.js";

describe("ConvexStore store + graph conformance", () => {
  for (const c of storeConformanceCases(() => {
    let n = 0;
    return new ConvexStore(makeTestRunner(), { newId: () => `fact_${(n++).toString(36)}` });
  }))
    it(c.name, c.run);
});

describe("ConvexStore eraseScope wire compatibility", () => {
  it("treats the legacy { scopeKey, agentId } payload as an agent scope", async () => {
    const runner = makeTestRunner();
    const store = new ConvexStore(runner);
    await store.createSession({ id: "legacy-a", agentId: "legacy-agent", userId: "alice", createdAt: "now" });
    await store.createSession({ id: "legacy-b", agentId: "legacy-agent", userId: "bob", createdAt: "now" });

    await runner.mutation(defaultStoreFns().eraseScope, {
      scopeKey: "agent:legacy-agent",
      agentId: "legacy-agent",
    });

    expect(await store.getSession("legacy-a")).toBeNull();
    expect(await store.getSession("legacy-b")).toBeNull();
  });
});

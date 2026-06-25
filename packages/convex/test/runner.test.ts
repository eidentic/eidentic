import { describe, expect, it } from "vitest";
import {
  EidenticComponentStore,
  convexActionRunner,
  defaultStoreFns,
  defaultVectorFns,
  storeFnsFrom,
  vectorFnsFrom,
  type ConvexActionCtxLike,
} from "../src/index.js";

describe("Convex in-process runner helpers", () => {
  it("extracts refs from generated component namespaces", () => {
    const component = {
      functions: {
        ...defaultStoreFns("component/functions"),
        ...defaultVectorFns("component/functions"),
      },
    };

    expect(storeFnsFrom(component).appendEvents).toBe("component/functions:appendEvents");
    expect(vectorFnsFrom(component).vectorSearch).toBe("component/functions:vectorSearch");
  });

  it("builds a runner over ctx.runQuery and ctx.runMutation", async () => {
    const calls: Array<{ kind: string; fn: unknown; args: Record<string, unknown> }> = [];
    const ctx: ConvexActionCtxLike = {
      runQuery: async (fn, args) => {
        calls.push({ kind: "query", fn, args });
        return "query-result";
      },
      runMutation: async (fn, args) => {
        calls.push({ kind: "mutation", fn, args });
        return "mutation-result";
      },
    };

    const runner = convexActionRunner(ctx);
    await expect(runner.query("q", { x: 1 })).resolves.toBe("query-result");
    await expect(runner.mutation("m", { y: 2 })).resolves.toBe("mutation-result");

    expect(calls).toEqual([
      { kind: "query", fn: "q", args: { x: 1 } },
      { kind: "mutation", fn: "m", args: { y: 2 } },
    ]);
  });

  it("lets EidenticComponentStore call component function refs without host-side mapping", async () => {
    const calls: Array<{ fn: unknown; args: Record<string, unknown> }> = [];
    const ctx: ConvexActionCtxLike = {
      runQuery: async (fn, args) => {
        calls.push({ fn, args });
        return [];
      },
      runMutation: async () => null,
    };

    const store = new EidenticComponentStore(ctx, {
      functions: defaultStoreFns("component/functions"),
    });

    await expect(store.getBlocks({ kind: "agent", agentId: "agent1" })).resolves.toEqual([]);
    expect(calls).toEqual([
      { fn: "component/functions:getBlocks", args: { scopeKey: "agent:agent1" } },
    ]);
  });
});

// @vitest-environment edge-runtime
import { beforeEach, describe, expect, it } from "vitest";
import { convexTest } from "convex-test";
import schema from "./convex/schema.js";
import {
  ConvexStore,
  ConvexVectorStore,
  defaultStoreFns,
  defaultVectorFns,
  eidenticFunctions,
  type ConvexRunner,
  type EidenticAuthorize,
} from "../src/index.js";
import { authState } from "./convex/authorized.js";

const modules = import.meta.glob("./convex/**/*.ts");

/**
 * A runner over a fresh convex-test instance whose store/vector function refs target the
 * "authorized:*" module (the `eidenticFunctions({ authorize })` copies in ./convex/authorized.ts),
 * rather than the bare "eidentic:*" exports.
 */
function makeAuthorizedRunner(): ConvexRunner {
  const t = convexTest(schema, modules);
  return {
    query: (fn, args) => t.query(fn as never, args as never),
    mutation: (fn, args) => t.mutation(fn as never, args as never),
    action: (fn, args) => t.action(fn as never, args as never),
  };
}

function authorizedStore(): ConvexStore {
  return new ConvexStore(makeAuthorizedRunner(), { fns: defaultStoreFns("authorized") });
}

function authorizedVectorStore(): ConvexVectorStore {
  return new ConvexVectorStore(makeAuthorizedRunner(), { fns: defaultVectorFns("authorized") });
}

function defaultDeniedStore(): ConvexStore {
  return new ConvexStore(makeAuthorizedRunner(), { fns: defaultStoreFns("denied") });
}

const scope = { kind: "agent", agentId: "a1" } as const;

describe("eidenticFunctions authorize hook", () => {
  beforeEach(() => {
    // Reset the shared control surface between cases.
    authState.mode = "allow";
    authState.calls.length = 0;
  });

  it("REJECTS a query op when authorize throws", async () => {
    authState.mode = "deny";
    const store = authorizedStore();
    await expect(store.getBlocks(scope)).rejects.toThrow(/unauthorized/);
  });

  it("REJECTS a mutation op when authorize throws (handler body never runs)", async () => {
    const store = authorizedStore();

    // First allow an upsert so a block exists.
    await store.upsertBlock(scope, { label: "profile", value: "v0" });

    // Now deny: the next write must be rejected and must NOT mutate state.
    authState.mode = "deny";
    await expect(store.upsertBlock(scope, { label: "profile", value: "v1" })).rejects.toThrow(
      /unauthorized/,
    );

    // Re-allow and confirm the denied write did not take effect.
    authState.mode = "allow";
    const block = await store.getBlock(scope, "profile");
    expect(block?.value).toBe("v0");
  });

  it("ALLOWS the op when authorize does not throw, and the op succeeds", async () => {
    const store = authorizedStore();
    await store.upsertBlock(scope, { label: "profile", value: "hello" });
    const block = await store.getBlock(scope, "profile");
    expect(block?.value).toBe("hello");
  });

  it("passes info.op and info.args (incl. scopeKey) to the hook", async () => {
    const store = authorizedStore();
    await store.getBlocks(scope);

    const last = authState.calls.at(-1);
    expect(last?.op).toBe("getBlocks");
    // scopeKey is derived by the client; the agent scope serializes to "agent:a1".
    expect(last?.args["scopeKey"]).toBe("agent:a1");
  });

  it("passes idempotency ownership metadata to the hook and stores it", async () => {
    const store = authorizedStore();
    await store.recordIntent("sess1:send_email:a@test.com", "hash1", {
      sessionId: "sess1",
      ownerKey: "user:u1",
    });

    const last = authState.calls.at(-1);
    expect(last?.op).toBe("recordIntent");
    expect(last?.args["sessionId"]).toBe("sess1");
    expect(last?.args["ownerKey"]).toBe("user:u1");

    const row = await store.getIdempotency("sess1:send_email:a@test.com", { sessionId: "sess1" });
    expect(row?.sessionId).toBe("sess1");
    expect(row?.ownerKey).toBe("user:u1");
  });

  it("guards vector ops too", async () => {
    const vectors = authorizedVectorStore();
    authState.mode = "deny";
    await expect(vectors.list("agent:a1")).rejects.toThrow(/unauthorized/);
    expect(authState.calls.at(-1)?.op).toBe("vectorList");
  });

  it("without an authorize hook, the factory builds a complete fail-closed function map", () => {
    const fns = eidenticFunctions();
    const names = Object.keys(fns);
    expect(names).toContain("getBlocks");
    expect(names).toContain("vectorUpsert");
    expect(names).toContain("migrateLegacyScope");
    expect(names.length).toBe(37);
  });

  it("denies a public invocation when no authorize hook is configured", async () => {
    await expect(defaultDeniedStore().getBlocks(scope)).rejects.toThrow(
      /configure eidenticFunctions\(\{ authorize \}\)/,
    );
  });

  it("requires an explicit unsafe compatibility opt-in for unauthenticated handlers", () => {
    const fns = eidenticFunctions({ unsafeAllowUnauthenticated: true });
    expect(Object.keys(fns)).toHaveLength(37);
  });

  it("accepts an async authorize that resolves to allow", async () => {
    // Type-level smoke check that an async hook is assignable.
    const asyncAuth: EidenticAuthorize = async () => {
      await Promise.resolve();
    };
    expect(typeof asyncAuth).toBe("function");
  });
});

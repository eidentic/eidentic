import { beforeEach, describe, expect, it } from "vitest";
import { ConvexHttpClient } from "convex/browser";
import { anyApi } from "convex/server";
import {
  durableConformanceCases,
  storeConformanceCases,
  vectorConformanceCases,
} from "@eidentic/types/testing";
import {
  ConvexStore,
  ConvexVectorStore,
  convexHttpRunner,
} from "../src/index.js";

// Hits a real Convex backend. The target must be a disposable test deployment exposing the
// test-only reset:all mutation; never point this suite at shared development or production data.
const url = process.env["EIDENTIC_TEST_CONVEX_URL"];
const live = url ? describe : describe.skip;
const client = url ? new ConvexHttpClient(url) : undefined;
const runner = client ? convexHttpRunner(client) : undefined;

beforeEach(async () => {
  if (!client) return;
  await client.mutation(anyApi.reset.all, {});
});

live("ConvexStore conformance (live Convex backend)", () => {
  for (const testCase of storeConformanceCases(() => {
    if (!runner) throw new Error("live Convex runner is not configured");
    return new ConvexStore(runner);
  })) it(testCase.name, testCase.run, 30_000);
});

live("ConvexStore durable conformance (live Convex backend)", () => {
  for (const testCase of durableConformanceCases(() => {
    if (!runner) throw new Error("live Convex runner is not configured");
    return new ConvexStore(runner);
  })) it(testCase.name, testCase.run, 30_000);
});

live("ConvexVectorStore conformance (live Convex backend)", () => {
  for (const testCase of vectorConformanceCases(() => {
    if (!runner) throw new Error("live Convex runner is not configured");
    return new ConvexVectorStore(runner);
  })) it(testCase.name, testCase.run, 30_000);
});

live("Convex public authorization boundary (live Convex backend)", () => {
  it("denies the bare public handler when no authorization hook is configured", async () => {
    await expect(
      client!.query(anyApi.denied.getSessionWithoutAuthorization, { id: "missing" }),
    ).rejects.toThrow(/denied|authorize/i);
  });
});

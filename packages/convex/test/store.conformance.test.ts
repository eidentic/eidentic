// @vitest-environment edge-runtime
import { describe, it } from "vitest";
import { storeConformanceCases } from "@eidentic/types/testing";
import { ConvexStore } from "../src/index.js";
import { makeTestRunner } from "./helpers.js";

describe("ConvexStore store + graph conformance", () => {
  for (const c of storeConformanceCases(() => {
    let n = 0;
    return new ConvexStore(makeTestRunner(), { newId: () => `fact_${(n++).toString(36)}` });
  }))
    it(c.name, c.run);
});

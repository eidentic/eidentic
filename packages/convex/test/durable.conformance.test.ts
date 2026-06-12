// @vitest-environment edge-runtime
import { describe, it } from "vitest";
import { durableConformanceCases } from "@eidentic/types/testing";
import { ConvexStore } from "../src/index.js";
import { makeTestRunner } from "./helpers.js";

describe("ConvexStore durable conformance", () => {
  for (const c of durableConformanceCases(() => new ConvexStore(makeTestRunner())))
    it(c.name, c.run);
});

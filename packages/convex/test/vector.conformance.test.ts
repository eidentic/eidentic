// @vitest-environment edge-runtime
import { describe, it } from "vitest";
import { vectorConformanceCases } from "@eidentic/types/testing";
import { ConvexVectorStore } from "../src/index.js";
import { makeTestRunner } from "./helpers.js";

describe("ConvexVectorStore vector conformance", () => {
  for (const c of vectorConformanceCases(() => new ConvexVectorStore(makeTestRunner())))
    it(c.name, c.run);
});

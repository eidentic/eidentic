import { describe, it } from "vitest";
import { LibsqlStore } from "../src/index.js";
import { storeConformanceCases, durableConformanceCases } from "@eidentic/types/testing";

describe("LibsqlStore store conformance", () => {
  for (const c of storeConformanceCases(() => new LibsqlStore(":memory:")))
    it(c.name, c.run);
});

describe("LibsqlStore durable conformance", () => {
  for (const c of durableConformanceCases(() => new LibsqlStore(":memory:")))
    it(c.name, c.run);
});

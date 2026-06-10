import { describe, it } from "vitest";
import { scorerConformanceCases } from "../src/conformance.js";

describe("deterministic scorer conformance", () => {
  for (const c of scorerConformanceCases()) it(c.name, () => c.run());
});

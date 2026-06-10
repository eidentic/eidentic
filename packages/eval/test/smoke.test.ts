import { describe, it, expect } from "vitest";
import { EVAL_PACKAGE } from "../src/index.js";

describe("@eidentic/eval scaffold", () => {
  it("is wired into the workspace and picked up by root vitest", () => {
    expect(EVAL_PACKAGE).toBe("@eidentic/eval");
  });
});

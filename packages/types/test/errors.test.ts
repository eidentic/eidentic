import { describe, it, expect } from "vitest";
import { EidenticError, BudgetError } from "../src/errors.js";

describe("error taxonomy", () => {
  it("BudgetError carries class/code/retryable", () => {
    const e = new BudgetError("max_turns", "hit turn cap");
    expect(e).toBeInstanceOf(EidenticError);
    expect(e.class).toBe("budget");
    expect(e.code).toBe("budget.max_turns");
    expect(e.retryable).toBe(false);
    expect(e.message).toBe("hit turn cap");
  });

  it("BudgetError max_wall_clock discriminant matches TerminationSubtype (C-P1-2)", () => {
    const e = new BudgetError("max_wall_clock", "wall clock exceeded");
    expect(e.code).toBe("budget.max_wall_clock");
    // The kind literal must align with the TerminationSubtype "max_wall_clock" used by the loop.
    // Previously "max_wallclock" (missing underscore) — fixed to match protocol.ts exactly.
  });
});

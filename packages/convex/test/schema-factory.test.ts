import { describe, expect, it } from "vitest";
import {
  DEFAULT_EIDENTIC_TABLE_NAMES,
  SINGULAR_EIDENTIC_TABLE_NAMES,
  createEidenticTableNames,
  createEidenticTables,
} from "../src/schema.js";

describe("Convex schema table-name helpers", () => {
  it("preserves legacy table names by default", () => {
    expect(createEidenticTableNames()).toEqual(DEFAULT_EIDENTIC_TABLE_NAMES);
  });

  it("generates prefixed singular snake_case names for app-functions installs", () => {
    expect(createEidenticTableNames({ prefix: "eidentic_" })).toEqual({
      session: "eidentic_session",
      event: "eidentic_event",
      block: "eidentic_block",
      blockHistory: "eidentic_block_history",
      memory: "eidentic_memory",
      fact: "eidentic_fact",
      vector: "eidentic_vector",
      checkpoint: "eidentic_checkpoint",
      idempotency: "eidentic_idempotency",
      decision: "eidentic_decision",
    });
  });

  it("allows explicit table-name overrides", () => {
    const names = createEidenticTableNames({
      prefix: "eidentic_",
      names: { session: "ai_session", blockHistory: "ai_block_history" },
    });

    expect(names.session).toBe("ai_session");
    expect(names.blockHistory).toBe("ai_block_history");
    expect(names.event).toBe("eidentic_event");
  });

  it("creates table definitions under the requested names", () => {
    const tables = createEidenticTables({ names: SINGULAR_EIDENTIC_TABLE_NAMES });

    expect(Object.keys(tables)).toEqual([
      "session",
      "event",
      "block",
      "block_history",
      "memory",
      "fact",
      "vector",
      "checkpoint",
      "idempotency",
      "decision",
    ]);
  });
});

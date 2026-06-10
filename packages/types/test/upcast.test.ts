import { describe, it, expect } from "vitest";
import {
  upcastEvent,
  upcastEvents,
  EventUnupcastableError,
  EVENT_SCHEMA_VERSION,
  DEFAULT_UPCASTERS,
} from "../src/index.js";
import type { StoredEvent, Upcaster } from "../src/index.js";

function makeEvent(schemaVersion: number, payload: unknown = "hello"): StoredEvent {
  return {
    id: "evt_test",
    sessionId: "sess_test",
    seq: 0,
    kind: "user",
    schemaVersion,
    payload,
    createdAt: new Date().toISOString(),
  };
}

describe("upcastEvent", () => {
  it("is an identity pass for an event already at EVENT_SCHEMA_VERSION (no-op at v1)", () => {
    const e = makeEvent(EVENT_SCHEMA_VERSION);
    const result = upcastEvent(e);
    expect(result).toBe(e); // same reference — zero allocation
    expect(result.schemaVersion).toBe(EVENT_SCHEMA_VERSION);
  });

  it("is an identity pass even with an empty custom upcasters registry (no-op at v1)", () => {
    const e = makeEvent(EVENT_SCHEMA_VERSION);
    const result = upcastEvent(e, {});
    expect(result.schemaVersion).toBe(EVENT_SCHEMA_VERSION);
  });

  it("throws EventUnupcastableError when a required upcaster is missing for a gap", () => {
    // Pretend an event came in at schemaVersion 0, but there is no upcaster registered.
    // (In production this would be a v0→v1 migration without a registered upcaster.)
    const e = makeEvent(0);
    expect(() => upcastEvent(e)).toThrow(EventUnupcastableError);
    // The message describes the version gap
    expect(() => upcastEvent(e)).toThrow(/schemaVersion 0/);
  });

  it("applies a synthetic v1→v2 upcaster chain correctly (future-version simulation)", () => {
    // Simulate: EVENT_SCHEMA_VERSION is currently 1, but we test the chain logic by
    // registering a custom upcaster that upgrades from version 0 → 1 (since 1 is the
    // current version, an event at 0 needs to be brought up to 1).
    const v0Event = makeEvent(0, { legacyField: "old_value" });

    const upcasters: Record<number, Upcaster> = {
      0: (e) => ({
        ...e,
        schemaVersion: 1,
        payload: { renamedField: (e.payload as { legacyField: string }).legacyField },
      }),
    };

    const result = upcastEvent(v0Event, upcasters);
    expect(result.schemaVersion).toBe(EVENT_SCHEMA_VERSION); // brought up to v1
    expect(result.payload).toEqual({ renamedField: "old_value" });
  });

  it("EventUnupcastableError has the right code, class, and context", () => {
    const e = makeEvent(0);
    try {
      upcastEvent(e);
      expect.fail("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(EventUnupcastableError);
      const typed = err as EventUnupcastableError;
      expect(typed.code).toBe("event.unupcastable");
      expect(typed.class).toBe("protocol");
      expect(typed.context).toMatchObject({ fromVersion: 0, toVersion: EVENT_SCHEMA_VERSION });
    }
  });

  it("DEFAULT_UPCASTERS is empty (correct at v1 — no prior version to migrate from)", () => {
    expect(Object.keys(DEFAULT_UPCASTERS)).toHaveLength(0);
  });
});

describe("upcastEvents", () => {
  it("returns the same array reference (no allocation) when all events are at current version", () => {
    const events = [makeEvent(EVENT_SCHEMA_VERSION), makeEvent(EVENT_SCHEMA_VERSION)];
    const result = upcastEvents(events);
    expect(result).toBe(events); // identity: same array reference
  });

  it("returns the same array reference when no custom upcasters and all events are current", () => {
    const events = [makeEvent(EVENT_SCHEMA_VERSION)];
    const result = upcastEvents(events, undefined);
    expect(result).toBe(events);
  });

  it("applies upcasters to a whole log — each event gets transformed", () => {
    const events = [
      makeEvent(0, { legacyField: "a" }),
      makeEvent(0, { legacyField: "b" }),
    ];

    const upcasters: Record<number, Upcaster> = {
      0: (e) => ({
        ...e,
        schemaVersion: 1,
        payload: { renamedField: (e.payload as { legacyField: string }).legacyField },
      }),
    };

    const result = upcastEvents(events, upcasters);
    expect(result).not.toBe(events); // new array produced
    expect(result).toHaveLength(2);
    expect(result[0]!.schemaVersion).toBe(EVENT_SCHEMA_VERSION);
    expect(result[0]!.payload).toEqual({ renamedField: "a" });
    expect(result[1]!.payload).toEqual({ renamedField: "b" });
  });

  it("throws EventUnupcastableError on the first event that cannot be upcasted", () => {
    const events = [makeEvent(0), makeEvent(0)];
    expect(() => upcastEvents(events)).toThrow(EventUnupcastableError);
  });

  it("handles an empty array without error", () => {
    expect(() => upcastEvents([])).not.toThrow();
    expect(upcastEvents([])).toEqual([]);
  });

  it("is a no-op identity when all events are already at EVENT_SCHEMA_VERSION, even with custom upcasters present", () => {
    // When all events are current, upcastEvents with a custom registry still maps correctly
    // (the loop body is never entered for each event, since schemaVersion >= EVENT_SCHEMA_VERSION).
    const events = [makeEvent(EVENT_SCHEMA_VERSION)];
    const upcasters: Record<number, Upcaster> = {
      0: () => { throw new Error("should not be called"); },
    };
    // With custom upcasters we get a new array (map is called) but upcaster is never invoked.
    const result = upcastEvents(events, upcasters);
    expect(result[0]!.schemaVersion).toBe(EVENT_SCHEMA_VERSION);
  });
});

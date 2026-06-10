/**
 * Unit tests for the URL-hash session-link helpers used in SessionsView.
 * These test the pure parsing logic inline — the real functions live in the UI
 * component and rely on window.location/history, so we test equivalent logic here.
 */

import { describe, it, expect } from "vitest";

// ---------------------------------------------------------------------------
// Pure parse helper (mirrors readSessionHash in SessionsView.tsx)
// ---------------------------------------------------------------------------

function parseSessionFromHash(hash: string): string | null {
  try {
    const fragment = hash.startsWith("#") ? hash.slice(1) : hash;
    const params = new URLSearchParams(fragment);
    return params.get("session") ?? null;
  } catch {
    return null;
  }
}

function buildHashWithSession(existingHash: string, sessionId: string | null): string {
  try {
    const fragment = existingHash.startsWith("#") ? existingHash.slice(1) : existingHash;
    const params = new URLSearchParams(fragment);
    if (sessionId) {
      params.set("session", sessionId);
    } else {
      params.delete("session");
    }
    return params.toString() ? "#" + params.toString() : "";
  } catch {
    return "";
  }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("parseSessionFromHash", () => {
  it("returns null when hash is empty", () => {
    expect(parseSessionFromHash("")).toBeNull();
    expect(parseSessionFromHash("#")).toBeNull();
  });

  it("parses session= from a simple hash", () => {
    expect(parseSessionFromHash("#session=abc-123")).toBe("abc-123");
  });

  it("parses session= when other params are present", () => {
    expect(parseSessionFromHash("#tab=timeline&session=sess-42")).toBe("sess-42");
  });

  it("returns null when session param is absent", () => {
    expect(parseSessionFromHash("#tab=timeline")).toBeNull();
  });

  it("handles hash without leading #", () => {
    expect(parseSessionFromHash("session=no-hash")).toBe("no-hash");
  });

  it("handles session IDs with special characters (URL encoded)", () => {
    const id = "sess-2026-01-01T00:00:00.000Z";
    const encoded = "#session=" + encodeURIComponent(id);
    expect(parseSessionFromHash(encoded)).toBe(id);
  });
});

describe("buildHashWithSession", () => {
  it("produces #session=<id> from an empty hash", () => {
    const result = buildHashWithSession("", "abc-123");
    expect(result).toBe("#session=abc-123");
  });

  it("removes session key when null is passed", () => {
    const result = buildHashWithSession("#session=abc-123", null);
    expect(result).toBe("");
  });

  it("preserves other hash params when adding session", () => {
    const result = buildHashWithSession("#tab=timeline", "abc-123");
    expect(result).toContain("session=abc-123");
    expect(result).toContain("tab=timeline");
  });

  it("removes session but keeps other params", () => {
    const result = buildHashWithSession("#tab=timeline&session=abc-123", null);
    expect(result).toContain("tab=timeline");
    expect(result).not.toContain("session=");
  });

  it("round-trips: build → parse returns the same id", () => {
    const id = "session-id-12345";
    const hash = buildHashWithSession("", id);
    expect(parseSessionFromHash(hash)).toBe(id);
  });
});

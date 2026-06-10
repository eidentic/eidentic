import { describe, it, expect } from "vitest";
import { canonicalJson } from "../src/canonical-json.js";

describe("canonicalJson", () => {
  it("serializes null", () => {
    expect(canonicalJson(null)).toBe("null");
  });

  it("serializes undefined as 'null' (JSON.stringify(undefined) ?? 'null')", () => {
    expect(canonicalJson(undefined)).toBe("null");
  });

  it("serializes primitives", () => {
    expect(canonicalJson(42)).toBe("42");
    expect(canonicalJson(true)).toBe("true");
    expect(canonicalJson(false)).toBe("false");
    expect(canonicalJson("hello")).toBe('"hello"');
  });

  it("serializes an empty object", () => {
    expect(canonicalJson({})).toBe("{}");
  });

  it("serializes an empty array", () => {
    expect(canonicalJson([])).toBe("[]");
  });

  it("sorts object keys lexicographically", () => {
    // z before a in insertion order — canonical must sort to a,z
    const obj = { z: 2, a: 1 };
    expect(canonicalJson(obj)).toBe('{"a":1,"z":2}');
  });

  it("produces identical output regardless of key insertion order", () => {
    const a = { b: 2, a: 1 };
    const b = { a: 1, b: 2 };
    expect(canonicalJson(a)).toBe(canonicalJson(b));
  });

  it("recursively sorts keys in nested objects", () => {
    const nested = { outer: { z: 3, a: 1 }, b: 2 };
    expect(canonicalJson(nested)).toBe('{"b":2,"outer":{"a":1,"z":3}}');
  });

  it("preserves array element order", () => {
    expect(canonicalJson([3, 1, 2])).toBe("[3,1,2]");
  });

  it("handles arrays of objects (sorts each object's keys)", () => {
    const arr = [{ b: 2, a: 1 }, { d: 4, c: 3 }];
    expect(canonicalJson(arr)).toBe('[{"a":1,"b":2},{"c":3,"d":4}]');
  });

  it("handles deeply nested mixed structures", () => {
    const v = { x: [{ b: false, a: null }, 42], y: "hi" };
    expect(canonicalJson(v)).toBe('{"x":[{"a":null,"b":false},42],"y":"hi"}');
  });

  it("is byte-for-byte stable — same input always produces the same string", () => {
    const obj = { tool: "search", args: { query: "test", limit: 5 } };
    const first = canonicalJson(obj);
    const second = canonicalJson(obj);
    expect(first).toBe(second);
    expect(first).toBe('{"args":{"limit":5,"query":"test"},"tool":"search"}');
  });
});

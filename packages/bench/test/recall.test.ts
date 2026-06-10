import { describe, it, expect } from "vitest";
import { recallAtK, normalizeText, normalizedIncludes } from "../src/recall.js";

describe("normalizeText", () => {
  it("lowercases", () => {
    expect(normalizeText("Hello World")).toBe("hello world");
  });
  it("strips apostrophes", () => {
    expect(normalizeText("Alice's")).toBe("alices");
  });
  it("replaces other punctuation with space and collapses", () => {
    // comma and ! become spaces, then collapsed to single space, trimmed
    expect(normalizeText("hello, world!")).toBe("hello world");
  });
  it("collapses whitespace and trims", () => {
    // multiple interior spaces → single space, leading/trailing trimmed
    expect(normalizeText("  foo   bar  ")).toBe("foo bar");
  });
});

describe("normalizedIncludes", () => {
  it("finds exact match", () => {
    expect(normalizedIncludes("Alice lives in London", "London")).toBe(true);
  });
  it("handles case differences", () => {
    expect(normalizedIncludes("alice lives in london", "London")).toBe(true);
  });
  it("returns false when not present", () => {
    expect(normalizedIncludes("Alice lives in London", "Paris")).toBe(false);
  });
  it("handles apostrophes in needle", () => {
    expect(normalizedIncludes("Alice's favorite city is London", "Alice's")).toBe(true);
  });
});

describe("recallAtK", () => {
  it("returns 1.0 when all gold facts are present", () => {
    const snippets = ["Alice lives in London", "She is a software engineer"];
    const gold = ["Alice", "London", "software engineer"];
    expect(recallAtK(snippets, gold)).toBe(1.0);
  });

  it("returns 0 when no gold facts are present", () => {
    const snippets = ["The weather is nice today"];
    const gold = ["TypeScript", "Berlin", "chess"];
    expect(recallAtK(snippets, gold)).toBe(0);
  });

  it("returns fraction when partial facts are present", () => {
    const snippets = ["Alice enjoys TypeScript", "She works remotely"];
    const gold = ["Alice", "TypeScript", "London"]; // 2 of 3 present
    const result = recallAtK(snippets, gold);
    expect(result).toBeCloseTo(2 / 3, 5);
  });

  it("returns 1.0 when goldFacts is empty (vacuously true)", () => {
    expect(recallAtK(["anything"], [])).toBe(1.0);
  });

  it("returns 0 when retrieved snippets is empty and gold is non-empty", () => {
    expect(recallAtK([], ["London"])).toBe(0);
  });

  it("is case-insensitive", () => {
    expect(recallAtK(["london is great"], ["London"])).toBe(1.0);
  });

  it("normalizes punctuation in gold facts", () => {
    expect(recallAtK(["Alice loves TypeScript"], ["TypeScript!"])).toBe(1.0);
  });

  it("handles multiple snippets joined together", () => {
    const snippets = ["Alice plays chess", "She moved to Amsterdam"];
    const gold = ["chess", "Amsterdam"];
    expect(recallAtK(snippets, gold)).toBe(1.0);
  });

  it("baseline gate: 1-of-3 gold facts found → recall = 1/3 (meaningful floor, not just [0,1])", () => {
    // "foo" is in the snippet; "baz" and "qux" are not → recall = 1/3 ≈ 0.333.
    const result = recallAtK(["foo bar"], ["foo", "baz", "qux"]);
    // Exact value assertion: guards against denominator bugs (e.g. blank-fact leakage).
    expect(result).toBeCloseTo(1 / 3, 5);
    // Bounds still hold.
    expect(result).toBeGreaterThanOrEqual(0);
    expect(result).toBeLessThanOrEqual(1);
  });
});

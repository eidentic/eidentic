import { describe, it, expect } from "vitest";
import { renderPrompt, PromptRenderError } from "../src/index.js";

describe("renderPrompt", () => {
  it("substitutes a single variable", () => {
    expect(renderPrompt("Hello, {{name}}!", { name: "Alice" })).toBe(
      "Hello, Alice!",
    );
  });

  it("substitutes multiple variables", () => {
    const result = renderPrompt(
      "You are a {{role}} assistant. Today is {{date}}.",
      { role: "helpful", date: "2026-06-10" },
    );
    expect(result).toBe("You are a helpful assistant. Today is 2026-06-10.");
  });

  it("substitutes the same variable multiple times", () => {
    expect(renderPrompt("{{x}} and {{x}} again", { x: "foo" })).toBe(
      "foo and foo again",
    );
  });

  it("returns the body unchanged when there are no placeholders", () => {
    expect(renderPrompt("No placeholders here.", {})).toBe(
      "No placeholders here.",
    );
  });

  it("ignores extra vars that are not referenced in the body", () => {
    expect(renderPrompt("Hello {{name}}!", { name: "Bob", unused: "x" })).toBe(
      "Hello Bob!",
    );
  });

  it("throws PromptRenderError for a missing variable", () => {
    expect(() => renderPrompt("Hello, {{name}}!", {})).toThrow(
      PromptRenderError,
    );
  });

  it("lists ALL missing variables in the error", () => {
    let err: PromptRenderError | undefined;
    try {
      renderPrompt("{{a}} {{b}} {{c}}", { b: "present" });
    } catch (e) {
      err = e as PromptRenderError;
    }
    expect(err).toBeInstanceOf(PromptRenderError);
    expect(err!.missingVars).toContain("a");
    expect(err!.missingVars).toContain("c");
    expect(err!.missingVars).not.toContain("b");
  });

  it("handles whitespace inside placeholders: {{ name }}", () => {
    expect(renderPrompt("Hello, {{ name }}!", { name: "Carol" })).toBe(
      "Hello, Carol!",
    );
  });

  it("does not escape special characters — operator content trusted as-is", () => {
    const result = renderPrompt("{{raw}}", {
      raw: "<script>alert('xss')</script>",
    });
    expect(result).toBe("<script>alert('xss')</script>");
  });
});

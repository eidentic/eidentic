import { describe, expect, it } from "vitest";
import { sanitizeBoundaryText, sanitizeBoundaryValue } from "../src/boundary.js";

describe("public boundary sanitation", () => {
  it("redacts nested credential keys and credential-shaped strings", () => {
    expect(sanitizeBoundaryValue({
      ok: true,
      meta: { apiKey: "raw", access_token: "raw", note: "Bearer abc.def" },
      output: "failed with sk-abcdefghijklmnopqrstuvwxyz",
    })).toEqual({
      ok: true,
      meta: { apiKey: "***", access_token: "***", note: "Bearer [REDACTED]" },
      output: "failed with [REDACTED_CREDENTIAL]",
    });
  });

  it("preserves non-secret token accounting fields", () => {
    expect(sanitizeBoundaryValue({ inputTokens: 3, outputTokens: 5, maxTokens: 8, tokens: 8 }))
      .toEqual({ inputTokens: 3, outputTokens: 5, maxTokens: 8, tokens: 8 });
  });

  it("removes URL credentials, query, and fragment from standalone and embedded error text", () => {
    expect(sanitizeBoundaryText("https://user:pass@example.com/path?token=x#frag"))
      .toBe("https://example.com/path");
    expect(sanitizeBoundaryText(
      "request failed at https://user:pass@example.com/path?token=x#frag api_key=plain-secret",
    )).toBe("request failed at https://example.com/path api_key=[REDACTED]");
  });

  it("bounds recursion and handles cycles", () => {
    const value: Record<string, unknown> = {};
    value["self"] = value;
    expect(sanitizeBoundaryValue(value)).toEqual({ self: "[CIRCULAR]" });
  });
});

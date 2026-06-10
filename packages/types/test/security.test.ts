import { describe, it, expect } from "vitest";
import { MapSecrets } from "../src/testing.js";

describe("MapSecrets", () => {
  it("returns the value for a known key", async () => {
    const s = new MapSecrets({ API_KEY: "sk-123", OTHER: "val" });
    expect(await s.get("API_KEY")).toBe("sk-123");
    expect(await s.get("OTHER")).toBe("val");
  });

  it("returns undefined for a missing key", async () => {
    const s = new MapSecrets({ API_KEY: "sk-123" });
    expect(await s.get("MISSING")).toBeUndefined();
  });

  it("empty store always returns undefined", async () => {
    const s = new MapSecrets({});
    expect(await s.get("anything")).toBeUndefined();
  });
});

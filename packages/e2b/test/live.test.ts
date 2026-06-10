import { describe, it, expect } from "vitest";
import { sandboxConformanceCases } from "@eidentic/types/testing";
import { E2BSandbox, type E2BLike } from "../src/index.js";

// Hits a real E2B Firecracker microVM. SKIPPED unless EIDENTIC_TEST_E2B_API_KEY is set. Never runs in CI.
// Local: EIDENTIC_TEST_E2B_API_KEY=e2b_… pnpm --filter @eidentic/e2b test live
const apiKey = process.env["EIDENTIC_TEST_E2B_API_KEY"];
const live = apiKey ? describe : describe.skip;

live("E2BSandbox conformance (live E2B)", () => {
  // Adapt the real `Sandbox` static factory to the `E2BLike` structural shape.
  const makeSandbox = async () => {
    const { Sandbox } = await import("@e2b/code-interpreter");
    const client: E2BLike = {
      create: (opts) => Sandbox.create({ apiKey, ...(opts ?? {}) }) as never,
    };
    return E2BSandbox.create({ client, apiKey, defaultTimeoutMs: 30_000 });
  };
  for (const c of sandboxConformanceCases(makeSandbox)) it(c.name, c.run, 60_000);

  it("runs real JavaScript and captures stdout", async () => {
    const sandbox = await makeSandbox();
    const r = await sandbox.run("console.log(6 * 7)", { language: "javascript" });
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain("42");
  }, 60_000);
});

import { describe, it, expect } from "vitest";
import { browserTools, type PageLike } from "../src/index.js";

// Hits a real browser via Playwright. SKIPPED unless EIDENTIC_TEST_BROWSER=1 is set.
// Never runs in CI.
//
// Prerequisites:
//   1. pnpm add -D playwright (or playwright-core + browser install)
//   2. npx playwright install chromium
//
// Run:
//   EIDENTIC_TEST_BROWSER=1 pnpm --filter @eidentic/browser test live
//
const enabled = process.env["EIDENTIC_TEST_BROWSER"] === "1";
const live = enabled ? describe : describe.skip;

live("browserTools — live Playwright integration", () => {
  it("navigates to example.com and reads the page", async () => {
    const { chromium } = await import("playwright-core");
    const browser = await chromium.launch({ headless: true });
    const context = await browser.newContext();
    const page = await context.newPage();

    try {
      // Cast: real playwright Page satisfies PageLike structurally.
      const tools = browserTools(page as unknown as PageLike, {
        allowlist: ["example.com"],
      });

      // Navigate.
      const navResult = await tools
        .find((t) => t.id === "browser_navigate")!
        .execute({ url: "https://example.com/" }) as { navigated: boolean; url: string };
      expect(navResult.navigated).toBe(true);
      expect(navResult.url).toContain("example.com");

      // Read.
      const readResult = await tools
        .find((t) => t.id === "browser_read")!
        .execute({}) as { title: string; url: string; text: string };
      expect(readResult.title.length).toBeGreaterThan(0);
      expect(readResult.url).toContain("example.com");
      expect(readResult.text.length).toBeGreaterThan(0);
    } finally {
      await browser.close();
    }
  }, 60_000);
});

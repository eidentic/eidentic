/**
 * hello-pricing: shows bundled defaultPrices + cached-token discount.
 * Uses a MockModel — no real API key needed.
 */
import { Agent } from "@eidentic/core";
import { InMemoryStore, MockModel } from "@eidentic/types/testing";
import { textBlock } from "@eidentic/types";
import { defaultPrices, pricesUpdatedAt } from "@eidentic/model";

console.log(`pricesUpdatedAt: ${pricesUpdatedAt}`);
console.log(`defaultPrices has ${Object.keys(defaultPrices).length} entries\n`);

const store = new InMemoryStore();
await store.migrate();

// --- Demo 1: plain (no cache) ---
{
  // 1000 input + 200 output, no cached tokens
  const model = new MockModel([
    { content: [textBlock("done")], usage: { inputTokens: 1000, outputTokens: 200 } },
  ]);

  const agent = new Agent({
    id: "demo-no-cache",
    instructions: "answer concisely",
    model,
    store,
    modelId: "claude-sonnet-4-5", // key in defaultPrices
    prices: defaultPrices,
  });

  for await (const ev of agent.query("hello", { sessionId: "nc-1" })) {
    if (ev.type === "result") {
      const { usd, foreground } = ev.cost!;
      console.log("=== No cached tokens ===");
      console.log(`  input: ${foreground.inputTokens}  output: ${foreground.outputTokens}`);
      console.log(`  USD (all at input rate): $${usd?.toFixed(8)}`);
      // Expected: (1000*3 + 200*15) / 1e6 = 0.003 + 0.003 = 0.006
    }
  }
}

// --- Demo 2: with cached tokens (discount visible) ---
{
  // Same token count, but 800 of the 1000 input are cached reads (billed at ~10%)
  const model = new MockModel([
    {
      content: [textBlock("done")],
      usage: { inputTokens: 1000, outputTokens: 200, cachedInputTokens: 800 },
    },
  ]);

  const agent = new Agent({
    id: "demo-cached",
    instructions: "answer concisely",
    model,
    store,
    modelId: "claude-sonnet-4-5",
    prices: defaultPrices,
  });

  for await (const ev of agent.query("hello", { sessionId: "c-1" })) {
    if (ev.type === "result") {
      const { usd, foreground, cachedInputTokens } = ev.cost!;
      console.log("\n=== With 800 cached input tokens ===");
      console.log(`  input: ${foreground.inputTokens}  cached: ${cachedInputTokens}  output: ${foreground.outputTokens}`);
      console.log(`  USD (cached at 0.3/MTok): $${usd?.toFixed(8)}`);
      // Expected: (200*3 + 800*0.3 + 200*15) / 1e6 = (600 + 240 + 3000)/1e6 = 0.00384
    }
  }
}

// --- Demo 3: tiny injected price table (shows the pattern without defaultPrices) ---
{
  const model = new MockModel([
    { content: [textBlock("done")], usage: { inputTokens: 500, outputTokens: 100, cachedInputTokens: 400 } },
  ]);

  const myPrices = {
    "my-model": { inputPerMTok: 2.0, outputPerMTok: 8.0, cachedInputPerMTok: 0.2 },
  };

  const agent = new Agent({
    id: "demo-custom",
    instructions: "answer concisely",
    model,
    store,
    modelId: "my-model",
    prices: myPrices,
  });

  for await (const ev of agent.query("hello", { sessionId: "custom-1" })) {
    if (ev.type === "result") {
      const { usd } = ev.cost!;
      console.log("\n=== Custom price table ===");
      console.log(`  USD: $${usd?.toFixed(8)}`);
      // (100*2 + 400*0.2 + 100*8)/1e6 = (200+80+800)/1e6 = 0.00108
    }
  }
}

console.log("\nDone. Zero network calls — all pricing is bundled.");
await store.close();

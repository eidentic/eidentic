import { describe, it, expect } from "vitest";
import { InMemoryTracer } from "@eidentic/types/testing";
import type { CostBreakdown, CostPolicy, PriceTable, TracerPort } from "@eidentic/types";

describe("InMemoryTracer", () => {
  it("records spans with name, attributes, status and ended flag", () => {
    const tracer: TracerPort = new InMemoryTracer();
    const t = tracer as InMemoryTracer;

    const span = tracer.startSpan("gen_ai.chat", { "gen_ai.request.model": "haiku" });
    span.setAttribute("gen_ai.usage.input_tokens", 5);
    span.setAttribute("gen_ai.usage.output_tokens", 2);
    span.setStatus("ok");
    span.end();

    expect(t.spans).toHaveLength(1);
    const rec = t.spans[0]!;
    expect(rec.name).toBe("gen_ai.chat");
    expect(rec.attributes).toMatchObject({
      "gen_ai.request.model": "haiku",
      "gen_ai.usage.input_tokens": 5,
      "gen_ai.usage.output_tokens": 2,
    });
    expect(rec.status).toBe("ok");
    expect(rec.ended).toBe(true);
  });

  it("records error status with a message and defaults status to undefined until set", () => {
    const tracer = new InMemoryTracer();
    const s = tracer.startSpan("gen_ai.execute_tool", { "gen_ai.tool.name": "boom" });
    expect(tracer.spans[0]!.status).toBeUndefined();
    s.setStatus("error", "kaboom");
    s.end();
    expect(tracer.spans[0]!.status).toBe("error");
    expect(tracer.spans[0]!.message).toBe("kaboom");
  });

  it("preserves emission order and exposes a names() helper", () => {
    const tracer = new InMemoryTracer();
    tracer.startSpan("gen_ai.invoke_agent").end();
    tracer.startSpan("memory.retrieve").end();
    tracer.startSpan("gen_ai.chat").end();
    expect(tracer.names()).toEqual(["gen_ai.invoke_agent", "memory.retrieve", "gen_ai.chat"]);
  });

  it("type-level: CostBreakdown / CostPolicy / PriceTable compile with the documented shape", () => {
    const prices: PriceTable = { haiku: { inputPerMTok: 0.8, outputPerMTok: 4 } };
    const policy: CostPolicy = { maxTurns: 4, maxTokens: 100, maxCostUsd: 0.5, maxWallClockMs: 1000, softCostUsd: 0.1 };
    const cost: CostBreakdown = {
      foreground: { inputTokens: 1, outputTokens: 1 },
      background: { inputTokens: 0, outputTokens: 0 },
      cachedInputTokens: 0,
      usd: 0,
    };
    expect(prices.haiku!.inputPerMTok).toBe(0.8);
    expect(policy.maxTokens).toBe(100);
    expect(cost.background.inputTokens).toBe(0);
  });
});

describe("CostBreakdown.children (multi-agent, §8.6)", () => {
  it("accepts an optional children Usage and is back-compat when absent", () => {
    const withoutChildren: CostBreakdown = {
      foreground: { inputTokens: 10, outputTokens: 5 },
      background: { inputTokens: 0, outputTokens: 0 },
      cachedInputTokens: 0,
    };
    expect(withoutChildren.children).toBeUndefined();

    const withChildren: CostBreakdown = {
      foreground: { inputTokens: 10, outputTokens: 5 },
      background: { inputTokens: 0, outputTokens: 0 },
      cachedInputTokens: 0,
      children: { inputTokens: 40, outputTokens: 20 },
      usd: 0.0012,
    };
    expect(withChildren.children).toEqual({ inputTokens: 40, outputTokens: 20 });
  });
});

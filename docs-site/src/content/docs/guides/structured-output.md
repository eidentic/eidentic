---
title: Structured Output
description: Get typed, validated JSON objects from agent.query() using outputSchema.
---

Eidentic supports structured output out of the box. Pass an `outputSchema` (a Zod schema) to `agent.query()` and the result's `.object` field will contain a validated, typed object.

## Basic usage

```ts
import { Agent, AIModel, SqliteStore } from "eidentic";
import { anthropic } from "@ai-sdk/anthropic";
import { z } from "zod";

const agent = new Agent({
  id: "extractor",
  model: new AIModel(anthropic("claude-sonnet-4-5")),
  store: new SqliteStore("./eidentic.sqlite"),
});

const schema = z.object({
  sentiment: z.enum(["positive", "negative", "neutral"]),
  score: z.number().min(0).max(1),
  summary: z.string(),
});

let result;
for await (const ev of agent.query(
  "Analyze the sentiment of: 'The product is great but shipping was slow.'",
  {
    sessionId: "s-1",
    outputSchema: schema,
  }
)) {
  if (ev.type === "result" && ev.subtype === "success") {
    result = ev;
  }
}

// result.object is typed as { sentiment: "positive" | "negative" | "neutral", score: number, summary: string }
console.log(result.object.sentiment); // "positive"
console.log(result.object.score);     // e.g. 0.72
```

## How it works

When `outputSchema` is provided, Eidentic instructs the model to produce a JSON response matching the schema. The schema is serialized and passed to the model as part of the prompt/tool-use protocol. The response is validated against the schema before it reaches your code — if validation fails, the result has `subtype: "error"`.

## Combining structured output with tools

An agent with tools will still use them normally when `outputSchema` is set. The final assistant turn is constrained to the schema; tool calls happen on intermediate turns.

```ts
import { webTools } from "@eidentic/tools";

const researchAgent = new Agent({
  id: "researcher",
  model: new AIModel(anthropic("claude-sonnet-4-5")),
  store: new SqliteStore("./eidentic.sqlite"),
  tools: webTools({ searchProvider: mySearchProvider }),
});

const reportSchema = z.object({
  title: z.string(),
  findings: z.array(z.string()),
  sources: z.array(z.string().url()),
});

for await (const ev of researchAgent.query(
  "Research the latest developments in edge AI inference.",
  { sessionId: "s-2", outputSchema: reportSchema }
)) {
  if (ev.type === "result" && ev.subtype === "success") {
    console.log(ev.object.findings);
  }
}
```

## Accessing the result object

The `StreamEvent` union has a terminal `result` event. When `outputSchema` is set and the run succeeds, `result.object` contains the parsed value:

```ts
for await (const ev of agent.query(input, { sessionId, outputSchema: schema })) {
  if (ev.type === "result") {
    if (ev.subtype === "success" && ev.object) {
      // typed as z.infer<typeof schema>
      doSomething(ev.object);
    } else {
      console.error("Agent run failed:", ev.subtype, ev.output);
    }
  }
}
```

## Schema tips

- Keep schemas flat when possible — deeply nested schemas can increase model error rates.
- Use `.describe()` on Zod fields to give the model context about each field's purpose.
- `z.enum()` is more reliable than `z.string()` when the value set is bounded.

```ts
const schema = z.object({
  category: z.enum(["bug", "feature", "question"]).describe("The type of support ticket"),
  priority: z.number().int().min(1).max(5).describe("Priority from 1 (low) to 5 (critical)"),
  assignee: z.string().optional().describe("Team or person to assign this to, if determinable"),
});
```

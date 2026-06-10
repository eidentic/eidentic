---
"@eidentic/types": minor
"@eidentic/core": minor
"@eidentic/model": minor
---

Structured / schema-constrained output (D2): get a typed, validated object out of an agent.

Pass `agent.query(input, { outputSchema })` a Zod schema (same convention as `createTool`'s `inputSchema`). The agent still runs its full multi-turn tool loop — only the **final** (tool-less) turn is constrained to the schema. The parsed, validated value is surfaced on the terminal `result` event as `result.object` (the raw text answer stays on `result.output`). If the model's structured answer fails validation, the run terminates with `subtype: "error"` describing the mismatch. Fully backward-compatible: omitting `outputSchema` leaves `query()` byte-identical.

- **`@eidentic/types`**: `ModelRequest.outputSchema?` (JSON Schema over the port boundary) + `ModelResponse.object?`; the terminal `result` `StreamEvent` gains an optional `object?`.
- **`@eidentic/model`**: `AIModel` forwards the schema to AI SDK v6 `generateText`/`streamText` via `experimental_output: Output.object(...)` (sets a JSON `responseFormat`) and returns the parsed object on `ModelResponse.object`.
- **`@eidentic/core`**: `QueryOptions.outputSchema?` (Zod); the loop forwards the JSON Schema each turn and validates the final object against the source schema. Validation is authoritative (the JSON Schema is only a provider hint); when the port did not pre-parse, core parses the final text as JSON.

Note (v1): structured output composes with the default ReAct loop; reasoning strategies and `resume()` do not thread `outputSchema` yet.

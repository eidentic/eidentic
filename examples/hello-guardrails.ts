/**
 * hello-guardrails.ts
 *
 * Demonstrates the GuardrailPort (D7) for input/output content guardrails.
 *
 * Scenarios:
 *   1. Input block      — run terminates before the model is called (subtype: "guardrail")
 *   2. Input redact     — PII is replaced before the model sees the text
 *   3. Output redact    — the reference `regexPiiGuardrail()` adapter scrubs output PII
 *   4. Combined PII     — regexPiiGuardrail on both input and output
 *   5. Scoped agent     — `topicGuardrail` blocks off-topic requests using an LLM classifier
 *   6. Greeting         — `AgentConfig.greeting` surfaces a static opening message on session.init
 *
 * External content-moderation services (e.g. Azure Content Safety, Perspective API) can
 * implement the same `GuardrailPort` interface:
 *
 *   const moderationGuardrail: GuardrailPort = {
 *     async checkInput(text) {
 *       const { flagged, reason } = await myModerationApi.evaluate(text);
 *       if (flagged) return { action: "block", reason };
 *       return { action: "allow" };
 *     },
 *   };
 */

import { Agent, topicGuardrail } from "@eidentic/core";
import { regexPiiGuardrail } from "@eidentic/core";
import { InMemoryStore, MockModel } from "@eidentic/types/testing";
import { textBlock } from "@eidentic/types";
import type { GuardrailPort } from "@eidentic/types";

// ---------------------------------------------------------------------------
// SCENARIO 1 — Input block: run terminates before the model is called
// ---------------------------------------------------------------------------

console.log("=== SCENARIO 1: Input block ===");

const blockGuardrail: GuardrailPort = {
  checkInput(text) {
    if (text.toLowerCase().includes("confidential")) {
      return { action: "block", reason: "input contains confidential keyword" };
    }
    return { action: "allow" };
  },
};

const blockStore = new InMemoryStore();
await blockStore.migrate();

// The model would normally respond — but the guardrail fires first so it never runs.
const blockModel = new MockModel([
  { content: [textBlock("NEVER REACHED")], usage: { inputTokens: 1, outputTokens: 1 } },
]);

const blockAgent = new Agent({
  id: "block-demo",
  instructions: "You are a helpful assistant.",
  model: blockModel,
  store: blockStore,
  guardrails: blockGuardrail,
});

for await (const ev of blockAgent.query("This is CONFIDENTIAL data.", { sessionId: "s1" })) {
  if (ev.type === "result") {
    console.log("subtype:", ev.subtype);         // "guardrail"
    console.log("output:", ev.output);            // "Input blocked by guardrail: …"
    console.log("model called:", blockModel.calls.length > 0); // false — model never ran
  }
}

// ---------------------------------------------------------------------------
// SCENARIO 2 — Input redact: PII is replaced before the model sees the text
// ---------------------------------------------------------------------------

console.log("\n=== SCENARIO 2: Input redact (custom keyword) ===");

const redactGuardrail: GuardrailPort = {
  checkInput(text) {
    const redacted = text.replace(/\b(?:password|secret)\b/gi, "[REDACTED]");
    if (redacted !== text) {
      return { action: "redact", text: redacted, reason: "sensitive keyword redacted" };
    }
    return { action: "allow" };
  },
};

const redactStore = new InMemoryStore();
await redactStore.migrate();

const redactModel = new MockModel([
  { content: [textBlock("Got it, I see some redacted content.")], usage: { inputTokens: 2, outputTokens: 2 } },
]);

const redactAgent = new Agent({
  id: "redact-demo",
  instructions: "You are a helpful assistant.",
  model: redactModel,
  store: redactStore,
  guardrails: redactGuardrail,
});

for await (const ev of redactAgent.query("My password is hunter2 and my secret is 42.", { sessionId: "s2" })) {
  if (ev.type === "result") {
    console.log("subtype:", ev.subtype);          // "success"
    console.log("output:", ev.output);
  }
}

// Show what the model actually saw:
const userMsg = redactModel.calls[0]?.messages.find((m) => m.role === "user");
console.log("model saw:", userMsg?.content);      // "[REDACTED]" placeholders, no raw values

// ---------------------------------------------------------------------------
// SCENARIO 3 — Output redact: reference regexPiiGuardrail on output
// ---------------------------------------------------------------------------

console.log("\n=== SCENARIO 3: Output redact via regexPiiGuardrail ===");

const piiStore = new InMemoryStore();
await piiStore.migrate();

// Simulate a model that accidentally echoes PII in its response.
const piiModel = new MockModel([
  {
    content: [textBlock("Your account details: email user@example.com, card 4111 1111 1111 1111.")],
    usage: { inputTokens: 3, outputTokens: 10 },
  },
]);

const piiAgent = new Agent({
  id: "pii-demo",
  instructions: "You are a helpful assistant.",
  model: piiModel,
  store: piiStore,
  // Check output only — the input in this demo does not contain PII.
  guardrails: regexPiiGuardrail({ mode: "redact", check: ["output"] }),
});

for await (const ev of piiAgent.query("Show me my account details.", { sessionId: "s3" })) {
  if (ev.type === "result") {
    console.log("subtype:", ev.subtype);          // "success"
    console.log("output:", ev.output);            // "[EMAIL]" and "[CREDIT_CARD]" present; raw PII absent
    const out = String(ev.output);
    console.log("email redacted:", !out.includes("user@example.com") && out.includes("[EMAIL]"));
    console.log("card redacted:",  !out.includes("4111") && out.includes("[CREDIT_CARD]"));
  }
}

// ---------------------------------------------------------------------------
// SCENARIO 4 — Combined: PII guardrail on both input and output
// ---------------------------------------------------------------------------

console.log("\n=== SCENARIO 4: regexPiiGuardrail on both input and output ===");

const bothStore = new InMemoryStore();
await bothStore.migrate();

const bothModel = new MockModel([
  {
    content: [textBlock("I can see your email has been redacted. No PII in the response.")],
    usage: { inputTokens: 3, outputTokens: 5 },
  },
]);

const bothAgent = new Agent({
  id: "both-demo",
  instructions: "You are a helpful assistant.",
  model: bothModel,
  store: bothStore,
  guardrails: regexPiiGuardrail({ mode: "redact" }), // default: both input and output
});

for await (const ev of bothAgent.query("My email is admin@company.com, please help.", { sessionId: "s4" })) {
  if (ev.type === "result") {
    console.log("subtype:", ev.subtype);
    console.log("output:", ev.output);
  }
}

// The model received "[EMAIL]" not "admin@company.com"
const bothUserMsg = bothModel.calls[0]?.messages.find((m) => m.role === "user");
console.log("model input PII redacted:", String(bothUserMsg?.content).includes("[EMAIL]"));

// ---------------------------------------------------------------------------
// SCENARIO 5 — Scoped agent: topicGuardrail blocks off-topic requests
// ---------------------------------------------------------------------------

console.log("\n=== SCENARIO 5: topicGuardrail — LLM-judge scope enforcement ===");

//
// In production you would pass a real cheap model (e.g. claude-haiku-4-5) as the classifier.
// Here we simulate with a MockModel so the example runs without credentials.
//
// Defense-in-depth layering:
//   1. system-prompt scoping (instructions below) — fast, zero-cost, but bypassable
//   2. topicGuardrail — independent LLM call on the raw input; harder to subvert
//

// Classifier that says BLOCK to everything (simulates an off-topic request)
const blockClassifier = new MockModel([
  { content: [textBlock("BLOCK")], usage: { inputTokens: 5, outputTokens: 1 } },
]);

const scopedStore = new InMemoryStore();
await scopedStore.migrate();

const scopedMainModel = new MockModel([
  { content: [textBlock("NEVER REACHED")], usage: { inputTokens: 1, outputTokens: 1 } },
]);

const scopedAgent = new Agent({
  id: "billing-support",
  instructions:
    "You are a billing support agent for Acme. Only answer billing and account questions.",
  model: scopedMainModel,
  store: scopedStore,
  guardrails: topicGuardrail({
    model: blockClassifier,
    description: "billing and account support for Acme",
    blockMessage: "I can only help with Acme billing and account questions.",
  }),
});

for await (const ev of scopedAgent.query("What is the capital of France?", { sessionId: "s5" })) {
  if (ev.type === "result") {
    console.log("subtype:", ev.subtype);       // "guardrail"
    console.log("output:", ev.output);          // contains "billing and account questions"
    console.log("main model called:", scopedMainModel.calls.length > 0); // false
  }
}

// Now simulate an in-scope request (classifier returns ALLOW)
const allowClassifier = new MockModel([
  { content: [textBlock("ALLOW")], usage: { inputTokens: 5, outputTokens: 1 } },
]);

const inScopeStore = new InMemoryStore();
await inScopeStore.migrate();

const inScopeMainModel = new MockModel([
  { content: [textBlock("Your balance is $0.00.")], usage: { inputTokens: 5, outputTokens: 5 } },
]);

const inScopeAgent = new Agent({
  id: "billing-support-2",
  instructions: "You are a billing support agent for Acme.",
  model: inScopeMainModel,
  store: inScopeStore,
  guardrails: topicGuardrail({
    model: allowClassifier,
    description: "billing and account support for Acme",
  }),
});

for await (const ev of inScopeAgent.query("What is my current balance?", { sessionId: "s5b" })) {
  if (ev.type === "result") {
    console.log("in-scope subtype:", ev.subtype);   // "success"
    console.log("in-scope output:", ev.output);      // balance response
  }
}

// ---------------------------------------------------------------------------
// SCENARIO 6 — greeting: static opening message in session.init
// ---------------------------------------------------------------------------

console.log("\n=== SCENARIO 6: AgentConfig.greeting ===");

//
// The greeting is a static string — no model call, no token cost.
// UIs read it from the `session.init` stream event's `greeting` field and render
// it as an initial assistant bubble before the first user message.
//
// Prompt-customization story:
//   - instructions  → shapes the model's behavior
//   - memory blocks → per-user/org injected context
//   - query input   → the user's message
//   - greeting      → this field: static UI opening message, never sent to model
//

const greetStore = new InMemoryStore();
await greetStore.migrate();

const greetModel = new MockModel([
  { content: [textBlock("How can I help you today?")], usage: { inputTokens: 2, outputTokens: 5 } },
]);

const greetAgent = new Agent({
  id: "greeter",
  instructions: "You are a helpful assistant.",
  model: greetModel,
  store: greetStore,
  greeting: "Hi! I'm your billing support assistant. How can I help?",
});

// The getter is available immediately — no round-trip needed.
console.log("agent.greeting:", greetAgent.greeting);

for await (const ev of greetAgent.query("Hello", { sessionId: "s6" })) {
  if (ev.type === "session.init") {
    // greeting is also in the stream event so front-ends can render it immediately
    console.log("session.init.greeting:", ev.greeting);
  }
  if (ev.type === "result") {
    console.log("subtype:", ev.subtype);
  }
}

console.log("greeting in model messages:", greetModel.calls[0]?.messages.some(
  (m) => typeof m.content === "string" && m.content.includes("billing support assistant"),
)); // false — greeting never sent to model

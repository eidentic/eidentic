/**
 * eidentic.config.example.ts — copy this file to eidentic.config.ts in your project root.
 *
 * Loaded by `eidentic dev` via jiti — no build step required.
 * Set ANTHROPIC_API_KEY (or another provider key) in your environment before running.
 *
 * Usage:
 *   cp examples/eidentic.config.example.ts eidentic.config.ts
 *   ANTHROPIC_API_KEY=sk-... eidentic dev
 */

import { Agent } from "@eidentic/core";
import type { EidenticConfig } from "@eidentic/cli";

// Replace with a real model adapter, e.g.:
//   import { anthropic } from "@ai-sdk/anthropic";
//   import { AIModel } from "@eidentic/model";
//   const model = new AIModel(anthropic("claude-opus-4-5"));
//
// For this example we just type the config — import a model at runtime.
declare const model: Parameters<typeof Agent>[0]["model"];

const assistant = new Agent({
  id: "assistant",
  instructions: "You are a helpful assistant powered by Eidentic.",
  model,
});

const config: EidenticConfig = {
  agents: { assistant },
  port: 3000,
  // auth: ApiKeyAuth({ "my-key": { userId: "me" } }),
};

export default config;

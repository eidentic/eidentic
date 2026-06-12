/**
 * eidentic.config.example.ts — copy this file to eidentic.config.ts in your project root.
 *
 * Loaded by `eidentic dev` via jiti — no build step required. The CLI reads `agents`
 * (and the optional `port` / `auth`) from the default export and serves them.
 *
 * Usage:
 *   cp examples/eidentic.config.example.ts eidentic.config.ts
 *   ANTHROPIC_API_KEY=sk-... eidentic dev
 */

import { Agent, AIModel, SqliteStore } from "eidentic";
import { anthropic } from "@ai-sdk/anthropic";

const assistant = new Agent({
  id: "assistant",
  instructions: "You are a helpful assistant powered by Eidentic.",
  model: new AIModel(anthropic("claude-sonnet-4-5")),
  store: new SqliteStore("./eidentic.sqlite"),
});

export default {
  agents: { assistant },
  port: 3000,
  // auth: ApiKeyAuth({ "my-key": { userId: "me" } }), // from @eidentic/server, for multi-tenant
};

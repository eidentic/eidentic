import { Agent, createTool } from "@eidentic/core";
import { InMemoryStore, MockModel, MapSecrets } from "@eidentic/types/testing";
import { textBlock, toolUseBlock } from "@eidentic/types";
import { z } from "zod";

// ---------------------------------------------------------------------------
// PART 1 — PERMISSIONS: schema-layer deny + dispatch gate
// ---------------------------------------------------------------------------

// Side-effect flag: proves the destructive tool body never ran.
let deleteExecuted = false;

const readFile = createTool({
  id: "read_file",
  description: "Read a file from disk (read-only).",
  sideEffect: "read-only",
  inputSchema: z.object({ path: z.string() }),
  execute: async ({ input }) => ({ content: `<contents of ${input.path}>` }),
});

const deleteFile = createTool({
  id: "delete_file",
  description: "Permanently delete a file from disk (destructive).",
  sideEffect: "destructive",
  inputSchema: z.object({ path: z.string() }),
  execute: async ({ input }) => {
    deleteExecuted = true; // ← this must NOT be set
    return { deleted: input.path };
  },
});

// Script the model so it:
//  turn 1 — asks for the schema-visible tool (read_file only after filtering)
//  turn 2 — attempts to call delete_file anyway (dispatch gate must deny it)
//  turn 3 — returns a text response after seeing the denial error
const permModel = new MockModel([
  // Turn 1: model calls read_file (the only tool in the filtered schema it can see)
  { content: [toolUseBlock("c1", "read_file", { path: "/etc/passwd" })], usage: { inputTokens: 4, outputTokens: 2 } },
  // Turn 2: model ignores the filtering and directly attempts delete_file
  { content: [toolUseBlock("c2", "delete_file", { path: "/etc/passwd" })], usage: { inputTokens: 4, outputTokens: 2 } },
  // Turn 3: sees the denial, gives up gracefully
  { content: [textBlock("Cannot delete — permission denied.")], usage: { inputTokens: 5, outputTokens: 3 } },
]);

const permStore = new InMemoryStore();
await permStore.migrate();

const permAgent = new Agent({
  id: "perm-demo",
  instructions: "You are a read-only agent.",
  model: permModel,
  tools: [readFile, deleteFile],
  store: permStore,
  // deny: ["delete_*"] removes delete_file from the schema AND blocks dispatch.
  permissions: { deny: ["delete_*"] },
});

console.log("=== PART 1: Permissions ===");
for await (const ev of permAgent.query("Read /etc/passwd and then delete it.", { sessionId: "perm-session" })) {
  if (ev.type === "tool.result") {
    console.log(`tool.result  tool=${ev.toolName}  isError=${ev.isError}`);
    if (ev.isError) {
      // permission denied → dispatch gate returned an error output, body never ran
      console.log("  → dispatch gate error:", (ev.output as { error?: string })?.error);
    }
  }
  if (ev.type === "result") {
    console.log("result:", ev.subtype === "success" ? ev.output : ev.subtype);
  }
}

// Verify that the destructive tool body never executed.
console.log("\ndelete_file body executed:", deleteExecuted); // must be: false

// Also verify the model only saw read_file in its schema (delete_file was filtered out).
const schemaToolNames = permModel.calls[0]?.tools?.map((t) => t.name) ?? [];
console.log("tools visible to model (turn 1 schema):", schemaToolNames);
// delete_file must NOT appear
console.log("delete_file absent from schema:", !schemaToolNames.includes("delete_file")); // must be: true

// ---------------------------------------------------------------------------
// PART 2 — SECRETS: credential injection via ctx — model never sees the value
// ---------------------------------------------------------------------------

const callApi = createTool({
  id: "call_api",
  description: "Call an external API using the configured API key.",
  sideEffect: "read-only",
  requiredSecrets: ["API_KEY"],
  inputSchema: z.object({ endpoint: z.string() }),
  execute: async ({ input, ctx }) => {
    // The tool fetches the secret at call time from ctx — it is NEVER part of the
    // prompt, messages, or any value the model receives or can observe.
    const apiKey = await ctx!.secrets!.require("API_KEY");
    // Use apiKey only in the outbound request; never return it or a partial preview.
    void apiKey;
    return {
      endpoint: input.endpoint,
      keyPresent: true,
    };
  },
});

const secretModel = new MockModel([
  // Model calls the tool — it has NO knowledge of the API_KEY value.
  { content: [toolUseBlock("s1", "call_api", { endpoint: "/data" })], usage: { inputTokens: 3, outputTokens: 2 } },
  { content: [textBlock("API call succeeded.")], usage: { inputTokens: 4, outputTokens: 2 } },
]);

const secretStore = new InMemoryStore();
await secretStore.migrate();

const secretAgent = new Agent({
  id: "secret-demo",
  instructions: "You are a data-fetching agent.",
  model: secretModel,
  tools: [callApi],
  store: secretStore,
  // MapSecrets backs the vault — values are never serialised into the prompt (§10.3).
  secrets: new MapSecrets({ API_KEY: "sk-demo-123" }),
});

console.log("\n=== PART 2: Secrets ===");
for await (const ev of secretAgent.query("Fetch /data from the API.", { sessionId: "secret-session" })) {
  if (ev.type === "tool.result") {
    console.log("tool.result  tool=" + ev.toolName + "  output=" + JSON.stringify(ev.output));
  }
  if (ev.type === "result") {
    console.log("result:", ev.subtype === "success" ? ev.output : ev.subtype);
  }
}

// Confirm the model's messages/prompt never contained the raw secret.
const allModelContent = secretModel.calls
  .flatMap((r) => r.messages)
  .map((m) => JSON.stringify(m))
  .join(" ");
const secretLeaked = allModelContent.includes("sk-demo-123");
// Note: the secret is injected into ctx at dispatch time; it is never in the
// messages array, the tool schema, or any other value the model receives.
console.log("\nSecret leaked into model context:", secretLeaked); // must be: false

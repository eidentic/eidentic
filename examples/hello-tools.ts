/**
 * Built-in tool set (§5.8) + sealed-endpoint security (§5.6).
 *
 *  1. fileTools({ root }) round-trips read/write/edit/glob/grep in a temp workspace (path-confined).
 *  2. bashTool(EchoSandbox) runs a command; bashTool(NoopSandbox) REFUSES (secure default, §10.7).
 *  3. webTools({ allowlist }) fetches an allowlisted URL and REJECTS a non-allowlisted one.
 *  4. Register a couple of tools in an Agent with a MockModel scripting a tool call → end-to-end dispatch.
 *
 * Infra-free. Run:  pnpm hello:tools
 */
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileTools, bashTool, webTools } from "@eidentic/tools";
import { Agent, NoopSandbox } from "@eidentic/core";
import { InMemoryStore, MockModel, EchoSandbox } from "@eidentic/types/testing";
import { textBlock, toolUseBlock } from "@eidentic/types";

async function main() {
  const root = await mkdtemp(join(tmpdir(), "hello-tools-"));
  const files = fileTools({ root });
  const byId = (id: string) => files.find((t) => t.id === id)!;

  // 1. File tools round-trip.
  await byId("write_file").execute({ path: "src/greeting.txt", content: "hello eidentic" });
  await byId("edit_file").execute({ path: "src/greeting.txt", oldString: "hello", newString: "hi" });
  console.log("[read_file]", await byId("read_file").execute({ path: "src/greeting.txt" }));
  console.log("[glob **/*.txt]", await byId("glob").execute({ pattern: "**/*.txt" }));
  console.log("[grep hi]", await byId("grep").execute({ pattern: "hi" }));

  // Path-confinement: traversal is impossible.
  try {
    await byId("read_file").execute({ path: "../../etc/passwd" });
  } catch (e) {
    console.log("[confinement] rejected traversal:", (e as Error).message);
  }

  // 2. Bash via sandbox vs. refusal.
  const bashOk = bashTool(new EchoSandbox());
  console.log("[bash echo]", await bashOk.execute({ command: "echo sandboxed" }));
  const bashRefused = bashTool(new NoopSandbox());
  try {
    await bashRefused.execute({ command: "rm -rf /" });
  } catch (e) {
    console.log("[bash NoopSandbox] refused:", (e as Error).message);
  }

  // 3. Web fetch: allowlisted ok, non-allowlisted rejected.
  const fakeFetch = (async () => new Response("EXAMPLE PAGE", { status: 200 })) as unknown as typeof fetch;
  const web = webTools({ allowlist: ["example.com"], fetchImpl: fakeFetch });
  const webFetch = web.find((t) => t.id === "web_fetch")!;
  console.log("[web_fetch allowlisted]", await webFetch.execute({ url: "https://example.com/" }));
  try {
    await webFetch.execute({ url: "https://evil.test/" });
  } catch (e) {
    console.log("[web_fetch off-allowlist] rejected:", (e as Error).message);
  }

  // 4. Register a couple of tools in an Agent; MockModel scripts a read_file tool call.
  const store = new InMemoryStore();
  await store.migrate();
  const model = new MockModel([
    { content: [toolUseBlock("c1", "read_file", { path: "src/greeting.txt" })], usage: { inputTokens: 1, outputTokens: 1 } },
    { content: [textBlock("The file says: hi eidentic")], usage: { inputTokens: 1, outputTokens: 1 } },
  ]);
  const agent = new Agent({
    id: "demo",
    instructions: "You are a helpful assistant with file access.",
    model,
    store,
    tools: [byId("read_file"), bashOk, webFetch],
  });

  let agentOutput: unknown;
  for await (const ev of agent.query("Read src/greeting.txt", { sessionId: "s1" })) {
    if (ev.type === "result") agentOutput = ev.output;
  }
  console.log("[agent]", agentOutput);

  await rm(root, { recursive: true, force: true });
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

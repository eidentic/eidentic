import { isText, isToolUse, type StreamEvent } from "@eidentic/types";
import { randomUUID } from "node:crypto";

const MAX_TERMINAL_TEXT = 8_192;

/** Remove terminal control sequences and bound untrusted model output before printing it. */
export function safeTerminalText(value: unknown): string {
  if (typeof value !== "string") return "";

  return value
    // ANSI/ECMA-48 control sequences, including CSI and OSC forms.
    .replace(/\u001B(?:\][^\u0007]*(?:\u0007|\u001B\\)|\[[0-?]*[ -/]*[@-~])/gu, " ")
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/gu, " ")
    .replace(/\s+/gu, " ")
    .trim()
    .slice(0, MAX_TERMINAL_TEXT);
}

/** Convert an SDK stream event into deliberately low-information, terminal-safe status lines. */
export function formatDevEvent(event: StreamEvent): string[] {
  switch (event.type) {
    case "session.init":
      return [
        `● model  ${safeTerminalText(event.model)}`,
        `● tools  ${event.tools.length > 0 ? event.tools.map(safeTerminalText).join(", ") : "none"}`,
      ];
    case "assistant":
      return event.content.flatMap((block) => {
        if (isText(block)) {
          const text = safeTerminalText(block.text);
          return text ? [text] : [];
        }
        if (isToolUse(block)) return [`● tool   ${safeTerminalText(block.name)}`];
        return [];
      });
    case "tool.result":
      return [`${event.isError ? "✗" : "✓"} tool   ${safeTerminalText(event.toolName)}`];
    case "result": {
      const output = safeTerminalText(event.output);
      const turns = `${event.numTurns} ${event.numTurns === 1 ? "turn" : "turns"}`;
      const cost = event.cost?.usd === undefined ? "" : ` · $${event.cost.usd.toFixed(6)}`;
      const marker = event.subtype === "success" ? "✓" : event.subtype === "suspended" ? "◐" : "✗";
      return [...(output ? [output] : []), `${marker} ${event.subtype === "success" ? "done" : event.subtype}   ${turns}${cost}`];
    }
    case "compaction":
      return [`◐ context compacted   ${event.before} → ${event.after} tokens`];
    case "stream.delta":
      return [];
  }
}

interface QueryableAgent {
  query(input: string, options: { sessionId: string }): AsyncIterable<StreamEvent>;
}

export interface DevConsoleOptions {
  agents: Record<string, QueryableAgent>;
  write: (line: string) => void;
  createSessionId?: () => string;
}

/** Consume terminal lines serially so a session cannot accidentally run concurrent turns. */
export async function consumeDevInput(
  input: AsyncIterable<string> | Iterable<string>,
  options: DevConsoleOptions,
): Promise<void> {
  const agentIds = Object.keys(options.agents);
  if (agentIds.length === 0) throw new Error("The dev console requires at least one agent");
  const createSessionId = options.createSessionId ?? randomUUID;
  let activeAgentId = agentIds[0]!;
  let sessionId = createSessionId();

  for await (const rawLine of input) {
    const line = rawLine.trim();
    if (!line) continue;
    if (line === "/exit") return;
    if (line === "/help") {
      options.write("Commands: /help, /new, /agent <id>, /exit");
      continue;
    }
    if (line === "/new") {
      sessionId = createSessionId();
      options.write(`● session ${sessionId}`);
      continue;
    }
    if (line.startsWith("/agent ")) {
      const requested = line.slice(7).trim();
      if (!Object.hasOwn(options.agents, requested)) {
        options.write(`Unknown agent: ${safeTerminalText(requested)}`);
        continue;
      }
      activeAgentId = requested;
      options.write(`● agent  ${safeTerminalText(requested)}`);
      continue;
    }
    if (line.startsWith("/")) {
      options.write("Unknown command. Type /help.");
      continue;
    }

    try {
      for await (const event of options.agents[activeAgentId]!.query(line, { sessionId })) {
        for (const outputLine of formatDevEvent(event)) options.write(outputLine);
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unknown error";
      options.write(`✗ error  ${safeTerminalText(message)}`);
    }
  }
}

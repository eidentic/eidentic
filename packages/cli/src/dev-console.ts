import { isText, isToolUse, type StreamEvent } from "@eidentic/types";
import { randomUUID } from "node:crypto";
import { watch, type FSWatcher } from "node:fs";

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
  onActivityChange?: (active: boolean) => void;
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
    if (!Object.hasOwn(options.agents, activeAgentId)) {
      const fallback = Object.keys(options.agents)[0];
      if (!fallback) throw new Error("No agents are available after reload");
      activeAgentId = fallback;
      options.write(`● agent  ${safeTerminalText(fallback)}`);
    }
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

    options.onActivityChange?.(true);
    try {
      let lastAssistantText = "";
      for await (const event of options.agents[activeAgentId]!.query(line, { sessionId })) {
        const outputLines = formatDevEvent(event);
        if (event.type === "assistant") {
          lastAssistantText = event.content
            .filter(isText)
            .map((block) => safeTerminalText(block.text))
            .filter(Boolean)
            .join(" ");
        }
        for (const outputLine of outputLines) {
          if (event.type === "result" && outputLine === lastAssistantText) continue;
          options.write(outputLine);
        }
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unknown error";
      options.write(`✗ error  ${safeTerminalText(message)}`);
    } finally {
      options.onActivityChange?.(false);
    }
  }
}

export interface AgentDirectoryWatcher {
  close(): void;
}

/** Debounced, serialized reload notifications for an agent directory. */
export function watchAgentDirectory(
  agentRoot: string,
  onReload: () => void | Promise<void>,
  debounceMs = 120,
): AgentDirectoryWatcher {
  let timer: NodeJS.Timeout | undefined;
  let closed = false;
  let running = false;
  let pending = false;

  const run = async (): Promise<void> => {
    if (closed) return;
    if (running) {
      pending = true;
      return;
    }
    running = true;
    try {
      await onReload();
    } finally {
      running = false;
      if (pending && !closed) {
        pending = false;
        await run();
      }
    }
  };

  const watcher: FSWatcher = watch(agentRoot, { recursive: true, persistent: false }, () => {
    if (closed) return;
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => void run().catch(() => undefined), debounceMs);
  });

  return {
    close() {
      closed = true;
      if (timer) clearTimeout(timer);
      watcher.close();
    },
  };
}

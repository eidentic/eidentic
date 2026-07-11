import { isText, isToolUse, type StreamEvent } from "@eidentic/types";

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

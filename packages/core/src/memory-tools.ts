import { z } from "zod";
import { scopeKey, type BlockEdit, type EditableMemoryPort, type MemoryPort, type Scope } from "@eidentic/types";
import { createTool, type Tool } from "./tool.js";
import { sha256Hex } from "./sha256.js";

/** Structural guard: a MemoryPort whose blocks the agent can edit. */
export function isEditableMemory(m: MemoryPort): m is EditableMemoryPort {
  const e = m as Partial<EditableMemoryPort>;
  return (
    typeof e.append === "function" &&
    typeof e.replace === "function" &&
    typeof e.rewrite === "function" &&
    typeof e.archive === "function"
  );
}

/** Compact a BlockEdit for the model: success => {ok,label,version,value}; failure => the reason payload. */
function compact(edit: BlockEdit): unknown {
  if (edit.ok) return { ok: true, label: edit.block.label, version: edit.block.version, value: edit.block.value };
  return { ok: false, reason: edit.reason, message: edit.message, current: edit.current };
}

const versionHint =
  "Read the target block's `version` from the injected <memory> context and pass it. " +
  "If the result is {ok:false, reason:'conflict'}, re-read `current`, recompute, and retry with current.version.";

/** Valid label: kebab/identifier charset, 1–64 chars. Matches SQL primary key constraints. */
const LABEL_RE = /^[a-zA-Z0-9_-]{1,64}$/;

function validateLabel(label: string): { ok: false; reason: "invalid"; message: string } | null {
  if (!LABEL_RE.test(label)) {
    return {
      ok: false,
      reason: "invalid",
      message: `label "${label}" is invalid: must match /^[a-zA-Z0-9_-]{1,64}$/`,
    };
  }
  return null;
}

/** Four self-editing tools bound to a memory + scope. All `destructive` so the registry serializes them.
 * These occupy the reserved `memory_*` tool-id namespace and are appended after user tools,
 * so a user-registered tool with the same id would be shadowed. */
export function memoryTools(memory: EditableMemoryPort, scope: Scope): Tool[] {
  return [
    createTool({
      id: "memory_append",
      description:
        "Append a durable fact to an always-in-context memory block (additive, conflict-free). " +
        "Use for new facts about the user/project worth remembering across sessions. " +
        "Returns {ok:false, reason:'readonly'|'limit'|'invalid'} if rejected — read the reason, do not retry blindly.",
      inputSchema: z.object({ label: z.string(), text: z.string() }),
      sideEffect: "destructive",
      idempotencyKey: async (input) => `memory_append:${scopeKey(scope)}:${input.label}:${await sha256Hex(input.text)}`,
      execute: async ({ input }) => {
        const err = validateLabel(input.label);
        if (err) return err;
        return compact(await memory.append(scope, input.label, input.text));
      },
    }),
    createTool({
      id: "memory_replace",
      description:
        "Replace ALL occurrences of `find` with `replace` in a memory block (substring edit). " +
        versionHint,
      inputSchema: z.object({ label: z.string(), find: z.string(), replace: z.string(), version: z.number() }),
      sideEffect: "destructive",
      idempotencyKey: async (input) =>
        `memory_replace:${scopeKey(scope)}:${input.label}:v${input.version}:${await sha256Hex(`${input.find}\0${input.replace}`)}`,
      execute: async ({ input }) => {
        const err = validateLabel(input.label);
        if (err) return err;
        return compact(await memory.replace(scope, input.label, input.find, input.replace, input.version));
      },
    }),
    createTool({
      id: "memory_rewrite",
      description: "Replace a memory block's entire value. " + versionHint,
      inputSchema: z.object({ label: z.string(), value: z.string(), version: z.number() }),
      sideEffect: "destructive",
      idempotencyKey: async (input) => `memory_rewrite:${scopeKey(scope)}:${input.label}:v${input.version}:${await sha256Hex(input.value)}`,
      execute: async ({ input }) => {
        const err = validateLabel(input.label);
        if (err) return err;
        return compact(await memory.rewrite(scope, input.label, input.value, input.version));
      },
    }),
    createTool({
      id: "memory_archive",
      description:
        "Write text to long-term archival memory (Tier-3, retrieved later by recall). " +
        "Use for context not worth keeping always-in-context.",
      inputSchema: z.object({ text: z.string() }),
      sideEffect: "destructive",
      idempotencyKey: async (input) => `memory_archive:${scopeKey(scope)}:${await sha256Hex(input.text)}`,
      execute: async ({ input }) => { await memory.archive(scope, input.text); return { ok: true }; },
    }),
  ];
}

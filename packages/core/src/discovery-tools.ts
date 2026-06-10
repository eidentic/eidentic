import { z } from "zod";
import { tokenize } from "@eidentic/types";
import type { StoredEvent, ToolSchema } from "@eidentic/types";
import { createTool, type Tool } from "./tool.js";

/**
 * Default eager core (§5.4): the ~20 atomic tools that ALWAYS load, plus the two discovery
 * meta-tools. Names that are not present in a given agent's toolset are simply ignored — this
 * is an over-approximation matched against the actual `schemas()` by name. Mirrors §5.8.
 */
export const EAGER_TOOL_IDS: readonly string[] = [
  // file ops (@eidentic/tools)
  "read_file", "write_file", "edit_file", "glob", "grep",
  // shell + web (@eidentic/tools)
  "bash", "web_fetch", "web_search",
  // memory (§6) + graph (§7a)
  "memory_append", "memory_replace", "memory_rewrite", "memory_archive",
  "graph_assert", "graph_query",
  // skills (§7)
  "skill_search", "skill_use", "skill_run",
  // multi-agent (§8)
  "spawn_agent",
  // discovery meta-tools (always eager so the model can always discover)
  "search_tools", "load_tool",
];

/** Resolved lazy config for a single run (computed once in agent.ts, threaded into the loop). */
export interface LazyToolConfig {
  /** Tool ids that always load (the atomic core + the two meta-tools). */
  eager: Set<string>;
  /** Default top-k for `search_tools` when the model omits it. */
  topK: number;
  /** The toolset-size threshold at/below which lazy mode stays OFF (manifest byte-identical). */
  threshold: number;
}

/**
 * Keyword scorer: overlap between the query tokens (as a SET — each query token counts once)
 * and the tool's name+description tokens. Deterministic; ties broken by tool name ascending.
 * Returns signatures only (`{name, description}`), never `inputSchema` (§5.4, invariant d).
 */
function rank(candidates: ToolSchema[], query: string, topK: number): { name: string; description: string }[] {
  const q = new Set(tokenize(query));
  if (q.size === 0) return [];
  const scored = candidates.map((c) => {
    const doc = new Set(tokenize(`${c.name} ${c.description}`));
    let score = 0;
    for (const t of q) if (doc.has(t)) score++;
    return { name: c.name, description: c.description, score };
  });
  return scored
    .filter((s) => s.score > 0)
    .sort((a, b) => (b.score - a.score) || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
    .slice(0, Math.max(0, topK))
    .map(({ name, description }) => ({ name, description }));
}

/**
 * The two discovery meta-tools (§5.4). `candidates()` returns the CURRENT permission-filtered
 * candidate set (i.e. `registry.schemas()`), so denied tools are never surfaced (Decision B).
 * Both are read-only: they have no external side effect. `load_tool`'s only "effect" is its own
 * persisted tool_result, which `loadedToolNames` later scans — discovery state is derived, not stored.
 */
export function lazyDiscoveryTools(candidates: () => ToolSchema[], cfg: { eager: Set<string>; topK: number }): [Tool, Tool] {
  const search = createTool({
    id: "search_tools",
    description:
      "Search the full tool catalog by keyword and get back the top matching tool SIGNATURES " +
      "(name + one-line description only, NOT their input schemas). Use this first to find a tool " +
      "you need, then call `load_tool(name)` to load its full schema before using it.",
    inputSchema: z.object({
      query: z.string().describe("Keywords describing the capability you need, e.g. 'send email'."),
      topK: z.number().int().positive().optional().describe("Max results to return (default 5)."),
    }),
    sideEffect: "read-only",
    execute: async ({ input }) => ({ results: rank(candidates(), input.query, input.topK ?? cfg.topK) }),
  });

  const load = createTool({
    id: "load_tool",
    description:
      "Load the full schema of a tool (found via `search_tools`) into your available tools for the " +
      "rest of this run, so you can call it. Idempotent; loading an unknown tool returns an error.",
    inputSchema: z.object({
      name: z.string().describe("The exact tool name to load (as returned by `search_tools`)."),
    }),
    sideEffect: "read-only",
    execute: async ({ input }) => {
      const name = input.name;
      if (cfg.eager.has(name)) return { ok: true, loaded: [], note: "already loaded (eager core)" };
      const exists = candidates().some((c) => c.name === name);
      if (!exists) {
        const valid = candidates().map((c) => c.name).join(", ");
        return { ok: false, error: `cannot load unknown or unavailable tool '${name}'. available: ${valid}` };
      }
      return { ok: true, loaded: [name] };
    },
  });

  return [search, load];
}

/**
 * Reconstruct the loaded-set for the CURRENT turn from the persisted event log (Decision A,
 * invariant b). Scans every `tool_result` for a successful `load_tool` and unions its `loaded`
 * names with the eager core. Pure function of (events, eager) → durable resume is deterministic.
 */
export function loadedToolNames(events: readonly StoredEvent[], eager: Set<string>): Set<string> {
  const loaded = new Set(eager);
  for (const e of events) {
    if (e.kind !== "tool_result") continue;
    const p = e.payload as { toolName?: string; output?: unknown };
    if (p.toolName !== "load_tool") continue;
    const out = p.output as { ok?: boolean; loaded?: unknown };
    if (out?.ok === true && Array.isArray(out.loaded)) {
      for (const n of out.loaded) if (typeof n === "string") loaded.add(n);
    }
  }
  return loaded;
}

export interface ManifestState {
  /** When false, lazy mode is OFF — the manifest is byte-identical to `schemas` (same reference). */
  active: boolean;
  eager: Set<string>;
  /** The full loaded-set (already includes the eager core; from `loadedToolNames`). */
  loaded: Set<string>;
}

/**
 * Assemble the per-turn model-facing manifest (invariant a + b). `schemas` is the FULL
 * permission-filtered `registry.schemas()`. When `state.active` is false, returns `schemas`
 * UNCHANGED (same array reference — byte-identical). When active, returns the subset whose
 * names are in (eager ∪ loaded), preserving `schemas()` order. Denied tools are absent from
 * `schemas` to begin with, so they can never reappear (Decision B).
 */
export function lazyManifest(schemas: ToolSchema[], state: ManifestState): ToolSchema[] {
  if (!state.active) return schemas;
  const keep = new Set([...state.eager, ...state.loaded]);
  return schemas.filter((s) => keep.has(s.name));
}

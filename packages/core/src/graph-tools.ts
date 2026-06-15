import { z } from "zod";
import { scopeKey, type AssertFactInput, type Fact, type FactQuery, type MemoryPort, type Scope } from "@eidentic/types";
import { createTool, type Tool } from "./tool.js";
import { sha256Hex } from "./sha256.js";

/** A MemoryPort that also exposes the temporal knowledge graph. */
export interface GraphMemory extends MemoryPort {
  /** True only when a graph backend is actually configured. Always false when no graph was provided. */
  readonly graphEnabled: boolean;
  assertFact(scope: Scope, input: AssertFactInput): Promise<{ asserted: Fact; invalidated: Fact[] }>;
  queryFacts(query: FactQuery): Promise<Fact[]>;
}

/** Structural guard: true only when a graph backend is configured AND the methods are present. */
export function hasGraph(m: unknown): m is GraphMemory {
  const g = m as Partial<GraphMemory>;
  return g.graphEnabled === true && typeof g.assertFact === "function" && typeof g.queryFacts === "function";
}

/** Clamp a model-supplied confidence to [0, 1]. Returns 1 for undefined/NaN/Infinity/non-number. */
function clamp01(c: unknown): number {
  if (typeof c !== "number" || !isFinite(c)) return 1;
  return Math.min(1, Math.max(0, c));
}

/** Compact a Fact for the model (drop nothing material; keep it terse). */
function compactFact(f: Fact): unknown {
  return {
    subject: f.subject,
    predicate: f.predicate,
    object: f.object,
    objectKind: f.objectKind,
    validFrom: f.validFrom,
    ...(f.validUntil !== undefined ? { validUntil: f.validUntil } : {}),
    confidence: f.confidence,
  };
}

/**
 * Two knowledge-graph tools bound to a memory + scope.
 * `graph_query` is read-only (runs concurrently); `graph_assert` is destructive (serialized).
 * These occupy the reserved `graph_*` tool-id namespace and are appended after user + memory_* tools.
 */
export function graphTools(memory: GraphMemory, scope: Scope): Tool[] {
  return [
    createTool({
      id: "graph_query",
      description:
        "Query the temporal knowledge graph for facts. Omit `validAt` for currently-valid facts; " +
        "pass an ISO `validAt` for point-in-time ('what was true at time T'). " +
        "Filters (subject/predicate/object) are optional AND-combined.",
      inputSchema: z.object({
        subject: z.string().optional(),
        predicate: z.string().optional(),
        object: z.string().optional(),
        validAt: z.string().optional(),
      }),
      sideEffect: "read-only",
      execute: async ({ input }) => {
        const facts = await memory.queryFacts({
          scope,
          ...(input.subject !== undefined ? { subject: input.subject } : {}),
          ...(input.predicate !== undefined ? { predicate: input.predicate } : {}),
          ...(input.object !== undefined ? { object: input.object } : {}),
          ...(input.validAt !== undefined ? { validAt: input.validAt } : {}),
        });
        return { facts: facts.map(compactFact) };
      },
    }),
    createTool({
      id: "graph_assert",
      description:
        "Assert a fact (subject, predicate, object) into the temporal knowledge graph. " +
        "Asserting a DIFFERENT object for the same (subject, predicate) invalidates the prior fact " +
        "(sets its validUntil) — it is superseded, not deleted. Re-asserting the same object is a no-op. " +
        "Use `objectKind:'entity'` when the object names another entity, else it defaults to 'literal'.",
      inputSchema: z.object({
        subject: z.string(),
        predicate: z.string(),
        object: z.string(),
        objectKind: z.enum(["entity", "literal"]).optional(),
        confidence: z.number().optional(),
      }),
      sideEffect: "destructive",
      idempotencyKey: async (input) =>
        `graph_assert:${scopeKey(scope)}:${await sha256Hex(JSON.stringify({
          subject: input.subject,
          predicate: input.predicate,
          object: input.object,
          objectKind: input.objectKind ?? "literal",
          confidence: clamp01(input.confidence),
        }))}`,
      execute: async ({ input }) => {
        const r = await memory.assertFact(scope, {
          subject: input.subject,
          predicate: input.predicate,
          object: input.object,
          ...(input.objectKind !== undefined ? { objectKind: input.objectKind } : {}),
          confidence: clamp01(input.confidence),
        });
        return { asserted: compactFact(r.asserted), invalidated: r.invalidated.map(compactFact) };
      },
    }),
  ];
}

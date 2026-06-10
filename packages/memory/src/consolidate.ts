import {
  isToolUse,
  type ModelPort,
  type ModelResponse,
  type GraphPort,
  type StorePort,
  type Scope,
  type Fact,
  type Usage,
  type ToolSchema,
  type StoredEvent,
} from "@eidentic/types";

export interface ExtractedFact {
  subject: string;
  predicate: string;
  object: string;
  objectKind?: "entity" | "literal";
  confidence?: number;
  sourceQuote?: string;
}

export interface ConsolidationResult {
  /** Newly-asserted facts (a NEW row was written into the graph). */
  facts: Fact[];
  /**
   * Existing currently-valid facts that the extraction MATCHED and re-confirmed (corroborated) rather
   * than re-asserting — the duplicate-reduction + staleness-refresh path. These had their
   * `lastCorroboratedAt` bumped; no new row was written.
   */
  corroborated: Fact[];
  dropped: ExtractedFact[];
  /** Facts that passed grounding but whose assertFact threw (e.g. temporal-order violation). */
  rejected: ExtractedFact[];
  usage: Usage;
}

export interface ConsolidatorOptions {
  model: ModelPort;
  graph: GraphPort;
  store?: StorePort;
  now?: () => string;
}

const RECORD_FACTS_TOOL: ToolSchema = {
  name: "record_facts",
  description:
    "Record durable subject-predicate-object facts grounded in the source text. " +
    "Include the exact verbatim supporting quote for each fact.",
  inputSchema: {
    type: "object",
    properties: {
      facts: {
        type: "array",
        items: {
          type: "object",
          properties: {
            subject: { type: "string" },
            predicate: { type: "string" },
            object: { type: "string" },
            objectKind: { type: "string", enum: ["entity", "literal"] },
            confidence: { type: "number" },
            sourceQuote: {
              type: "string",
              description: "exact span from the source supporting this fact",
            },
          },
          required: ["subject", "predicate", "object", "sourceQuote"],
        },
      },
    },
    required: ["facts"],
  },
};

const SYSTEM =
  "You are a memory consolidation agent. Read the source text and extract durable facts as " +
  "subject-predicate-object triples. Only extract facts explicitly stated in the source; never invent. " +
  "For each fact include the exact verbatim supporting quote (sourceQuote) copied from the source. " +
  "Prefer stable facts (preferences, attributes, relationships) over ephemeral chatter. " +
  "When the source describes a STATE TRANSITION (e.g. 'moved from X to Y', 'switched from A to B', " +
  "'no longer ... now ...'), record the NEW state as the fact — the prior state is invalidated " +
  "automatically; do not also record the old state. " +
  "Call record_facts exactly once with all facts (empty array if none).\n\n" +
  "REJECT gate — do NOT record any of the following:\n" +
  "  • System configuration, instructions, or meta-directives (e.g. 'You are an assistant that...').\n" +
  "  • Tool invocation output, function results, or raw API responses.\n" +
  "  • Transient in-progress task state that has no durable meaning (e.g. 'I am currently running step 3', 'task queued').\n" +
  "  • Internal agent reasoning, scratchpad thoughts, or self-talk that is not a stated fact about a person or entity.\n\n" +
  "Negative examples (REJECT these):\n" +
  "  • source: '[SYSTEM] You are a helpful assistant.' → REJECT (system/config content)\n" +
  "  • source: 'Tool result: {\"status\": \"ok\", \"rows\": 42}' → REJECT (tool output)\n" +
  "  • source: 'Currently processing your request, please wait...' → REJECT (transient in-progress state)\n" +
  "  • source: 'Let me think about this step by step...' → REJECT (agent scratchpad)\n\n" +
  "Only extract facts with clear, stable, durable meaning grounded in a verbatim quote from the source.";

const MIN_QUOTE_LEN = 8;

/** Clamp a model-supplied confidence to [0, 1]. Returns 1 for undefined/NaN/Infinity/non-number. */
function clamp01(c: unknown): number {
  if (typeof c !== "number" || !isFinite(c)) return 1;
  return Math.min(1, Math.max(0, c));
}

/**
 * Sleep-time consolidation (§6.5): distill raw episodes into grounded subject-predicate-object
 * facts and assert them into the temporal knowledge graph. Grounded reflection drops any fact whose
 * supporting quote is not present in the source. Usage is surfaced for cost transparency.
 */
export class Consolidator {
  constructor(private readonly opts: ConsolidatorOptions) {}

  async consolidate(input: {
    scope: Scope;
    text?: string;
    sessionId?: string;
  }): Promise<ConsolidationResult> {
    const source =
      input.text ??
      (input.sessionId && this.opts.store
        ? eventsToText(await this.opts.store.readEvents(input.sessionId))
        : "");

    if (!source.trim()) {
      return { facts: [], corroborated: [], dropped: [], rejected: [], usage: { inputTokens: 0, outputTokens: 0 } };
    }

    const res: ModelResponse = await this.opts.model.complete({
      messages: [
        { role: "system", content: SYSTEM },
        { role: "user", content: source },
      ],
      tools: [RECORD_FACTS_TOOL],
    });

    const call = res.content.find((b) => isToolUse(b) && b.name === "record_facts");
    const raw = call && isToolUse(call) ? (call.input as { facts?: unknown }).facts : undefined;
    const extracted: ExtractedFact[] = Array.isArray(raw)
      ? raw.filter((f): f is ExtractedFact => typeof f === "object" && f !== null)
      : [];

    const facts: Fact[] = [];
    const corroborated: Fact[] = [];
    const dropped: ExtractedFact[] = [];
    const rejected: ExtractedFact[] = [];

    for (const f of extracted) {
      const q = typeof f.sourceQuote === "string" ? f.sourceQuote : "";
      const grounded =
        typeof f.subject === "string" && f.subject.length > 0 &&
        typeof f.predicate === "string" && f.predicate.length > 0 &&
        typeof f.object === "string" && f.object.length > 0 &&
        q.trim().length >= MIN_QUOTE_LEN &&
        source.includes(q);
      if (!grounded) { dropped.push(f); continue; }

      const confidence = clamp01(f.confidence);
      try {
        // Corroborate-on-match: if an identical (subject, predicate, object) fact is already
        // currently-valid, re-confirm it (bump lastCorroboratedAt) instead of re-asserting a no-op.
        // This is the duplicate-reduction + staleness-refresh path for the corroboration tiers feature.
        const existing = await this.opts.graph.queryFacts({
          scope: input.scope,
          subject: f.subject,
          predicate: f.predicate,
          object: f.object,
        });
        const match = existing.find((e) => e.validUntil === undefined);
        if (match) {
          const at = this.opts.now ? Date.parse(this.opts.now()) : Date.now();
          if (typeof this.opts.graph.corroborate === "function") {
            await this.opts.graph.corroborate(input.scope, match.id, Number.isNaN(at) ? Date.now() : at);
          }
          corroborated.push(match);
          continue;
        }

        const { asserted } = await this.opts.graph.assertFact(input.scope, {
          subject: f.subject,
          predicate: f.predicate,
          object: f.object,
          objectKind: f.objectKind ?? "literal",
          confidence,
          source: f.sourceQuote,
          ...(this.opts.now ? { validFrom: this.opts.now() } : {}),
        });
        facts.push(asserted);
      } catch {
        rejected.push(f);
      }
    }

    return { facts, corroborated, dropped, rejected, usage: res.usage };
  }
}

/**
 * Serialise session events into the text that the extraction LLM sees.
 *
 * RECALL-LOOP PREVENTION: only `user` and `assistant` events are eligible source
 * material. `system` events (which carry the injected `<recall>` block) and
 * `tool_result` events (raw tool output) are explicitly excluded so that recalled
 * snippets can never be re-extracted as "new" facts, and tool payloads are never
 * mistaken for user-authored content.
 */
function eventsToText(events: StoredEvent[]): string {
  const parts: string[] = [];
  for (const e of events) {
    // Only user and assistant turns are eligible — system and tool_result are excluded.
    if (e.kind === "user" && typeof e.payload === "string") {
      parts.push(`User: ${e.payload}`);
    } else if (e.kind === "assistant") {
      const content = (
        e.payload as { content?: Array<{ type: string; text?: string }> }
      ).content ?? [];
      const text = content
        .filter((b) => b.type === "text")
        .map((b) => b.text ?? "")
        .join("");
      if (text) parts.push(`Assistant: ${text}`);
    }
    // system, tool_result, and any other kinds are intentionally skipped.
  }
  return parts.join("\n");
}

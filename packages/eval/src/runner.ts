import type { StoredEvent } from "@eidentic/types";

export interface RunnerResult {
  sessionId: string;
  events: StoredEvent[];
  finalText?: string;
  finalSubtype?: string;
}

export type Runner = (input: string) => Promise<RunnerResult>;

/**
 * Structural shape of a `@eidentic/core` Agent (NO runtime import — keeps the runtime dep at
 * @eidentic/types only). Any object exposing `query(input, {sessionId}) => AsyncIterable<StreamEventLike>`
 * satisfies it, including the real Agent.
 */
interface StreamEventLike {
  type: string;
  subtype?: string;
  output?: unknown;
  sessionId?: string;
}
interface AgentLike {
  query(input: string, opts: { sessionId: string }): AsyncIterable<StreamEventLike>;
}
/** Reads the event log from a store-like object after the run completes. */
interface EventSource {
  readEvents(sessionId: string): Promise<StoredEvent[]>;
}

/**
 * Adapt a core `Agent` (+ its store) into a `Runner`. Drains the agent's stream to capture the
 * terminal `result` (output text + subtype), then reads the persisted event log from the store as
 * the trajectory source. `newSessionId` lets tests supply deterministic ids.
 */
export function createRunner(
  agent: AgentLike,
  store: EventSource,
  opts?: { newSessionId?: () => string },
): Runner {
  let counter = 0;
  const newId = opts?.newSessionId ?? (() => `eval_${(counter++).toString(36)}_${Date.now().toString(36)}`);
  return async (input: string): Promise<RunnerResult> => {
    const sessionId = newId();
    let finalText: string | undefined;
    let finalSubtype: string | undefined;
    for await (const e of agent.query(input, { sessionId })) {
      if (e.type === "result") {
        finalSubtype = e.subtype;
        finalText = typeof e.output === "string" ? e.output : e.output == null ? undefined : String(e.output);
      }
    }
    const events = await store.readEvents(sessionId);
    return { sessionId, events, ...(finalText !== undefined ? { finalText } : {}), ...(finalSubtype !== undefined ? { finalSubtype } : {}) };
  };
}

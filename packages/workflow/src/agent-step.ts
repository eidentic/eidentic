import type { Agent } from "@eidentic/core";
import type { ContentBlock, StreamEvent } from "@eidentic/types";
import { randomUUID } from "node:crypto";
import type { Step, StepContext } from "./types.js";

// ─── Terminal result event type (from protocol.ts) ───────────────────────────

/** The terminal `result` event emitted by agent.query(). */
export type AgentResultEvent = Extract<StreamEvent, { type: "result" }>;

// ─── agentStep() ─────────────────────────────────────────────────────────────

export interface AgentStepOptions<I, O> {
  /** Convert the workflow input into the string/blocks the agent expects. */
  toInput?: (i: I) => string | ContentBlock[];
  /** Extract the step output from the terminal result event. */
  fromOutput?: (terminal: AgentResultEvent) => O;
  /** Session ID or factory. Defaults to a fresh UUID per invocation. */
  sessionId?: string | ((i: I) => string);
  /**
   * Optional tenant principal to forward into every `agent.query()` call.
   * Enables per-user session scoping and ownership tracking in agent stores.
   */
  userId?: string;
  /** Organization identifier forwarded into every `agent.query()` call. */
  orgId?: string;
  /** API key identity forwarded into every `agent.query()` call. */
  apiKey?: string;
}

/**
 * Wraps an `Agent` as a workflow `Step`.
 *
 * Drains `agent.query()` to the terminal `result` event. The default
 * `fromOutput` returns `terminal.object ?? terminal.output` (so structured
 * output works out of the box).
 *
 * A non-success terminal (`subtype !== "success"`) throws an Error carrying
 * the subtype + output so workflow error handling (retry, fallback) kicks in.
 * The parent signal is forwarded into every query call.
 */
export function agentStep<I = string, O = unknown>(
  agent: Agent,
  adapt?: AgentStepOptions<I, O>,
): Step<I, O> {
  const toInput = adapt?.toInput ?? ((i: I) => (typeof i === "string" ? i : JSON.stringify(i)));
  const fromOutput =
    adapt?.fromOutput ??
    ((terminal: AgentResultEvent) => (terminal.object ?? terminal.output) as O);
  const sessionIdOpt = adapt?.sessionId;

  return async (input: I, ctx: StepContext): Promise<O> => {
    ctx.signal?.throwIfAborted?.();

    const rawSessionId =
      typeof sessionIdOpt === "function"
        ? sessionIdOpt(input)
        : sessionIdOpt ?? `wf_${randomUUID()}`;

    const queryInput = toInput(input);
    let terminal: AgentResultEvent | undefined;

    for await (const ev of agent.query(queryInput, {
      sessionId: rawSessionId,
      ...(ctx.signal ? { signal: ctx.signal } : {}),
      ...(adapt?.userId !== undefined ? { userId: adapt.userId } : {}),
      ...(adapt?.orgId !== undefined ? { orgId: adapt.orgId } : {}),
      ...(adapt?.apiKey !== undefined ? { apiKey: adapt.apiKey } : {}),
    })) {
      if (ev.type === "result") {
        terminal = ev;
      }
    }

    if (!terminal) {
      throw new Error("agentStep: agent.query() yielded no result event");
    }

    if (terminal.subtype !== "success") {
      throw new Error(
        `agentStep: agent terminated with subtype="${terminal.subtype}" output=${JSON.stringify(terminal.output)}`,
      );
    }

    return fromOutput(terminal);
  };
}

import { useState, useEffect } from "react";
import { api, type SessionRecord, type StoredEvent } from "../api.js";

function formatUsd(usd: number | undefined): string {
  if (usd === undefined) return "—";
  return "$" + usd.toFixed(4);
}

interface Props {
  agentId: string;
}

function formatDate(s: string) {
  try {
    return new Date(s).toLocaleString();
  } catch {
    return s;
  }
}

// ---------------------------------------------------------------------------
// Raw event view (existing expandable list)
// ---------------------------------------------------------------------------

function EventTypeColor(kind: string): string {
  if (kind === "user") return "event-type-user";
  if (kind === "assistant") return "event-type-assistant";
  if (kind === "tool_use") return "event-type-tool_use";
  if (kind === "tool_result") return "event-type-tool_result";
  return "event-type-result";
}

type ContentBlock = { type: string; text?: string; name?: string; input?: unknown };

function EventItem({ event }: { event: StoredEvent }) {
  const [open, setOpen] = useState(false);
  const kind = event.kind;

  const summary = (): string => {
    const payload = event.payload as Record<string, unknown> | string | null | undefined;

    if (kind === "user") {
      if (typeof payload === "string") return payload.slice(0, 120);
    }

    if (kind === "assistant") {
      const p = payload as { content?: ContentBlock[] } | null | undefined;
      const blocks = p?.content;
      const usage = event.meta?.usage;
      const usageSuffix = usage
        ? `  [in:${usage.inputTokens} out:${usage.outputTokens}${usage.cachedInputTokens ? ` cached:${usage.cachedInputTokens}` : ""}]`
        : "";
      if (Array.isArray(blocks)) {
        const textBlock = blocks.find((b) => b.type === "text");
        if (textBlock?.text) return String(textBlock.text).slice(0, 100) + usageSuffix;
        const toolBlock = blocks.find((b) => b.type === "tool_use");
        if (toolBlock) {
          return `tool_use: ${String(toolBlock.name ?? "")}(${JSON.stringify(toolBlock.input ?? {}).slice(0, 60)})${usageSuffix}`;
        }
      }
      if (usage) return `[no text]${usageSuffix}`;
    }

    if (kind === "tool_result") {
      const p = payload as { callId?: string; toolName?: string; output?: unknown } | null | undefined;
      const toolName = String(p?.toolName ?? "");
      const output = p?.output;
      const snippet = typeof output === "string" ? output : JSON.stringify(output ?? null);
      return `${toolName} → ${snippet.slice(0, 100)}`;
    }

    // compaction / suspension / checkpoint / tool_call / unknown
    const snippet = JSON.stringify(payload).slice(0, 100);
    return `${kind}: ${snippet}`;
  };

  const badgeVariant = kind === "user" ? "green" : kind === "assistant" ? "blue" : kind === "tool_result" ? "yellow" : "gray";

  return (
    <div className={`event-item ${EventTypeColor(kind)}`}>
      <div className="event-header" onClick={() => setOpen((o) => !o)}>
        <span className={`badge badge-${badgeVariant}`}>
          {kind}
        </span>
        <span className="text2 text-sm mono" style={{ marginLeft: 6 }}>#{event.seq}</span>
        <span className="text2 text-sm flex-1 mono" style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", marginLeft: 8 }}>
          {summary()}
        </span>
        <span className="text2 text-sm">{open ? "▲" : "▼"}</span>
      </div>
      {open && (
        <div className="event-body">
          <pre>{JSON.stringify(event, null, 2)}</pre>
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Timeline view — readable causal narrative
// ---------------------------------------------------------------------------

interface TimelineNode {
  kind: "user" | "assistant_text" | "tool_call" | "tool_result" | "result" | "compaction" | "other";
  seq: number;
  // user
  userText?: string;
  // assistant_text
  assistantText?: string;
  usage?: { inputTokens: number; outputTokens: number; cachedInputTokens?: number };
  // tool_call (from assistant content blocks)
  toolName?: string;
  toolInput?: unknown;
  toolCallId?: string;
  // tool_result
  toolResultName?: string;
  toolOutput?: unknown;
  toolIsError?: boolean;
  callId?: string;
  // result
  resultSubtype?: string;
  resultTurns?: number;
  resultUsage?: { inputTokens?: number; outputTokens?: number };
  resultUsd?: number;
  // compaction
  compactionReason?: string;
  // other
  rawKind?: string;
  rawSnippet?: string;
}

function buildTimeline(events: StoredEvent[]): TimelineNode[] {
  const nodes: TimelineNode[] = [];

  for (const ev of events) {
    const kind = ev.kind;

    if (kind === "user") {
      const text = typeof ev.payload === "string" ? ev.payload : JSON.stringify(ev.payload ?? null);
      nodes.push({ kind: "user", seq: ev.seq, userText: text });
      continue;
    }

    if (kind === "assistant") {
      const p = ev.payload as { content?: ContentBlock[] } | null | undefined;
      const blocks: ContentBlock[] = Array.isArray(p?.content) ? (p!.content as ContentBlock[]) : [];
      const usage = ev.meta?.usage;

      // Emit text block first, then tool_use blocks
      const textBlock = blocks.find((b) => b.type === "text");
      const toolBlocks = blocks.filter((b) => b.type === "tool_use");

      if (textBlock?.text) {
        nodes.push({
          kind: "assistant_text",
          seq: ev.seq,
          assistantText: textBlock.text,
          usage,
        });
      } else if (toolBlocks.length === 0) {
        // assistant with no text and no tool calls — maybe just usage
        nodes.push({
          kind: "assistant_text",
          seq: ev.seq,
          assistantText: "",
          usage,
        });
      }

      for (const tb of toolBlocks) {
        nodes.push({
          kind: "tool_call",
          seq: ev.seq,
          toolName: String(tb.name ?? ""),
          toolInput: tb.input,
          toolCallId: (tb as Record<string, unknown>)["id"] as string | undefined,
          usage: textBlock ? undefined : usage, // attach usage to first tool if no text
        });
      }
      continue;
    }

    if (kind === "tool_result") {
      const p = ev.payload as { callId?: string; toolName?: string; output?: unknown; isError?: boolean } | null | undefined;
      nodes.push({
        kind: "tool_result",
        seq: ev.seq,
        toolResultName: String(p?.toolName ?? ""),
        toolOutput: p?.output,
        toolIsError: Boolean(p?.isError),
        callId: p?.callId,
      });
      continue;
    }

    if (kind === "result") {
      const p = ev.payload as {
        subtype?: string; numTurns?: number;
        usage?: { inputTokens?: number; outputTokens?: number };
        usd?: number;
      } | null | undefined;
      nodes.push({
        kind: "result",
        seq: ev.seq,
        resultSubtype: p?.subtype,
        resultTurns: p?.numTurns,
        resultUsage: p?.usage,
        resultUsd: p?.usd,
      });
      continue;
    }

    if (kind === "compaction") {
      const p = ev.payload as { reason?: string } | null | undefined;
      nodes.push({
        kind: "compaction",
        seq: ev.seq,
        compactionReason: p?.reason,
      });
      continue;
    }

    // Anything else: show a minimal other row
    nodes.push({
      kind: "other",
      seq: ev.seq,
      rawKind: kind,
      rawSnippet: JSON.stringify(ev.payload ?? null).slice(0, 80),
    });
  }

  return nodes;
}

function TimelineNodeItem({ node, modelId }: { node: TimelineNode; modelId?: string }) {
  const [expanded, setExpanded] = useState(false);

  if (node.kind === "user") {
    return (
      <div className="tl-node tl-user">
        <div className="tl-pill tl-pill-user">user</div>
        <div className="tl-body">
          <span style={{ whiteSpace: "pre-wrap", wordBreak: "break-word" }}>{node.userText}</span>
        </div>
      </div>
    );
  }

  if (node.kind === "assistant_text") {
    const hasText = node.assistantText && node.assistantText.length > 0;
    const usage = node.usage;
    return (
      <div className="tl-node tl-assistant">
        <div className="tl-pill tl-pill-assistant">assistant</div>
        <div className="tl-body">
          {hasText ? (
            <span style={{ whiteSpace: "pre-wrap", wordBreak: "break-word" }}>{node.assistantText}</span>
          ) : (
            <span className="text2 text-sm">[no text output]</span>
          )}
          {usage && (
            <div className="tl-usage">
              in:{usage.inputTokens} out:{usage.outputTokens}
              {usage.cachedInputTokens ? ` cached:${usage.cachedInputTokens}` : ""}
            </div>
          )}
        </div>
      </div>
    );
  }

  if (node.kind === "tool_call") {
    const inputStr = JSON.stringify(node.toolInput ?? {}, null, 2);
    const inputSnippet = inputStr.length > 120 ? inputStr.slice(0, 120) + "…" : inputStr;
    return (
      <div className="tl-node tl-tool-call">
        <div className="tl-pill tl-pill-tool">tool call</div>
        <div className="tl-body">
          <div className="tl-tool-name">
            {node.toolName}
            <button
              className="btn btn-ghost btn-sm"
              style={{ marginLeft: 8, padding: "1px 6px", fontSize: 11 }}
              onClick={() => setExpanded((e) => !e)}
            >
              {expanded ? "hide args" : "args"}
            </button>
          </div>
          {!expanded && (
            <div className="text2 text-sm mono" style={{ marginTop: 2 }}>{inputSnippet}</div>
          )}
          {expanded && (
            <pre style={{ marginTop: 6, fontSize: 11 }}>{inputStr}</pre>
          )}
          {node.usage && (
            <div className="tl-usage">
              in:{node.usage.inputTokens} out:{node.usage.outputTokens}
              {node.usage.cachedInputTokens ? ` cached:${node.usage.cachedInputTokens}` : ""}
            </div>
          )}
        </div>
      </div>
    );
  }

  if (node.kind === "tool_result") {
    const outputStr = typeof node.toolOutput === "string"
      ? node.toolOutput
      : JSON.stringify(node.toolOutput ?? null, null, 2);
    const outputSnippet = outputStr.length > 200 ? outputStr.slice(0, 200) + "…" : outputStr;
    return (
      <div className={`tl-node ${node.toolIsError ? "tl-tool-result-error" : "tl-tool-result"}`}>
        <div className={`tl-pill ${node.toolIsError ? "tl-pill-error" : "tl-pill-result"}`}>
          {node.toolIsError ? "tool error" : "tool result"}
        </div>
        <div className="tl-body">
          <div className="tl-tool-name">{node.toolResultName}</div>
          <div
            className="text2 text-sm mono"
            style={{ marginTop: 4, whiteSpace: "pre-wrap", wordBreak: "break-word", cursor: outputStr.length > 200 ? "pointer" : undefined }}
            onClick={() => outputStr.length > 200 && setExpanded((e) => !e)}
          >
            {expanded ? outputStr : outputSnippet}
            {outputStr.length > 200 && (
              <span style={{ color: "var(--accent)", marginLeft: 6 }}>{expanded ? "↑ collapse" : "↓ expand"}</span>
            )}
          </div>
        </div>
      </div>
    );
  }

  if (node.kind === "result") {
    const sub = node.resultSubtype ?? "success";
    const isError = sub !== "success" && sub !== "suspended";
    const isSuspended = sub === "suspended";
    const uStr = node.resultUsage
      ? ` · in:${node.resultUsage.inputTokens ?? 0} out:${node.resultUsage.outputTokens ?? 0}`
      : "";
    const usdStr = node.resultUsd !== undefined ? ` · $${node.resultUsd.toFixed(6)}` : "";
    return (
      <div className={`tl-node ${isError ? "tl-result-error" : isSuspended ? "tl-result-suspended" : "tl-result"}`}>
        <div className={`tl-pill ${isError ? "tl-pill-error" : isSuspended ? "tl-pill-suspended" : "tl-pill-done"}`}>
          {isSuspended ? "suspended" : isError ? sub : "done"}
        </div>
        <div className="tl-body text2 text-sm">
          {node.resultTurns !== undefined ? `${node.resultTurns} turn${node.resultTurns !== 1 ? "s" : ""}` : ""}
          {uStr}{usdStr}
          {isSuspended && (
            <div style={{ marginTop: 4, color: "var(--yellow)" }}>
              Awaiting human approval — use <code>agent.resume(sessionId)</code> to continue.
            </div>
          )}
          {isError && (
            <div style={{ marginTop: 4, color: "var(--red)" }}>subtype: {sub}</div>
          )}
        </div>
      </div>
    );
  }

  if (node.kind === "compaction") {
    return (
      <div className="tl-node tl-compaction">
        <div className="tl-pill tl-pill-compaction">compacted</div>
        <div className="tl-body text2 text-sm">
          Context window compacted{node.compactionReason ? `: ${node.compactionReason}` : "."}
        </div>
      </div>
    );
  }

  // other
  return (
    <div className="tl-node tl-other">
      <div className="tl-pill tl-pill-other">{node.rawKind ?? "event"}</div>
      <div className="tl-body text2 text-sm mono">{node.rawSnippet}</div>
    </div>
  );
}

function TimelineView({ events, modelId }: { events: StoredEvent[]; modelId?: string }) {
  const nodes = buildTimeline(events);
  if (nodes.length === 0) {
    return <div className="empty-state">No events recorded for this session.</div>;
  }
  return (
    <div className="tl-container">
      {nodes.map((n, i) => (
        <TimelineNodeItem key={i} node={n} modelId={modelId} />
      ))}
    </div>
  );
}

// ---------------------------------------------------------------------------
// URL hash helpers — encode/restore selected sessionId for shareable links
// ---------------------------------------------------------------------------

/**
 * Read the `session` key from the URL hash fragment.
 * Hash format: `#session=<id>` (other keys ignored).
 */
function readSessionHash(): string | null {
  try {
    const hash = window.location.hash.slice(1); // strip leading "#"
    const params = new URLSearchParams(hash);
    return params.get("session") ?? null;
  } catch {
    return null;
  }
}

/**
 * Write the selected session ID into the URL hash without adding a history entry.
 * Pass null to remove the `session` key.
 */
function writeSessionHash(sessionId: string | null): void {
  try {
    const params = new URLSearchParams(window.location.hash.slice(1));
    if (sessionId) {
      params.set("session", sessionId);
    } else {
      params.delete("session");
    }
    const newHash = params.toString() ? "#" + params.toString() : "";
    // replaceState keeps the URL tidy without pushing a history entry.
    window.history.replaceState(null, "", window.location.pathname + window.location.search + newHash);
  } catch {
    // best-effort — non-browser environments (SSR/test) may not have history
  }
}

// ---------------------------------------------------------------------------
// SessionsView
// ---------------------------------------------------------------------------

export function SessionsView({ agentId }: Props) {
  const [sessions, setSessions] = useState<SessionRecord[]>([]);
  const [selected, setSelected] = useState<string | null>(() => readSessionHash());
  const [events, setEvents] = useState<StoredEvent[]>([]);
  const [loading, setLoading] = useState(false);
  const [eventsLoading, setEventsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [traceMode, setTraceMode] = useState<"timeline" | "raw">("timeline");

  const loadEvents = (sid: string) => {
    setSelected(sid);
    writeSessionHash(sid);
    setEventsLoading(true);
    api.sessions
      .events(agentId, sid)
      .then(({ events: evs }) => setEvents(evs))
      .catch((e: unknown) => setError(String(e)))
      .finally(() => setEventsLoading(false));
  };

  useEffect(() => {
    setLoading(true);
    setSelected(null);
    writeSessionHash(null);
    setEvents([]);
    api.sessions
      .list(agentId, 50)
      .then((list) => {
        setSessions(list);
        // Restore the hash-selected session if it belongs to the current agent's list.
        const fromHash = readSessionHash();
        if (fromHash && list.some((s) => s.id === fromHash)) {
          loadEvents(fromHash);
        }
      })
      .catch((e: unknown) => setError(String(e)))
      .finally(() => setLoading(false));
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [agentId]);

  return (
    <div>
      <div className="view-title">Sessions / Trace</div>
      <div className="view-subtitle" style={{ marginBottom: 16 }}>
        Agent: <strong>{agentId}</strong>
      </div>
      {error && <div className="error-msg">{error}</div>}
      <div className="split" style={{ alignItems: "start" }}>
        <div className="card">
          <div className="card-header">
            <span className="card-title">Sessions ({sessions.length})</span>
            <button
              className="btn btn-ghost btn-sm"
              onClick={() => {
                setLoading(true);
                api.sessions.list(agentId, 50).then(setSessions).finally(() => setLoading(false));
              }}
            >
              Refresh
            </button>
          </div>
          {loading ? (
            <div className="loading" style={{ padding: "12px" }}>Loading…</div>
          ) : sessions.length === 0 ? (
            <div className="empty-state">No sessions yet.</div>
          ) : (
            <div className="session-list">
              {sessions.map((s) => (
                <div
                  key={s.id}
                  className={`session-item${selected === s.id ? " active" : ""}`}
                  onClick={() => loadEvents(s.id)}
                >
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div className="mono text-sm">{s.id.slice(0, 20)}…</div>
                    <div className="text2 text-sm">{formatDate(s.createdAt)}</div>
                    {s.usage && (
                      <div className="text2 text-sm mono" style={{ marginTop: 2 }}>
                        {s.usage.inputTokens}+{s.usage.outputTokens} tok
                        {s.usage.cachedInputTokens > 0 ? ` (${s.usage.cachedInputTokens} cached)` : ""}
                        {"  "}{formatUsd(s.usd)}
                      </div>
                    )}
                  </div>
                  <span className="text2">›</span>
                </div>
              ))}
            </div>
          )}
        </div>
        <div className="card">
          <div className="card-header">
            <span className="card-title">
              {selected ? `Trace: ${selected.slice(0, 16)}…` : "Select a session"}
            </span>
            {selected && (
              <div style={{ display: "flex", gap: 4 }}>
                <button
                  className={`btn btn-sm ${traceMode === "timeline" ? "btn-primary" : "btn-ghost"}`}
                  onClick={() => setTraceMode("timeline")}
                  title="Readable causal timeline"
                >
                  Timeline
                </button>
                <button
                  className={`btn btn-sm ${traceMode === "raw" ? "btn-primary" : "btn-ghost"}`}
                  onClick={() => setTraceMode("raw")}
                  title="Raw stored events"
                >
                  Raw
                </button>
              </div>
            )}
          </div>
          {eventsLoading ? (
            <div className="loading" style={{ padding: "12px" }}>Loading events…</div>
          ) : !selected ? (
            <div className="empty-state">Click a session to view its event trace.</div>
          ) : events.length === 0 ? (
            <div className="empty-state">No events recorded for this session.</div>
          ) : traceMode === "timeline" ? (
            <div className="card-body">
              <TimelineView events={events} />
            </div>
          ) : (
            <div className="card-body">
              <div className="event-list">
                {events.map((ev) => (
                  <EventItem key={ev.id} event={ev} />
                ))}
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

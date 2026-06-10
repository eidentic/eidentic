import { useState, useRef, useEffect } from "react";
import { authHeaders } from "../api.js";

interface Props {
  agentId: string;
}

interface ConsoleEntry {
  type: "user" | "event" | "error" | "info" | "compaction" | "suspended";
  label: string;
  text: string;
  streaming?: boolean;
  /** For suspended: the session id so we can call resume */
  sessionId?: string;
}

// ---------------------------------------------------------------------------
// HITL approval card — shown when result.subtype === "suspended"
// ---------------------------------------------------------------------------

function HitlCard({
  agentId,
  sessionId,
  onResumed,
}: {
  agentId: string;
  sessionId: string;
  onResumed: (approved: boolean) => void;
}) {
  const [pending, setPending] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);

  const decide = async (approved: boolean) => {
    setPending(true);
    setMsg(null);
    try {
      const res = await fetch(`/v1/agents/${encodeURIComponent(agentId)}/resume`, {
        method: "POST",
        headers: { "content-type": "application/json", ...authHeaders() },
        body: JSON.stringify({ sessionId, decision: approved ? "approve" : "reject" }),
      });
      if (!res.ok) {
        setMsg(`Resume failed: HTTP ${res.status}`);
        return;
      }
      onResumed(approved);
    } catch (e: unknown) {
      setMsg(String(e));
    } finally {
      setPending(false);
    }
  };

  return (
    <div className="hitl-card">
      <div className="hitl-header">
        <span className="badge badge-yellow">awaiting approval</span>
        <span className="text2 text-sm" style={{ marginLeft: 8 }}>
          The agent paused and is requesting human input.
        </span>
      </div>
      <div className="hitl-actions">
        <button
          className="btn btn-primary btn-sm"
          onClick={() => decide(true)}
          disabled={pending}
        >
          {pending ? "…" : "Approve"}
        </button>
        <button
          className="btn btn-ghost btn-sm"
          onClick={() => decide(false)}
          disabled={pending}
          style={{ borderColor: "var(--red)", color: "var(--red)" }}
        >
          {pending ? "…" : "Reject"}
        </button>
      </div>
      {msg && <div className="error-msg" style={{ marginTop: 4 }}>{msg}</div>}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Chat bubble renderer
// ---------------------------------------------------------------------------

function ChatBubble({ entry }: { entry: ConsoleEntry }) {
  const isUser = entry.type === "user";
  const isError = entry.type === "error";
  const isInfo = entry.type === "info";
  const isCompaction = entry.type === "compaction";

  if (isCompaction) {
    return (
      <div className="bubble-system-row">
        <div className="bubble-system">
          <span style={{ opacity: 0.6, marginRight: 4 }}>⊙</span>
          {entry.text}
        </div>
      </div>
    );
  }

  if (isInfo) {
    return (
      <div className="bubble-system-row">
        <div className="bubble-system bubble-done">{entry.text}</div>
      </div>
    );
  }

  if (entry.label === "tool" || entry.label === "tool_result") {
    return (
      <div className="bubble-system-row">
        <div className="bubble-tool">
          <span className="bubble-tool-label">{entry.label}</span>
          <span style={{ marginLeft: 8, fontFamily: "var(--mono)", fontSize: 11 }}>{entry.text}</span>
        </div>
      </div>
    );
  }

  return (
    <div className={`bubble-row ${isUser ? "bubble-row-user" : "bubble-row-assistant"}`}>
      {!isUser && (
        <div className="bubble-avatar bubble-avatar-assistant">AI</div>
      )}
      <div
        className={`bubble ${isUser ? "bubble-user" : isError ? "bubble-error" : "bubble-assistant"}`}
      >
        <span style={{ whiteSpace: "pre-wrap", wordBreak: "break-word" }}>
          {entry.text}
          {entry.streaming && <span className="stream-cursor">▌</span>}
        </span>
      </div>
      {isUser && (
        <div className="bubble-avatar bubble-avatar-user">You</div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// RunView
// ---------------------------------------------------------------------------

export function RunView({ agentId }: Props) {
  const [input, setInput] = useState("");
  const [entries, setEntries] = useState<ConsoleEntry[]>([]);
  const [running, setRunning] = useState(false);
  const [stream, setStream] = useState(true);
  const [bubbleMode, setBubbleMode] = useState(false);
  const [suspended, setSuspended] = useState<string | null>(null); // sessionId if suspended
  const genSessionId = () =>
    typeof crypto !== "undefined" && crypto.randomUUID ? crypto.randomUUID() : `sess-${Date.now()}`;
  const [sessionId, setSessionId] = useState(genSessionId);
  const outputRef = useRef<HTMLDivElement>(null);
  const abortRef = useRef<AbortController | null>(null);
  // Index of the in-flight streaming assistant entry for the current turn (null between turns).
  const streamIdxRef = useRef<number | null>(null);

  useEffect(() => {
    if (outputRef.current) {
      outputRef.current.scrollTop = outputRef.current.scrollHeight;
    }
  }, [entries]);

  // Start a fresh conversation when the selected agent changes.
  useEffect(() => {
    setSessionId(genSessionId());
    setEntries([]);
    setSuspended(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [agentId]);

  const addEntry = (entry: ConsoleEntry) =>
    setEntries((prev) => [...prev, entry]);

  const run = async () => {
    if (!input.trim() || running) return;
    const userInput = input.trim();
    const streamTokens = stream; // capture the toggle for this run
    setInput("");
    setRunning(true);
    setSuspended(null);
    streamIdxRef.current = null;

    addEntry({ type: "user", label: "you", text: userInput });

    const ctrl = new AbortController();
    abortRef.current = ctrl;

    try {
      const res = await fetch(`/v1/agents/${encodeURIComponent(agentId)}/query`, {
        method: "POST",
        headers: { "content-type": "application/json", ...authHeaders() },
        body: JSON.stringify({ input: userInput, sessionId }),
        signal: ctrl.signal,
      });

      if (!res.ok) {
        addEntry({ type: "error", label: "error", text: `HTTP ${res.status}` });
        return;
      }

      const reader = res.body?.getReader();
      if (!reader) {
        addEntry({ type: "error", label: "error", text: "No response body" });
        return;
      }

      const decoder = new TextDecoder();
      let buf = "";

      const processChunk = (chunk: string) => {
        buf += chunk;
        const lines = buf.split("\n");
        buf = lines.pop() ?? "";

        let event = "";
        let data = "";
        for (const line of lines) {
          if (line.startsWith("event:")) {
            event = line.slice(6).trim();
          } else if (line.startsWith("data:")) {
            data = line.slice(5).trim();
          } else if (line === "" && event && data) {
            try {
              const parsed = JSON.parse(data) as Record<string, unknown>;
              renderEvent(event, parsed);
            } catch {
              addEntry({ type: "event", label: event, text: data });
            }
            event = "";
            data = "";
          }
        }
      };

      const renderEvent = (type: string, ev: Record<string, unknown>) => {
        if (type === "stream.delta") {
          // Live token-by-token streaming into a single growing assistant entry.
          if (!streamTokens) return;
          const delta =
            (ev["delta"] as { text?: string } | undefined)?.text ?? "";
          if (!delta) return;
          setEntries((prev) => {
            const next = [...prev];
            const idx = streamIdxRef.current;
            if (idx === null || idx >= next.length || !next[idx]?.streaming) {
              next.push({ type: "event", label: "assistant", text: delta, streaming: true });
              streamIdxRef.current = next.length - 1;
            } else {
              next[idx] = { ...next[idx]!, text: next[idx]!.text + delta };
            }
            return next;
          });
        } else if (type === "assistant") {
          const content = ev["content"];
          if (Array.isArray(content)) {
            for (const block of content) {
              const b = block as Record<string, unknown>;
              if (b["type"] === "text") {
                const finalText = String(b["text"] ?? "");
                const idx = streamIdxRef.current;
                if (streamTokens && idx !== null) {
                  // Finalize the streamed entry with the authoritative text.
                  setEntries((prev) => {
                    const next = [...prev];
                    if (next[idx]) next[idx] = { ...next[idx]!, text: finalText, streaming: false };
                    return next;
                  });
                } else {
                  addEntry({ type: "event", label: "assistant", text: finalText });
                }
              } else if (b["type"] === "tool_use") {
                addEntry({
                  type: "event",
                  label: "tool",
                  text: `${String(b["name"] ?? "")}(${JSON.stringify(b["input"] ?? {}).slice(0, 100)})`,
                });
              }
            }
          }
          // Turn boundary: the next model call streams into a fresh entry.
          streamIdxRef.current = null;
        } else if (type === "tool.result") {
          const toolName = String(ev["toolName"] ?? "tool");
          const rawOutput = ev["output"];
          const text = typeof rawOutput === "string"
            ? rawOutput.slice(0, 200)
            : JSON.stringify(rawOutput ?? null).slice(0, 200);
          const isError = Boolean(ev["isError"]);
          addEntry({ type: isError ? "error" : "event", label: "tool_result", text: `${toolName} → ${text}` });
        } else if (type === "compaction") {
          // Surface compaction as a subtle info row
          const reason = typeof ev["reason"] === "string" ? ev["reason"] : "";
          addEntry({
            type: "compaction",
            label: "compaction",
            text: `Context compacted${reason ? ": " + reason : " (context window limit approached)"}`,
          });
        } else if (type === "result") {
          const usage = ev["usage"] as { inputTokens?: number; outputTokens?: number } | undefined;
          const uStr = usage ? ` · in:${usage.inputTokens ?? 0} out:${usage.outputTokens ?? 0}` : "";
          const sub = String(ev["subtype"] ?? "");
          const isSuspended = sub === "suspended";
          const isError = !isSuspended && sub !== "" && sub !== "success";
          addEntry({
            type: isError ? "error" : isSuspended ? "suspended" : "info",
            label: isSuspended ? "suspended" : "done",
            text: `${isSuspended ? "suspended (awaiting approval)" : sub ? sub : "done"} · turns: ${String(ev["numTurns"] ?? "?")}${uStr}`,
            sessionId: isSuspended ? sessionId : undefined,
          });
          if (isSuspended) {
            setSuspended(sessionId);
          }
        }
      };

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        processChunk(decoder.decode(value, { stream: true }));
      }
    } catch (e: unknown) {
      if ((e as { name?: string })?.name !== "AbortError") {
        addEntry({ type: "error", label: "error", text: String(e) });
      }
    } finally {
      // S3: finalize any in-flight streaming entry so the blinking cursor is cleared.
      const idx = streamIdxRef.current;
      if (idx !== null) {
        setEntries((prev) => {
          const next = [...prev];
          if (next[idx]?.streaming) next[idx] = { ...next[idx]!, streaming: false };
          return next;
        });
      }
      setRunning(false);
      streamIdxRef.current = null;
      abortRef.current = null;
    }
  };

  const stop = () => {
    // S3: finalize any in-flight streaming entry before aborting.
    const idx = streamIdxRef.current;
    if (idx !== null) {
      setEntries((prev) => {
        const next = [...prev];
        if (next[idx]?.streaming) next[idx] = { ...next[idx]!, streaming: false };
        return next;
      });
    }
    abortRef.current?.abort();
    setRunning(false);
  };

  const labelColor = (type: ConsoleEntry["type"], label: string) => {
    if (type === "user") return "var(--green)";
    if (type === "error") return "var(--red)";
    if (type === "compaction") return "var(--text2)";
    if (type === "suspended") return "var(--yellow)";
    if (type === "info") return "var(--text2)";
    if (label === "assistant") return "var(--accent-hover)";
    if (label === "tool" || label === "tool_result") return "var(--yellow)";
    return "var(--text2)";
  };

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
      <div className="view-title">Run</div>
      <div className="view-subtitle">
        Send a query to <strong>{agentId}</strong> · session <code>{sessionId.slice(0, 8)}</code> — multi-turn, history persists across messages.
      </div>
      <div className="card">
        <div className="card-header">
          <span className="card-title">Console</span>
          <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
            <label
              style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 13, color: "var(--text2)", cursor: "pointer" }}
              title="Render the model output token-by-token as it streams"
            >
              <input
                type="checkbox"
                checked={stream}
                onChange={(e) => setStream(e.target.checked)}
                disabled={running}
              />
              Stream tokens
            </label>
            <label
              style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 13, color: "var(--text2)", cursor: "pointer" }}
              title="Show messages as chat bubbles (user right / assistant left) vs. log mode"
            >
              <input
                type="checkbox"
                checked={bubbleMode}
                onChange={(e) => setBubbleMode(e.target.checked)}
              />
              Chat bubbles
            </label>
            <button
              className="btn btn-ghost btn-sm"
              onClick={() => {
                setSessionId(genSessionId());
                setEntries([]);
                setSuspended(null);
              }}
              disabled={running}
              title="Start a fresh conversation (new session id)"
            >
              New session
            </button>
            <button
              className="btn btn-ghost btn-sm"
              onClick={() => setEntries([])}
              disabled={running}
              title="Clear the display (keeps the conversation/session)"
            >
              Clear
            </button>
          </div>
        </div>
        <div style={{ padding: "12px", display: "flex", flexDirection: "column", gap: 12 }}>
          {/* HITL approval card when agent is suspended */}
          {suspended && !running && (
            <HitlCard
              agentId={agentId}
              sessionId={suspended}
              onResumed={(approved) => {
                setSuspended(null);
                addEntry({
                  type: "info",
                  label: approved ? "approved" : "rejected",
                  text: approved ? "Decision: approved — agent will continue." : "Decision: rejected — agent stopped.",
                });
              }}
            />
          )}

          {bubbleMode ? (
            <div className="bubble-output" ref={outputRef}>
              {entries.length === 0 && (
                <div className="bubble-empty">Type a message below and press Enter or Send.</div>
              )}
              {entries.map((entry, i) => (
                <ChatBubble key={i} entry={entry} />
              ))}
              {running && streamIdxRef.current === null && (
                <div className="bubble-row bubble-row-assistant">
                  <div className="bubble-avatar bubble-avatar-assistant">AI</div>
                  <div className="bubble bubble-assistant">
                    <span className="stream-cursor">▌</span>
                  </div>
                </div>
              )}
            </div>
          ) : (
            <div className="console-output" ref={outputRef}>
              {entries.length === 0 && (
                <span className="text2">Type a message below and press Enter or Send.</span>
              )}
              {entries.map((entry, i) => (
                <div
                  key={i}
                  className={`console-event${entry.type === "compaction" ? " console-event-compaction" : ""}`}
                >
                  <span
                    style={{
                      color: labelColor(entry.type, entry.label),
                      fontWeight: 600,
                      marginRight: 8,
                    }}
                  >
                    [{entry.label}]
                  </span>
                  <span style={{ whiteSpace: "pre-wrap", wordBreak: "break-word" }}>
                    {entry.text}
                    {entry.streaming && <span className="stream-cursor">▌</span>}
                  </span>
                </div>
              ))}
              {running && streamIdxRef.current === null && (
                <div className="console-event">
                  <span className="text2">…</span>
                </div>
              )}
            </div>
          )}
          <div className="console-input-row">
            <input
              type="text"
              placeholder="Enter your message…"
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && !e.shiftKey && run()}
              disabled={running}
              autoFocus
            />
            {running ? (
              <button className="btn btn-ghost" onClick={stop}>
                Stop
              </button>
            ) : (
              <button
                className="btn btn-primary"
                onClick={run}
                disabled={!input.trim()}
              >
                Send
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

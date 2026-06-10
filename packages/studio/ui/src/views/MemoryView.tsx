import { useState, useEffect } from "react";
import { api, type MemoryBlock, type Fact, type MemorySnippet } from "../api.js";

interface Props {
  agentId: string;
}

function BlockEditor({
  block,
  agentId,
  userId,
  onSaved,
}: {
  block: MemoryBlock;
  agentId: string;
  userId?: string;
  onSaved: () => void;
}) {
  const [value, setValue] = useState(block.value);
  const [saving, setSaving] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);

  const save = async () => {
    setSaving(true);
    setMsg(null);
    try {
      await api.blocks.update(agentId, block.label, value, block.version);
      setMsg("Saved.");
      onSaved();
    } catch (e: unknown) {
      const err = e instanceof Error ? e.message : String(e);
      if (err.includes("409") || err.toLowerCase().includes("conflict")) {
        setMsg("Conflict — block was modified externally. Reload to get the latest version.");
      } else {
        setMsg(`Error: ${err}`);
      }
    } finally {
      setSaving(false);
    }
  };

  const dirty = value !== block.value;

  return (
    <div className="block-editor">
      <div className="row">
        <div className="block-label">{block.label}</div>
        <span className="text2 text-sm" style={{ marginLeft: "auto" }}>
          v{block.version}
        </span>
      </div>
      <textarea
        value={value}
        onChange={(e) => setValue(e.target.value)}
        style={{ width: "100%" }}
      />
      <div className="row">
        <button className="btn btn-primary btn-sm" disabled={!dirty || saving} onClick={save}>
          {saving ? "Saving…" : "Save"}
        </button>
        {dirty && (
          <button className="btn btn-ghost btn-sm" onClick={() => setValue(block.value)}>
            Revert
          </button>
        )}
        {msg && (
          <span
            className={`text-sm ${msg.startsWith("Error") || msg.includes("Conflict") ? "error-msg" : "text2"}`}
          >
            {msg}
          </span>
        )}
      </div>
    </div>
  );
}

export function MemoryView({ agentId }: Props) {
  const [blocks, setBlocks] = useState<MemoryBlock[]>([]);
  const [facts, setFacts] = useState<Fact[]>([]);
  const [snippets, setSnippets] = useState<MemorySnippet[]>([]);
  const [q, setQ] = useState("");
  const [loading, setLoading] = useState(false);
  const [factsLoading, setFactsLoading] = useState(false);
  const [snippetsLoading, setSnippetsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // userId filter — empty string means agent-scope (no userId)
  const [userId, setUserId] = useState("");
  const [userIdInput, setUserIdInput] = useState("");

  const effectiveUserId = userId.trim() || undefined;

  const loadBlocks = () => {
    setLoading(true);
    api.blocks
      .list(agentId, effectiveUserId)
      .then(setBlocks)
      .catch((e: unknown) => setError(String(e)))
      .finally(() => setLoading(false));
  };

  const loadFacts = () => {
    setFactsLoading(true);
    api.facts
      .list(agentId, undefined, effectiveUserId)
      .then(setFacts)
      .catch((e: unknown) => setError(String(e)))
      .finally(() => setFactsLoading(false));
  };

  const searchMemories = () => {
    setSnippetsLoading(true);
    api.memories
      .search(agentId, q, effectiveUserId)
      .then(setSnippets)
      .catch((e: unknown) => setError(String(e)))
      .finally(() => setSnippetsLoading(false));
  };

  useEffect(() => {
    loadBlocks();
    loadFacts();
    setSnippets([]);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [agentId, userId]);

  const applyUserId = () => {
    setUserId(userIdInput);
  };

  const clearUserId = () => {
    setUserIdInput("");
    setUserId("");
  };

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
      <div className="view-title">Memory</div>
      {error && <div className="error-msg">{error}</div>}

      {/* userId filter */}
      <div className="card">
        <div className="card-header">
          <span className="card-title">Scope</span>
        </div>
        <div className="card-body">
          <div className="row" style={{ gap: 8 }}>
            <span className="text2 text-sm" style={{ whiteSpace: "nowrap" }}>User ID</span>
            <input
              type="text"
              placeholder="Leave blank for agent-scope…"
              value={userIdInput}
              onChange={(e) => setUserIdInput(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && applyUserId()}
              style={{ flex: 1 }}
            />
            <button className="btn btn-primary btn-sm" onClick={applyUserId}>
              Apply
            </button>
            {userId && (
              <button className="btn btn-ghost btn-sm" onClick={clearUserId}>
                Clear
              </button>
            )}
          </div>
          {userId ? (
            <div className="text2 text-sm" style={{ marginTop: 6 }}>
              Showing user-scope memory for <code className="mono">{userId}</code>
            </div>
          ) : (
            <div className="text2 text-sm" style={{ marginTop: 6 }}>
              Showing agent-scope memory (no userId set)
            </div>
          )}
        </div>
      </div>

      {/* Blocks */}
      <div className="card">
        <div className="card-header">
          <span className="card-title">Blocks ({blocks.length})</span>
          <button className="btn btn-ghost btn-sm" onClick={loadBlocks}>
            Refresh
          </button>
        </div>
        {loading ? (
          <div className="loading" style={{ padding: "12px" }}>Loading…</div>
        ) : blocks.length === 0 ? (
          <div className="empty-state">No memory blocks found.</div>
        ) : (
          blocks.map((b) => (
            <BlockEditor key={b.label} block={b} agentId={agentId} userId={effectiveUserId} onSaved={loadBlocks} />
          ))
        )}
      </div>

      {/* Facts */}
      <div className="card">
        <div className="card-header">
          <span className="card-title">Facts ({facts.length})</span>
          <button className="btn btn-ghost btn-sm" onClick={loadFacts}>
            Refresh
          </button>
        </div>
        {factsLoading ? (
          <div className="loading" style={{ padding: "12px" }}>Loading…</div>
        ) : facts.length === 0 ? (
          <div className="empty-state">No facts found.</div>
        ) : (
          <table>
            <thead>
              <tr>
                <th>Subject</th>
                <th>Predicate</th>
                <th>Object</th>
                <th>Valid From</th>
                <th>Status</th>
              </tr>
            </thead>
            <tbody>
              {facts.map((f, i) => (
                <tr key={i}>
                  <td className="mono">{f.subject}</td>
                  <td className="mono">{f.predicate}</td>
                  <td>{f.object}</td>
                  <td className="text-sm text2">{f.validFrom ? new Date(f.validFrom).toLocaleDateString() : "—"}</td>
                  <td>
                    {f.validUntil ? (
                      <span className="badge badge-red" title={f.validUntil}>invalidated</span>
                    ) : (
                      <span className="badge badge-green">active</span>
                    )}
                    {f.confidence !== undefined && (
                      <span className="text2 text-sm" style={{ marginLeft: 6 }}>{(f.confidence * 100).toFixed(0)}%</span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      {/* Memory search */}
      <div className="card">
        <div className="card-header">
          <span className="card-title">Memory Search</span>
        </div>
        <div className="card-body">
          <div className="row" style={{ marginBottom: 12 }}>
            <input
              type="search"
              placeholder="Search memories…"
              value={q}
              onChange={(e) => setQ(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && searchMemories()}
              style={{ flex: 1 }}
            />
            <button
              className="btn btn-primary btn-sm"
              onClick={searchMemories}
              disabled={snippetsLoading}
            >
              {snippetsLoading ? "…" : "Search"}
            </button>
          </div>
          {snippets.length > 0 && (
            <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
              {snippets.map((s) => (
                <div
                  key={s.id}
                  style={{
                    background: "var(--surface2)",
                    border: "1px solid var(--border)",
                    borderRadius: "var(--radius)",
                    padding: "8px 10px",
                  }}
                >
                  <div className="text2 text-sm mono" style={{ marginBottom: 2 }}>
                    {s.id}
                    {s.score !== undefined && (
                      <span style={{ marginLeft: 8 }}>score: {s.score.toFixed(3)}</span>
                    )}
                  </div>
                  <div>{s.text}</div>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

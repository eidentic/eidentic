import { useState, useEffect } from "react";
import { api, type AgentDetail, type ToolSchema } from "../api.js";

interface Props {
  agentId: string;
}

function ToolRow({ tool }: { tool: ToolSchema }) {
  const [open, setOpen] = useState(false);
  const schema = tool.inputSchema as Record<string, unknown> | null | undefined;
  const hasProps =
    schema && typeof schema === "object" && "properties" in schema && schema.properties;

  return (
    <>
      <tr
        style={{ cursor: hasProps ? "pointer" : "default" }}
        onClick={() => hasProps && setOpen((v) => !v)}
      >
        <td className="mono" style={{ fontWeight: 500 }}>
          {tool.name}
        </td>
        <td style={{ color: "var(--text2)", fontSize: 12 }}>{tool.description}</td>
        <td style={{ textAlign: "right", width: 32, color: "var(--text2)" }}>
          {hasProps ? (open ? "▴" : "▾") : null}
        </td>
      </tr>
      {open && hasProps && (
        <tr>
          <td colSpan={3} style={{ padding: "0 12px 12px 12px", background: "var(--surface2)" }}>
            <pre
              style={{
                fontSize: 11,
                fontFamily: "var(--mono)",
                color: "var(--text2)",
                whiteSpace: "pre-wrap",
                wordBreak: "break-word",
                margin: 0,
              }}
            >
              {JSON.stringify(schema, null, 2)}
            </pre>
          </td>
        </tr>
      )}
    </>
  );
}

export function ToolsView({ agentId }: Props) {
  const [detail, setDetail] = useState<AgentDetail | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = () => {
    setLoading(true);
    setError(null);
    api.agents
      .detail(agentId)
      .then(setDetail)
      .catch((e: unknown) => setError(String(e)))
      .finally(() => setLoading(false));
  };

  useEffect(() => {
    load();
  }, [agentId]);

  const tools = detail?.tools ?? [];

  return (
    <div>
      <div className="view-title">Tools</div>
      <div className="view-subtitle" style={{ marginBottom: 16 }}>
        Agent: <strong>{agentId}</strong>
      </div>
      {error && <div className="error-msg">{error}</div>}
      <div className="card">
        <div className="card-header">
          <span className="card-title">Effective tools ({loading ? "…" : tools.length})</span>
          <button className="btn btn-ghost btn-sm" onClick={load}>
            Refresh
          </button>
        </div>
        {loading ? (
          <div className="loading" style={{ padding: "12px" }}>
            Loading…
          </div>
        ) : tools.length === 0 ? (
          <div className="empty-state">No tools configured for this agent.</div>
        ) : (
          <table>
            <thead>
              <tr>
                <th style={{ width: 200 }}>Name</th>
                <th>Description</th>
                <th style={{ width: 32 }}></th>
              </tr>
            </thead>
            <tbody>
              {tools.map((t) => (
                <ToolRow key={t.name} tool={t} />
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}

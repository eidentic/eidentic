import { useState, useEffect } from "react";
import { api, type AgentInfo, type AgentDetail, type AgentCost } from "./api.js";
import { AgentsView } from "./views/AgentsView.js";
import { SessionsView } from "./views/SessionsView.js";
import { MemoryView } from "./views/MemoryView.js";
import { SkillsView } from "./views/SkillsView.js";
import { RunView } from "./views/RunView.js";
import { ToolsView } from "./views/ToolsView.js";
import { WorkflowsView } from "./views/WorkflowsView.js";

type View = "agents" | "tools" | "sessions" | "memory" | "skills" | "run" | "workflows";

function AgentDetailHeader({ agentId }: { agentId: string }) {
  const [detail, setDetail] = useState<AgentDetail | null>(null);
  const [cost, setCost] = useState<AgentCost | null>(null);
  const [costError, setCostError] = useState(false);

  useEffect(() => {
    setDetail(null);
    setCost(null);
    setCostError(false);
    api.agents
      .detail(agentId)
      .then(setDetail)
      .catch(() => {
        // non-fatal — header is best-effort
      });
    api.agents
      .cost(agentId)
      .then(setCost)
      .catch(() => setCostError(true));
  }, [agentId]);

  if (!detail) return null;

  const instructionSnippet = detail.instructions
    ? detail.instructions.slice(0, 120) + (detail.instructions.length > 120 ? "…" : "")
    : null;

  const usdLabel =
    cost === null && !costError
      ? "…"
      : cost && cost.usd !== undefined
        ? "$" + cost.usd.toFixed(4)
        : "—";

  const pricesDate = cost?.pricesUpdatedAt
    ? cost.pricesUpdatedAt.slice(0, 10)
    : "";

  const costTooltip = cost
    ? `USD is an estimate from ${cost.pricedFrom === "configured" ? "configured" : "bundled"} prices (updated ${pricesDate}); token counts are exact.`
    : "Loading cost…";

  return (
    <div className="agent-detail-header">
      <div className="agent-detail-id">{detail.id}</div>
      {detail.model && (
        <div className="agent-detail-model mono">{detail.model}</div>
      )}
      {instructionSnippet && (
        <div className="agent-detail-instructions">{instructionSnippet}</div>
      )}
      <div className="agent-detail-badges">
        <span className="badge badge-blue">{detail.tools.length} tools</span>
        {detail.hasMemory && <span className="badge badge-blue">memory</span>}
        {detail.hasGraph && <span className="badge badge-green">graph</span>}
        {detail.hasSkills && <span className="badge badge-yellow">skills</span>}
      </div>
      {(cost !== null || costError) && (
        <div className="agent-cost-summary" title={costTooltip}>
          <span className="text2 text-sm">
            Cost: <strong>{usdLabel}</strong>
            {cost && (
              <>
                {" · "}{cost.sessions} session{cost.sessions !== 1 ? "s" : ""}
                {" · "}{cost.messages} msg{cost.messages !== 1 ? "s" : ""}
                {" · "}<span className="mono">{cost.inputTokens}+{cost.outputTokens} tok</span>
              </>
            )}
            {" "}
            <span className="text2" style={{ fontSize: "11px" }}>
              (estimate · prices {pricesDate})
            </span>
          </span>
        </div>
      )}
    </div>
  );
}

export function App() {
  const [agents, setAgents] = useState<AgentInfo[]>([]);
  const [selectedAgent, setSelectedAgent] = useState<string | null>(null);
  const [view, setView] = useState<View>("tools");
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api.agents
      .list()
      .then((list) => {
        setAgents(list);
        if (list.length > 0 && !selectedAgent) {
          setSelectedAgent(list[0]!.id);
        }
      })
      .catch((e: unknown) => setError(String(e)));
  }, []);

  const nav = (v: View) => setView(v);

  const navItems: { id: View; label: string }[] = [
    { id: "agents", label: "Agents" },
    { id: "tools", label: "Tools" },
    { id: "sessions", label: "Sessions" },
    { id: "memory", label: "Memory" },
    { id: "skills", label: "Skills" },
    { id: "run", label: "Run" },
    { id: "workflows", label: "Workflows" },
  ];

  return (
    <>
      <header className="header">
        <div className="header-logo">
          Eidentic <span>Studio</span>
        </div>
        <div className="header-badge">dev tool</div>
        {error && <span className="error-msg">{error}</span>}
      </header>
      <div className="app-shell">
        <nav className="sidebar">
          {agents.length > 0 && (
            <div className="agent-selector">
              <select
                value={selectedAgent ?? ""}
                onChange={(e) => {
                  setSelectedAgent(e.target.value);
                  setView("tools");
                }}
              >
                {agents.map((a) => (
                  <option key={a.id} value={a.id}>
                    {a.id}
                  </option>
                ))}
              </select>
            </div>
          )}
          <div className="sidebar-section">
            <div className="sidebar-label">Navigation</div>
            {navItems.map((item) => (
              <button
                key={item.id}
                className={`sidebar-item${view === item.id ? " active" : ""}`}
                onClick={() => nav(item.id)}
              >
                {item.label}
              </button>
            ))}
          </div>
        </nav>
        <main className="main-content">
          {selectedAgent && view !== "agents" && view !== "workflows" && (
            <AgentDetailHeader agentId={selectedAgent} />
          )}
          {view === "agents" && (
            <AgentsView
              agents={agents}
              selectedAgent={selectedAgent}
              onSelect={(id) => {
                setSelectedAgent(id);
                setView("tools");
              }}
            />
          )}
          {view === "tools" && selectedAgent && (
            <ToolsView agentId={selectedAgent} />
          )}
          {view === "sessions" && selectedAgent && (
            <SessionsView agentId={selectedAgent} />
          )}
          {view === "memory" && selectedAgent && (
            <MemoryView agentId={selectedAgent} />
          )}
          {view === "skills" && selectedAgent && (
            <SkillsView agentId={selectedAgent} />
          )}
          {view === "run" && selectedAgent && (
            <RunView agentId={selectedAgent} />
          )}
          {view === "workflows" && (
            <WorkflowsView />
          )}
          {!selectedAgent && view !== "agents" && view !== "workflows" && (
            <div className="empty-state">
              Select an agent from the dropdown to continue.
            </div>
          )}
        </main>
      </div>
    </>
  );
}

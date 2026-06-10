import type { AgentInfo } from "../api.js";

interface Props {
  agents: AgentInfo[];
  selectedAgent: string | null;
  onSelect: (id: string) => void;
}

export function AgentsView({ agents, selectedAgent, onSelect }: Props) {
  return (
    <div>
      <div className="view-title">Agents</div>
      <div className="view-subtitle" style={{ marginBottom: 16 }}>
        {agents.length} agent{agents.length !== 1 ? "s" : ""} registered
      </div>
      {agents.length === 0 ? (
        <div className="empty-state">No agents found. Is the studio configured with agents?</div>
      ) : (
        <div className="agents-grid">
          {agents.map((a) => (
            <div
              key={a.id}
              className={`agent-card${selectedAgent === a.id ? " selected" : ""}`}
              onClick={() => onSelect(a.id)}
            >
              <div className="agent-card-id">{a.id}</div>
              <div className="agent-card-badges">
                {a.hasMemory && <span className="badge badge-blue">memory</span>}
                {a.hasGraph && <span className="badge badge-green">graph</span>}
                {a.hasSkills && <span className="badge badge-yellow">skills</span>}
                {!a.hasMemory && !a.hasGraph && !a.hasSkills && (
                  <span className="badge badge-gray">basic</span>
                )}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

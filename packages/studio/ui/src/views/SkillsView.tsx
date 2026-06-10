import { useState, useEffect } from "react";
import { api, type SkillEntry } from "../api.js";

interface Props {
  agentId: string;
}

export function SkillsView({ agentId }: Props) {
  const [skills, setSkills] = useState<SkillEntry[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [approving, setApproving] = useState<string | null>(null);

  const load = () => {
    setLoading(true);
    api.skills
      .list(agentId)
      .then(setSkills)
      .catch((e: unknown) => setError(String(e)))
      .finally(() => setLoading(false));
  };

  useEffect(() => {
    load();
  }, [agentId]);

  const approve = async (name: string) => {
    setApproving(name);
    try {
      await api.skills.approve(agentId, name);
      await load();
    } catch (e: unknown) {
      setError(String(e));
    } finally {
      setApproving(null);
    }
  };

  const promptSkills = skills.filter((s) => s.type === "prompt");
  const execSkills = skills.filter((s) => s.type === "executable");

  return (
    <div>
      <div className="view-title">Skills</div>
      <div className="view-subtitle" style={{ marginBottom: 16 }}>
        Agent: <strong>{agentId}</strong>
      </div>
      {error && <div className="error-msg">{error}</div>}
      <div className="card">
        <div className="card-header">
          <span className="card-title">Skills ({skills.length})</span>
          <button className="btn btn-ghost btn-sm" onClick={load}>
            Refresh
          </button>
        </div>
        {loading ? (
          <div className="loading" style={{ padding: "12px" }}>Loading…</div>
        ) : skills.length === 0 ? (
          <div className="empty-state">No skills configured for this agent.</div>
        ) : (
          <table>
            <thead>
              <tr>
                <th>Name</th>
                <th>Type</th>
                <th>Description</th>
                <th>Status</th>
                <th>Author</th>
                <th>Version</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {promptSkills.map((s) => (
                <tr key={`prompt:${s.name}`}>
                  <td className="mono">{s.name}</td>
                  <td>
                    <span className="badge badge-green">prompt</span>
                  </td>
                  <td className="text2 text-sm">{s.description || "—"}</td>
                  <td>
                    <span className="badge badge-green">active</span>
                  </td>
                  <td className="text2 text-sm">—</td>
                  <td className="mono text-sm">—</td>
                  <td></td>
                </tr>
              ))}
              {execSkills.map((s) => (
                <tr key={`exec:${s.name}`}>
                  <td className="mono">{s.name}</td>
                  <td>
                    <span className="badge" style={{ background: "var(--color-indigo, #4f46e5)", color: "#fff" }}>executable</span>
                  </td>
                  <td className="text2 text-sm">{s.description || "—"}</td>
                  <td>
                    {s.quarantined ? (
                      <span className="badge badge-yellow">quarantined</span>
                    ) : (
                      <span className="badge badge-green">approved</span>
                    )}
                  </td>
                  <td className="text2 text-sm">{s.author ?? "—"}</td>
                  <td className="mono text-sm">{s.version ?? "—"}</td>
                  <td>
                    {s.quarantined && (
                      <button
                        className="btn btn-primary btn-sm"
                        disabled={approving === s.name}
                        onClick={() => approve(s.name)}
                      >
                        {approving === s.name ? "Approving…" : "Approve"}
                      </button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}

import { useState, useEffect } from "react";
import { api, type WorkflowRunSummary, type WorkflowRunDetail, type StepTraceEntry } from "../api.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function formatDate(ts: number): string {
  try {
    return new Date(ts).toLocaleString();
  } catch {
    return String(ts);
  }
}

function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  return `${(ms / 1000).toFixed(2)}s`;
}

// ---------------------------------------------------------------------------
// Step trace row — renders one step with indentation based on path depth
// ---------------------------------------------------------------------------

function StepRow({ step }: { step: StepTraceEntry }) {
  const depth = Math.max(0, step.path.length - 1);
  const isError = step.status === "error";

  return (
    <div
      className="wf-step-row"
      style={{ paddingLeft: 12 + depth * 20 }}
    >
      <span className={`badge ${isError ? "badge-red" : "badge-green"} wf-step-badge`}>
        {isError ? "error" : "ok"}
      </span>
      <span className="wf-step-name mono">{step.name}</span>
      <span className="text2 text-sm wf-step-dur">{formatDuration(step.durationMs)}</span>
      {isError && step.error && (
        <span className="wf-step-error text-sm">{step.error}</span>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// WorkflowsView
// ---------------------------------------------------------------------------

export function WorkflowsView() {
  const [runs, setRuns] = useState<WorkflowRunSummary[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [detail, setDetail] = useState<WorkflowRunDetail | null>(null);
  const [loading, setLoading] = useState(false);
  const [detailLoading, setDetailLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const loadList = () => {
    setLoading(true);
    setError(null);
    api.workflows
      .list()
      .then(setRuns)
      .catch((e: unknown) => setError(String(e)))
      .finally(() => setLoading(false));
  };

  useEffect(() => {
    loadList();
  }, []);

  const loadDetail = (id: string) => {
    setSelected(id);
    setDetail(null);
    setDetailLoading(true);
    api.workflows
      .detail(id)
      .then(setDetail)
      .catch((e: unknown) => setError(String(e)))
      .finally(() => setDetailLoading(false));
  };

  return (
    <div>
      <div className="view-title">Workflows</div>
      <div className="view-subtitle" style={{ marginBottom: 16 }}>
        Recorded workflow runs — call{" "}
        <code className="mono">studio.recordWorkflow(name, await wf.run(input))</code> to populate.
      </div>
      {error && <div className="error-msg">{error}</div>}
      <div className="split" style={{ alignItems: "start" }}>
        {/* Left panel: run list */}
        <div className="card">
          <div className="card-header">
            <span className="card-title">Runs ({runs.length})</span>
            <button
              className="btn btn-ghost btn-sm"
              onClick={loadList}
              disabled={loading}
            >
              Refresh
            </button>
          </div>
          {loading ? (
            <div className="loading" style={{ padding: "12px" }}>Loading…</div>
          ) : runs.length === 0 ? (
            <div className="empty-state" style={{ padding: "24px 16px" }}>
              <div>No workflow runs recorded yet.</div>
              <div className="text2 text-sm" style={{ marginTop: 8 }}>
                Record a run with:{" "}
                <code className="mono">studio.recordWorkflow(name, await wf.run(input))</code>
              </div>
            </div>
          ) : (
            <div className="session-list">
              {runs.map((r) => (
                <div
                  key={r.id}
                  className={`session-item${selected === r.id ? " active" : ""}`}
                  onClick={() => loadDetail(r.id)}
                >
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                      <span className={`badge ${r.status === "error" ? "badge-red" : "badge-green"}`}>
                        {r.status}
                      </span>
                      <span className="mono text-sm" style={{ fontWeight: 600 }}>
                        {r.name}
                      </span>
                    </div>
                    <div className="text2 text-sm" style={{ marginTop: 3 }}>
                      {formatDate(r.startedAt)}
                    </div>
                    <div className="text2 text-sm mono" style={{ marginTop: 2 }}>
                      {r.stepCount} step{r.stepCount !== 1 ? "s" : ""} · {formatDuration(r.durationMs)}
                    </div>
                  </div>
                  <span className="text2">›</span>
                </div>
              ))}
            </div>
          )}
        </div>

        {/* Right panel: step trace */}
        <div className="card">
          <div className="card-header">
            <span className="card-title">
              {selected && detail
                ? `Trace: ${detail.name}`
                : selected
                  ? "Loading trace…"
                  : "Select a run"}
            </span>
            {detail && (
              <span
                className={`badge ${detail.status === "error" ? "badge-red" : "badge-green"}`}
                style={{ flexShrink: 0 }}
              >
                {detail.status}
              </span>
            )}
          </div>
          {detailLoading ? (
            <div className="loading" style={{ padding: "12px" }}>Loading trace…</div>
          ) : !selected ? (
            <div className="empty-state">Click a run to view its step trace.</div>
          ) : !detail ? null : detail.trace.length === 0 ? (
            <div className="empty-state">No steps recorded for this run.</div>
          ) : (
            <div className="card-body" style={{ padding: 0 }}>
              {/* Run summary bar */}
              <div className="wf-run-summary">
                <span className="text2 text-sm">
                  Started: <strong>{formatDate(detail.startedAt)}</strong>
                </span>
                <span className="text2 text-sm">
                  Duration: <strong className="mono">{formatDuration(detail.durationMs)}</strong>
                </span>
                <span className="text2 text-sm">
                  Steps: <strong>{detail.trace.length}</strong>
                </span>
              </div>
              {/* Step trace */}
              <div className="wf-trace">
                {detail.trace.map((step, i) => (
                  <StepRow key={i} step={step} />
                ))}
              </div>
              {/* Output (collapsed JSON) */}
              {detail.output !== undefined && detail.output !== null && (
                <div className="wf-output">
                  <div className="text2 text-sm" style={{ marginBottom: 4, fontWeight: 600 }}>
                    Output
                  </div>
                  <pre style={{ fontSize: 11, maxHeight: 200, overflow: "auto" }}>
                    {JSON.stringify(detail.output, null, 2)}
                  </pre>
                </div>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

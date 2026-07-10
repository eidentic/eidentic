// ---------------------------------------------------------------------------
// Eidentic Studio API client
// ---------------------------------------------------------------------------

export interface AgentInfo {
  id: string;
  hasMemory: boolean;
  hasSkills: boolean;
  hasGraph: boolean;
  toolCount?: number;
}

export interface ToolSchema {
  name: string;
  description: string;
  inputSchema?: unknown;
}

export interface AgentDetail {
  id: string;
  instructions?: string;
  model?: string;
  tools: ToolSchema[];
  hasMemory: boolean;
  hasSkills: boolean;
  hasGraph: boolean;
}

export interface UsageSummary {
  inputTokens: number;
  outputTokens: number;
  cachedInputTokens: number;
  messages: number;
}

export interface SessionRecord {
  id: string;
  agentId: string;
  createdAt: string;
  updatedAt?: string;
  /** Per-session token totals (summed from assistant events in the trace). */
  usage?: UsageSummary;
  /** Estimated USD cost for the session; undefined when no price covers the model. */
  usd?: number;
}

export interface AgentCost {
  inputTokens: number;
  outputTokens: number;
  cachedInputTokens: number;
  /** Estimated total USD; undefined when no price covers the model. */
  usd?: number;
  messages: number;
  sessions: number;
  modelId: string | null;
  pricedFrom: "default" | "configured";
  pricesUpdatedAt: string;
}

export interface StoredEvent {
  id: string;
  sessionId: string;
  seq: number;
  kind: string;
  schemaVersion: number;
  payload: unknown;
  meta?: { usage?: { inputTokens: number; outputTokens: number; cachedInputTokens?: number }; [k: string]: unknown };
  createdAt: string;
}

export interface MemoryBlock {
  label: string;
  value: string;
  version: number;
  scope?: { kind: string; agentId: string; userId?: string };
}

export interface Fact {
  subject: string;
  predicate: string;
  object: string;
  objectKind?: "entity" | "literal";
  validFrom?: string;
  validUntil?: string;   // set when invalidated/superseded; absent means currently valid
  confidence?: number;
  source?: string;
}

export interface MemorySnippet {
  id: string;
  text: string;
  score?: number;
}

export interface SkillEntry {
  name: string;
  description: string;
  type: "prompt" | "executable";
  quarantined?: boolean;
  version?: number;
  author?: string;
}

export interface StepTraceEntry {
  name: string;
  path: string[];
  startedAt: number;
  durationMs: number;
  status: "ok" | "error";
  error?: string;
}

export interface WorkflowRunSummary {
  id: string;
  name: string;
  status: "ok" | "error";
  startedAt: number;
  durationMs: number;
  stepCount: number;
}

export interface WorkflowRunDetail {
  id: string;
  name: string;
  status: "ok" | "error";
  startedAt: number;
  durationMs: number;
  trace: StepTraceEntry[];
  output?: unknown;
  error?: string;
}

// ---------------------------------------------------------------------------
// Auth token helper reads #key= from the URL fragment and keeps it only for the
// current browser tab. Query-string credentials are rejected by default because
// they leak into server logs, browser history, analytics, and referrer headers.
// ---------------------------------------------------------------------------

const STORAGE_KEY = "eidentic_studio_key";

export function authHeaders(
  opts: { allowQueryCredential?: boolean } = {},
): Record<string, string> {
  if (typeof window !== "undefined") {
    const hashParams = new URLSearchParams(window.location.hash.startsWith("#") ? window.location.hash.slice(1) : window.location.hash);
    const queryParams = new URLSearchParams(window.location.search);
    const fragmentKey = hashParams.get("key");
    const queryKey = queryParams.get("key");
    const keyFromUrl = fragmentKey ?? (opts.allowQueryCredential === true ? queryKey : null);
    // Always scrub credential-looking URL parameters, even when refusing to
    // consume a query credential.
    hashParams.delete("key");
    queryParams.delete("key");
    if (keyFromUrl) {
      sessionStorage.setItem(STORAGE_KEY, keyFromUrl);
    }
    if (fragmentKey !== null || queryKey !== null) {
      const query = queryParams.toString();
      const hash = hashParams.toString();
      window.history.replaceState(null, "", `${window.location.pathname}${query ? `?${query}` : ""}${hash ? `#${hash}` : ""}`);
    }

    // One-time compatibility migration: remove credentials left by older
    // Studio versions from persistent localStorage and scope them to this tab.
    const legacyToken = localStorage.getItem(STORAGE_KEY);
    if (legacyToken && !sessionStorage.getItem(STORAGE_KEY)) {
      sessionStorage.setItem(STORAGE_KEY, legacyToken);
    }
    if (legacyToken !== null) localStorage.removeItem(STORAGE_KEY);

    const token = sessionStorage.getItem(STORAGE_KEY);
    if (token) return { Authorization: `Bearer ${token}` };
  }
  return {};
}

async function apiFetch<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, {
    ...init,
    referrerPolicy: "no-referrer",
    headers: { ...authHeaders(), ...(init?.headers as Record<string, string> | undefined) },
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`${res.status} ${res.statusText}${body ? ": " + body : ""}`);
  }
  return res.json() as Promise<T>;
}

export const api = {
  agents: {
    list: () => apiFetch<AgentInfo[]>("/api/agents"),
    detail: (id: string) => apiFetch<AgentDetail>(`/api/agents/${encodeURIComponent(id)}`),
    cost: (id: string) => apiFetch<AgentCost>(`/api/agents/${encodeURIComponent(id)}/cost`),
  },
  sessions: {
    list: (agentId: string, limit?: number) =>
      apiFetch<SessionRecord[]>(
        `/api/agents/${agentId}/sessions${limit ? `?limit=${limit}` : ""}`,
      ),
    events: (agentId: string, sessionId: string) =>
      apiFetch<{ events: StoredEvent[] }>(
        `/api/agents/${agentId}/sessions/${sessionId}/events`,
      ),
  },
  blocks: {
    list: (agentId: string, userId?: string) =>
      apiFetch<MemoryBlock[]>(
        `/api/agents/${agentId}/blocks${userId ? `?userId=${encodeURIComponent(userId)}` : ""}`,
      ),
    update: (
      agentId: string,
      label: string,
      value: string,
      expectVersion?: number,
    ) =>
      apiFetch<MemoryBlock>(`/api/agents/${agentId}/blocks/${encodeURIComponent(label)}`, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(
          expectVersion !== undefined ? { value, expectVersion } : { value },
        ),
      }),
  },
  facts: {
    list: (agentId: string, subject?: string, userId?: string) => {
      const params = new URLSearchParams();
      if (subject) params.set("subject", subject);
      if (userId) params.set("userId", userId);
      const qs = params.toString();
      return apiFetch<Fact[]>(`/api/agents/${agentId}/facts${qs ? "?" + qs : ""}`);
    },
  },
  memories: {
    search: (agentId: string, q: string, userId?: string) => {
      const params = new URLSearchParams({ q });
      if (userId) params.set("userId", userId);
      return apiFetch<MemorySnippet[]>(`/api/agents/${agentId}/memories?${params}`);
    },
  },
  skills: {
    list: (agentId: string) => apiFetch<SkillEntry[]>(`/api/agents/${agentId}/skills`),
    approve: (agentId: string, skillId: string) =>
      apiFetch<{ approved: boolean; name: string }>(
        `/api/agents/${agentId}/skills/${encodeURIComponent(skillId)}/approve`,
        { method: "POST" },
      ),
  },
  workflows: {
    list: () => apiFetch<WorkflowRunSummary[]>("/api/workflows"),
    detail: (id: string) => apiFetch<WorkflowRunDetail>(`/api/workflows/${encodeURIComponent(id)}`),
  },
};

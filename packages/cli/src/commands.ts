import {
  appendFileSync,
  closeSync,
  constants,
  copyFileSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  realpathSync,
  readdirSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { join, resolve, relative, sep, isAbsolute, dirname, extname, basename } from "node:path";
import { fileURLToPath } from "node:url";
import { createJiti } from "jiti";
import { Agent, type AgentConfig, type Tool } from "@eidentic/core";
import type { AuthPort } from "@eidentic/server";
import { createServer } from "@eidentic/server";
import type { Hono } from "hono";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** A SkillBank-shaped interface: only what the CLI needs to pass through. */
export interface SkillBankLike {
  list(): unknown[];
  approve(name: string): boolean;
}

export interface EidenticConfig {
  agents: Record<string, Agent>;
  auth?: AuthPort;
  port?: number;
  basePath?: string;
  exposeEvents?: boolean;
  skillBanks?: Record<string, SkillBankLike>;
}

export interface DoctorCheck {
  name: string;
  ok: boolean;
  detail: string;
}

export interface DoctorReport {
  checks: DoctorCheck[];
  ok: boolean;
}

// ---------------------------------------------------------------------------
// Provider map (shared with create-eidentic's scaffold logic)
// ---------------------------------------------------------------------------

export type Provider = "anthropic" | "openai" | "google" | "deepseek" | "mistral";

interface ProviderMeta {
  package: string;
  envVar: string;
  importLine: string;
  modelId: string;
  providerFn: string;
  models: string[];
}

export const INIT_PROVIDERS: Record<Provider, ProviderMeta> = {
  anthropic: {
    package: "@ai-sdk/anthropic",
    envVar: "ANTHROPIC_API_KEY",
    importLine: 'import { anthropic } from "@ai-sdk/anthropic";',
    modelId: "claude-sonnet-4-5",
    providerFn: "anthropic",
    models: ["claude-sonnet-4-5", "claude-opus-4-1", "claude-haiku-4-5"],
  },
  openai: {
    package: "@ai-sdk/openai",
    envVar: "OPENAI_API_KEY",
    importLine: 'import { openai } from "@ai-sdk/openai";',
    modelId: "gpt-4o",
    providerFn: "openai",
    models: ["gpt-4o", "gpt-4o-mini", "o4-mini"],
  },
  google: {
    package: "@ai-sdk/google",
    envVar: "GOOGLE_GENERATIVE_AI_API_KEY",
    importLine: 'import { google } from "@ai-sdk/google";',
    modelId: "gemini-2.5-pro",
    providerFn: "google",
    models: ["gemini-2.5-pro", "gemini-2.5-flash"],
  },
  deepseek: {
    package: "@ai-sdk/deepseek",
    envVar: "DEEPSEEK_API_KEY",
    importLine: 'import { deepseek } from "@ai-sdk/deepseek";',
    modelId: "deepseek-chat",
    providerFn: "deepseek",
    models: ["deepseek-chat", "deepseek-reasoner"],
  },
  mistral: {
    package: "@ai-sdk/mistral",
    envVar: "MISTRAL_API_KEY",
    importLine: 'import { mistral } from "@ai-sdk/mistral";',
    modelId: "mistral-large-latest",
    providerFn: "mistral",
    models: ["mistral-large-latest", "mistral-small-latest"],
  },
};

// ---------------------------------------------------------------------------
// initProject
// ---------------------------------------------------------------------------

export interface InitResult {
  created: string[];
  skipped: string[];
}

function eidenticConfigTs(p: ProviderMeta, modelId: string): string {
  return `import { Agent, AIModel, SqliteStore, createTool, defaultPrices } from "eidentic";
${p.importLine}
import { z } from "zod";

const store = new SqliteStore("./eidentic.sqlite");
await store.migrate();

// A tiny example tool — replace or extend with your own.
const getTime = createTool({
  id: "get_time",
  description: "Get the current server time as an ISO string.",
  inputSchema: z.object({}),
  execute: async () => ({ now: new Date().toISOString() }),
});

export const agents = {
  assistant: new Agent({
    id: "assistant",
    instructions: "You are a helpful assistant.",
    model: new AIModel(${p.providerFn}("${modelId}")), // reads ${p.envVar} from env/.env
    tools: [getTime],
    store,
    prices: defaultPrices, // bundled price table — cost.usd populated in every run result
  }),
};
`;
}

function srcAgentTs(p: ProviderMeta, modelId: string): string {
  return `try { process.loadEnvFile(); } catch {}
import { Agent, AIModel, SqliteStore, createTool, defaultPrices } from "eidentic";
${p.importLine}
import { z } from "zod";

// Persistent, event-sourced session store.
const store = new SqliteStore("./eidentic.sqlite");
await store.migrate();

// A tiny example tool — replace with your own.
const getTime = createTool({
  id: "get_time",
  description: "Get the current server time as an ISO string.",
  inputSchema: z.object({}),
  execute: async () => ({ now: new Date().toISOString() }),
});

const agent = new Agent({
  id: "assistant",
  instructions: "You are a helpful assistant. Use tools when relevant, then answer concisely.",
  model: new AIModel(${p.providerFn}("${modelId}")), // reads ${p.envVar} from env
  tools: [getTime],
  store,
  prices: defaultPrices, // bundled price table — cost.usd populated in every run result
});

for await (const ev of agent.query("What time is it right now?", { sessionId: "session-1" })) {
  if (ev.type === "result") console.log("\\n" + String(ev.output));
}

await store.close();
`;
}

function directoryAgentTs(p: ProviderMeta, modelId: string): string {
  return `import { AIModel, SqliteStore, defaultPrices } from "eidentic";
${p.importLine}

const store = new SqliteStore("./eidentic.sqlite");
await store.migrate();

export default {
  id: "assistant",
  model: new AIModel(${p.providerFn}("${modelId}")), // reads ${p.envVar} from env/.env
  store,
  prices: defaultPrices,
};
`;
}

function directoryToolTs(): string {
  return `import { createTool } from "eidentic";
import { z } from "zod";

export default createTool({
  id: "get_time",
  description: "Get the current server time as an ISO string.",
  inputSchema: z.object({}),
  sideEffect: "read-only",
  execute: async () => ({ now: new Date().toISOString() }),
});
`;
}

export interface InitOptions {
  provider?: Provider;
  model?: string;
  apiKey?: string;
  /** Programmatic callers keep the legacy format by default; the CLI opts into directory mode. */
  format?: "config" | "directory";
}

/**
 * Scaffold Eidentic into an existing project directory (idempotent — never overwrites).
 *
 * @param cwd - Target directory (must exist or will be created).
 * @param opts - Optional options (provider, model, apiKey).
 * @returns Lists of relative paths that were created vs skipped.
 */
export function initProject(
  cwd: string,
  opts: InitOptions = {},
): InitResult {
  if (opts.apiKey !== undefined && /[\r\n\0]/.test(opts.apiKey)) {
    throw new Error("initProject: apiKey contains an invalid line break or NUL byte");
  }
  const provider = opts.provider ?? "anthropic";
  const p = INIT_PROVIDERS[provider];
  const modelId = opts.model ?? p.modelId;
  const format = opts.format ?? "config";

  const created: string[] = [];
  const skipped: string[] = [];

  function writeIfAbsent(rel: string, content: string): void {
    const abs = join(cwd, rel);
    if (existsSync(abs)) {
      skipped.push(rel);
    } else {
      const dir = join(cwd, rel.includes("/") ? rel.split("/").slice(0, -1).join("/") : ".");
      mkdirSync(dir, { recursive: true });
      writeFileSync(abs, content, "utf8");
      created.push(rel);
    }
  }

  if (format === "directory") {
    writeIfAbsent("agent/instructions.md", "You are a helpful assistant. Use tools when relevant, then answer concisely.\n");
    writeIfAbsent("agent/agent.ts", directoryAgentTs(p, modelId));
    writeIfAbsent("agent/tools/get-time.ts", directoryToolTs());
  } else {
    // Legacy programmatic format remains supported for existing callers.
    writeIfAbsent("eidentic.config.ts", eidenticConfigTs(p, modelId));
    writeIfAbsent("src/agent.ts", srcAgentTs(p, modelId));
  }

  // 3. .env.example — always with an empty value (never write the real key here)
  writeIfAbsent(".env.example", `# Get a key at https://console.anthropic.com (or your provider's dashboard)\n${p.envVar}=\n`);

  // 4. .gitignore — ensure .env is gitignored BEFORE writing the key (security)
  const giAbs = join(cwd, ".gitignore");
  if (existsSync(giAbs)) {
    const existing = readFileSync(giAbs, "utf8");
    if (!existing.split("\n").map((l) => l.trim()).includes(".env")) {
      appendFileSync(giAbs, "\n.env\n");
      created.push(".gitignore (appended .env)");
    } else {
      skipped.push(".gitignore");
    }
  } else {
    writeFileSync(giAbs, "node_modules\ndist\n*.sqlite\n.env\n", "utf8");
    created.push(".gitignore");
  }

  // 5. .env — only if absent; write key if provided (gitignored above)
  const envAbs = join(cwd, ".env");
  const envValue = opts.apiKey ? opts.apiKey : "";
  let envFd: number | undefined;
  try {
    envFd = openSync(
      envAbs,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW ?? 0),
      0o600,
    );
    writeFileSync(envFd, `${p.envVar}=${envValue}\n`, "utf8");
    fsyncSync(envFd);
    closeSync(envFd);
    envFd = undefined;
    created.push(".env");
  } catch (error) {
    if (envFd !== undefined) closeSync(envFd);
    if ((error as NodeJS.ErrnoException).code === "EEXIST") {
      skipped.push(".env");
    } else {
      throw error;
    }
  }

  return { created, skipped };
}

// ---------------------------------------------------------------------------
// doctor
// ---------------------------------------------------------------------------

const PROVIDER_KEYS = [
  "ANTHROPIC_API_KEY",
  "OPENAI_API_KEY",
  "GOOGLE_GENERATIVE_AI_API_KEY",
  "DEEPSEEK_API_KEY",
  "MISTRAL_API_KEY",
] as const;

/**
 * Run diagnostic checks and return a structured report.
 *
 * @param env - Environment variables (defaults to process.env for testability).
 * @param cwd - Working directory to look for a config file (defaults to process.cwd()).
 */
export function doctor(
  env: Record<string, string | undefined> = process.env as Record<string, string | undefined>,
  cwd: string = process.cwd(),
): DoctorReport {
  const checks: DoctorCheck[] = [];

  // 1. Node version >= 22
  const rawVersion = process.version; // e.g. "v22.1.0"
  const major = parseInt(rawVersion.replace(/^v/, "").split(".")[0] ?? "0", 10);
  const nodeOk = major >= 22;
  checks.push({
    name: "Node.js >= 22",
    ok: nodeOk,
    detail: nodeOk
      ? `Node ${rawVersion} (OK)`
      : `Node ${rawVersion} is too old — upgrade to >= 22`,
  });

  // 2. At least one model-provider API key present
  const foundKey = PROVIDER_KEYS.find((k) => Boolean(env[k]));
  const providerOk = foundKey !== undefined;
  checks.push({
    name: "Model provider key",
    ok: providerOk,
    detail: providerOk
      ? `${foundKey} is set`
      : `None of ${PROVIDER_KEYS.join(", ")} found in environment`,
  });

  // 3. A supported Eidentic project exists in cwd.
  let project: EidenticProject | null = null;
  try { project = resolveProject(cwd); } catch { /* invalid/missing project is reported below */ }
  const projectOk = project !== null;
  checks.push({
    name: "Eidentic project",
    ok: projectOk,
    detail: project?.kind === "config"
      ? `Found ${project.configPath}`
      : project?.kind === "directory"
        ? `Found ${relative(project.root, project.instructionsPath)}`
        : `No eidentic.config.* or agent/instructions.md in ${cwd}`,
  });

  // 4. .env file present in cwd (informational — always ok:true)
  const dotEnvExists = existsSync(join(cwd, ".env"));
  checks.push({
    name: ".env file",
    ok: true,
    detail: dotEnvExists ? `Found ${join(cwd, ".env")}` : `No .env in ${cwd} (optional — set env vars another way)`,
  });

  const ok = checks.every((c) => c.ok);
  return { checks, ok };
}

// ---------------------------------------------------------------------------
// resolveConfigPath
// ---------------------------------------------------------------------------

const CONFIG_NAMES = ["eidentic.config.ts", "eidentic.config.js", "eidentic.config.mjs"] as const;

export type EidenticProject =
  | { kind: "config"; root: string; configPath: string }
  | {
      kind: "directory";
      root: string;
      agentRoot: string;
      instructionsPath: string;
      agentModulePath?: string;
      toolModulePaths?: string[];
    };

export type DirectoryAgentDefinition = Omit<AgentConfig, "id" | "instructions"> & {
  id?: string;
};

export interface LoadProjectOptions {
  importDirectoryModule?: (modulePath?: string) => Promise<unknown>;
  importToolModule?: (modulePath: string) => Promise<unknown>;
}

const MAX_INSTRUCTIONS_BYTES = 256 * 1024;
const MAX_DISCOVERED_TOOLS = 64;
const TOOL_MODULE_EXTENSIONS = new Set([".ts", ".js", ".mjs"]);

function assertProjectPath(root: string, candidate: string, label: string): string {
  const resolved = realpathSync(candidate);
  const rel = relative(root, resolved);
  if (rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
    throw new Error(`${label} resolves outside the project root: ${candidate}`);
  }
  return resolved;
}

function directoryProject(root: string, agentRoot: string): EidenticProject | null {
  const instructionsCandidate = join(agentRoot, "instructions.md");
  if (!existsSync(instructionsCandidate)) return null;
  const safeAgentRoot = assertProjectPath(root, agentRoot, "agent directory");
  const instructionsPath = assertProjectPath(root, instructionsCandidate, "instructions.md");
  const moduleCandidate = join(safeAgentRoot, "agent.ts");
  const agentModulePath = existsSync(moduleCandidate)
    ? assertProjectPath(root, moduleCandidate, "agent.ts")
    : undefined;
  const toolsRoot = join(safeAgentRoot, "tools");
  const toolModulePaths = existsSync(toolsRoot)
    ? readdirSync(toolsRoot, { withFileTypes: true })
      .filter((entry) => (entry.isFile() || entry.isSymbolicLink()) && TOOL_MODULE_EXTENSIONS.has(extname(entry.name)))
      .map((entry) => assertProjectPath(root, join(toolsRoot, entry.name), `tool module ${entry.name}`))
      .sort((a, b) => basename(a).localeCompare(basename(b), "en"))
    : [];
  if (toolModulePaths.length > MAX_DISCOVERED_TOOLS) {
    throw new Error(`agent/tools contains too many modules (maximum ${MAX_DISCOVERED_TOOLS})`);
  }
  return {
    kind: "directory",
    root,
    agentRoot: safeAgentRoot,
    instructionsPath,
    ...(agentModulePath !== undefined ? { agentModulePath } : {}),
    ...(toolModulePaths.length > 0 ? { toolModulePaths } : {}),
  };
}

/** Resolve either the legacy config project or the additive `agent/` directory convention. */
export function resolveProject(cwd: string, explicit?: string): EidenticProject | null {
  const root = realpathSync(cwd);
  if (explicit !== undefined) {
    const requested = isAbsolute(explicit) ? explicit : resolve(root, explicit);
    if (!existsSync(requested)) return null;
    const safeRequested = assertProjectPath(root, requested, "explicit project path");
    if (statSync(safeRequested).isDirectory()) return directoryProject(root, safeRequested);
    return { kind: "config", root, configPath: safeRequested };
  }

  const configPath = resolveConfigPath(root);
  if (configPath !== null) return { kind: "config", root, configPath };
  return directoryProject(root, join(root, "agent"));
}

function validateDirectoryDefinition(raw: unknown, modulePath?: string): DirectoryAgentDefinition {
  if (!raw || typeof raw !== "object") {
    throw new Error(`${modulePath ?? "directory runtime"} must export an agent runtime object`);
  }
  const definition = raw as Record<string, unknown>;
  if (Object.prototype.hasOwnProperty.call(definition, "instructions")) {
    throw new Error("Directory agent instructions must come from instructions.md, not agent.ts");
  }
  if (!definition["model"] || typeof definition["model"] !== "object") {
    throw new Error(`${modulePath ?? "directory runtime"} must provide a model`);
  }
  if (!definition["store"] || typeof definition["store"] !== "object") {
    throw new Error(`${modulePath ?? "directory runtime"} must provide a store`);
  }
  if (definition["id"] !== undefined && (typeof definition["id"] !== "string" || definition["id"].trim() === "")) {
    throw new Error(`${modulePath ?? "directory runtime"} id must be a non-empty string`);
  }
  return definition as unknown as DirectoryAgentDefinition;
}

function validateToolModule(raw: unknown, modulePath: string): Tool {
  if (!raw || typeof raw !== "object") throw new Error(`${modulePath} must default-export a tool object`);
  const tool = raw as Record<string, unknown>;
  if (typeof tool["id"] !== "string" || tool["id"].trim() === "") {
    throw new Error(`${modulePath} tool id must be a non-empty string`);
  }
  if (typeof tool["execute"] !== "function" || !tool["jsonSchema"] || typeof tool["jsonSchema"] !== "object") {
    throw new Error(`${modulePath} must default-export a valid Eidentic tool`);
  }
  return raw as Tool;
}

/** Compile either project format to the existing server/Studio configuration contract. */
export async function loadProject(
  project: EidenticProject,
  opts: LoadProjectOptions = {},
): Promise<EidenticConfig> {
  if (project.kind === "config") return loadConfig(project.configPath);

  const instructionStat = statSync(project.instructionsPath);
  if (!instructionStat.isFile()) throw new Error("Directory agent instructions.md must be a regular file");
  if (instructionStat.size > MAX_INSTRUCTIONS_BYTES) {
    throw new Error(`Directory agent instructions.md is too large (maximum ${MAX_INSTRUCTIONS_BYTES} bytes)`);
  }
  const instructions = readFileSync(project.instructionsPath, "utf8").trim();
  if (instructions === "") throw new Error("Directory agent instructions.md is empty");

  let rawDefinition: unknown;
  if (opts.importDirectoryModule) {
    rawDefinition = await opts.importDirectoryModule(project.agentModulePath);
  } else {
    if (!project.agentModulePath) {
      throw new Error("Directory agent requires agent.ts with model and store runtime configuration");
    }
    const jiti = createJiti(import.meta.url);
    rawDefinition = await jiti.import<unknown>(project.agentModulePath, { default: true });
  }
  const definition = validateDirectoryDefinition(rawDefinition, project.agentModulePath);
  const id = definition.id?.trim() || basename(project.agentRoot);
  const discoveredTools: Tool[] = [];
  if (project.toolModulePaths?.length) {
    const jiti = opts.importToolModule ? undefined : createJiti(import.meta.url);
    for (const modulePath of project.toolModulePaths) {
      const rawTool = opts.importToolModule
        ? await opts.importToolModule(modulePath)
        : await jiti!.import<unknown>(modulePath, { default: true });
      discoveredTools.push(validateToolModule(rawTool, modulePath));
    }
  }
  const tools = [...(definition.tools ?? []), ...discoveredTools];
  const seenToolIds = new Set<string>();
  for (const tool of tools) {
    if (seenToolIds.has(tool.id)) throw new Error(`Duplicate tool id in directory project: ${tool.id}`);
    seenToolIds.add(tool.id);
  }
  const agent = new Agent({ ...definition, id, instructions, ...(tools.length > 0 ? { tools } : {}) });
  return { agents: { [id]: agent } };
}

/**
 * Find the eidentic config file.
 *
 * @param cwd - Directory to search in.
 * @param explicit - Explicit path override.
 * @returns Absolute path to the config file, or null if not found.
 */
export function resolveConfigPath(cwd: string, explicit?: string): string | null {
  if (explicit) {
    return existsSync(explicit) ? explicit : null;
  }
  for (const name of CONFIG_NAMES) {
    const full = join(cwd, name);
    if (existsSync(full)) return full;
  }
  return null;
}

// ---------------------------------------------------------------------------
// loadConfig
// ---------------------------------------------------------------------------

/**
 * Load a eidentic config file using jiti (supports .ts/.js/.mjs without a build step).
 *
 * @param configPath - Absolute path to the config file.
 * @returns The resolved EidenticConfig.
 */
export async function loadConfig(configPath: string): Promise<EidenticConfig> {
  const jiti = createJiti(import.meta.url);
  // jiti.import with { default: true } returns mod?.default ?? mod
  const raw = await jiti.import<EidenticConfig | { default: EidenticConfig }>(
    configPath,
    { default: true },
  );

  // Normalise: the loaded value might itself be the config or have a .default
  const config = raw as EidenticConfig;

  if (
    !config ||
    typeof config !== "object" ||
    !config.agents ||
    typeof config.agents !== "object"
  ) {
    throw new Error(
      `Config at ${configPath} must export an object with an "agents" field (Record<string, Agent>).`,
    );
  }

  const agentIds = Object.keys(config.agents);
  if (agentIds.length === 0) {
    throw new Error(
      `Config at ${configPath} has an empty "agents" object — add at least one agent.`,
    );
  }

  return config;
}

// ---------------------------------------------------------------------------
// buildServer
// ---------------------------------------------------------------------------

/**
 * Build a Hono app from a EidenticConfig.
 * Separated from serveNode so tests can call app.request() without binding a port.
 */
export function buildServer(config: EidenticConfig): Hono {
  return createServer({
    agents: config.agents,
    auth: config.auth,
    basePath: config.basePath,
    exposeEvents: config.exposeEvents,
  });
}

// ---------------------------------------------------------------------------
// evalGateCheck — pure, testable CI-gate logic
// ---------------------------------------------------------------------------

export interface AggregateEntry { mean: number; pass: number; n: number; }
export interface EvalReportShape {
  cases: Array<{
    caseId: string;
    input: string;
    samples: Array<{ sampleIndex: number; scores: Record<string, unknown>; runnerError?: string }>;
    scorerMeans: Record<string, AggregateEntry>;
  }>;
  aggregate: Record<string, AggregateEntry>;
}

/**
 * Compute the aggregate pass rate from an EvalReport-shaped object.
 * Mean of per-scorer pass fractions across all scorers.
 * Returns 0 when there are no scorers.
 */
export function computePassRate(aggregate: Record<string, AggregateEntry>): number {
  const entries = Object.values(aggregate);
  return entries.length === 0
    ? 0
    : entries.reduce((sum, e) => sum + e.pass, 0) / entries.length;
}

/**
 * Validate that the report meets the threshold. Returns an object describing the outcome
 * rather than throwing — callers decide how to surface failures. This keeps the logic
 * pure and fully testable without touching process.exit.
 */
export interface GateCheckResult {
  passed: boolean;
  actualPassRate: number;
  requiredPassRate: number;
  /** Cases whose per-case pass rate is below threshold. */
  failedCases: Array<{ caseId: string; passRate: number }>;
}

export function evalGateCheck(report: EvalReportShape, threshold: number): GateCheckResult {
  const actualPassRate = computePassRate(report.aggregate);
  const failedCases = report.cases
    .map((c) => {
      const entries = Object.values(c.scorerMeans);
      const casePassRate =
        entries.length === 0
          ? 0
          : entries.reduce((sum, e) => sum + e.pass, 0) / entries.length;
      return { caseId: c.caseId, passRate: casePassRate };
    })
    .filter((c) => c.passRate < threshold);
  return {
    passed: actualPassRate >= threshold,
    actualPassRate,
    requiredPassRate: threshold,
    failedCases,
  };
}

// ---------------------------------------------------------------------------
// runEval
// ---------------------------------------------------------------------------

export interface EvalConfig {
  /** Runner function: `(input: string) => Promise<RunnerResult>`. */
  runner: (input: string) => Promise<{ sessionId: string; events: unknown[]; finalText?: string; finalSubtype?: string }>;
  /** Dataset to evaluate. */
  dataset: { name: string; cases: { id: string; input: string; groundTruth: unknown; expected?: unknown; capturedEvents?: unknown[] }[] };
  /** Scorers to apply. */
  scorers: Array<{ name: string; score(ctx: unknown): Promise<{ score: number; passed: boolean; rationale?: string }> | { score: number; passed: boolean; rationale?: string } }>;
  /** Number of samples per case. Default 1. */
  samples?: number;
}

export interface RunEvalOptions {
  /** When true, throw `EvalThresholdError` if the pass rate is below threshold. */
  ci?: boolean;
  /** Pass-rate threshold in [0, 1]. Only used when `ci` is true. Default 1. */
  threshold?: number;
  /**
   * Path to a baseline EvalReport JSON file. When provided, `compareReports` is
   * run against the loaded baseline and the result is included in the output.
   * When `ci` is also set, a non-zero exit is triggered on any regression.
   */
  baselinePath?: string;
  /**
   * Path where the current EvalReport will be saved as JSON (baseline snapshot).
   * The directory is created if it does not exist.
   */
  saveBaselinePath?: string;
  /**
   * Path where the rendered Markdown report will be written.
   */
  reportPath?: string;
}

export interface RunEvalResult {
  /** Human-readable summary string. */
  summary: string;
  /** The raw EvalReport for programmatic inspection. */
  report: EvalReportShape;
  /** Aggregate pass rate in [0, 1]. */
  passRate: number;
  /** Comparison result when a baseline was loaded (undefined otherwise). */
  compareResult?: {
    regressions: Array<{ caseName: string; scorer: string; baseline: number; current: number; delta: number }>;
    improvements: Array<{ caseName: string; scorer: string; baseline: number; current: number; delta: number }>;
    unchanged: number;
    verdict: "pass" | "regressed";
  };
  /** The rendered Markdown report (always produced; written to reportPath when set). */
  markdownReport: string;
}

/**
 * Load an eval config file (supports .ts/.js/.mjs via jiti), run the eval,
 * produce a summary, and optionally throw `EvalThresholdError` when `opts.ci` is true.
 *
 * The eval config file must export (or default-export) an `EvalConfig`-shaped object.
 */
export async function runEval(
  configPath: string,
  opts: RunEvalOptions = {},
): Promise<RunEvalResult> {
  const jiti = createJiti(import.meta.url);
  const raw = await jiti.import<EvalConfig | { default: EvalConfig }>(configPath, { default: true });
  const evalConfig = raw as EvalConfig;

  if (!evalConfig || typeof evalConfig !== "object" || !evalConfig.runner || !evalConfig.dataset || !evalConfig.scorers) {
    throw new Error(
      `Eval config at ${configPath} must export { runner, dataset, scorers } (and optionally samples).`,
    );
  }

  // Dynamically import @eidentic/eval (workspace dep — always present in the monorepo).
  const evalMod = await import("@eidentic/eval");

  const report = await evalMod.evaluate(
    evalConfig.runner as Parameters<typeof evalMod.evaluate>[0],
    evalConfig.dataset as Parameters<typeof evalMod.evaluate>[1],
    {
      scorers: evalConfig.scorers as Parameters<typeof evalMod.evaluate>[2]["scorers"],
      samples: evalConfig.samples,
    },
  );

  const summary = evalMod.summarize(report);
  const passRate = computePassRate(report.aggregate);

  // ── Baseline comparison ──────────────────────────────────────────────────
  let compareResult: RunEvalResult["compareResult"] | undefined;
  if (opts.baselinePath) {
    const baselineRaw = readFileSync(opts.baselinePath, "utf8");
    const baseline = JSON.parse(baselineRaw) as EvalReportShape;
    compareResult = evalMod.compareReports(baseline as Parameters<typeof evalMod.compareReports>[0], report as Parameters<typeof evalMod.compareReports>[1]);
  }

  // ── Markdown report ──────────────────────────────────────────────────────
  const markdownReport = evalMod.renderReportMarkdown(
    report as Parameters<typeof evalMod.renderReportMarkdown>[0],
    compareResult ? { compare: compareResult as NonNullable<Parameters<typeof evalMod.renderReportMarkdown>[1]>["compare"] } : {},
  );

  // ── Write markdown report ────────────────────────────────────────────────
  if (opts.reportPath) {
    const reportDir = dirname(opts.reportPath);
    if (reportDir && reportDir !== ".") {
      mkdirSync(reportDir, { recursive: true });
    }
    writeFileSync(opts.reportPath, markdownReport, "utf8");
  }

  // ── Save baseline ────────────────────────────────────────────────────────
  if (opts.saveBaselinePath) {
    const baselineDir = dirname(opts.saveBaselinePath);
    if (baselineDir && baselineDir !== ".") {
      mkdirSync(baselineDir, { recursive: true });
    }
    writeFileSync(opts.saveBaselinePath, JSON.stringify(report, null, 2), "utf8");
  }

  // ── CI gate ──────────────────────────────────────────────────────────────
  if (opts.ci) {
    // Regression check (baseline comparison takes precedence when available).
    if (compareResult && compareResult.verdict === "regressed") {
      // Surface regression details via EvalThresholdError shape for consistent CLI handling.
      const regressionMsg = compareResult.regressions
        .map((r) => `  - ${r.caseName}/${r.scorer}: ${(r.baseline * 100).toFixed(1)}% → ${(r.current * 100).toFixed(1)}% (${(r.delta * 100).toFixed(1)}pp)`)
        .join("\n");
      const err = new Error(
        `Eval regressions detected (${compareResult.regressions.length}):\n${regressionMsg}`,
      ) as Error & { name: string; actualPassRate: number; requiredPassRate: number };
      err.name = "EvalRegressionError";
      err.actualPassRate = passRate;
      err.requiredPassRate = opts.threshold ?? 1;
      throw err;
    }
    // Standard pass-rate gate (when no baseline regression was triggered).
    evalMod.assertPassRate(report, opts.threshold ?? 1);
  }

  return { summary, report: report as EvalReportShape, passRate, compareResult, markdownReport };
}

// ---------------------------------------------------------------------------
// addSkill — pure, injectable, testable
// ---------------------------------------------------------------------------

/**
 * The default skills directory name inside a project root.
 * Matches the directory layout expected by `SkillSet.loadFromDir`.
 */
export const SKILLS_DIR_NAME = "skills";

/**
 * A source resolver maps a skill name (non-path string) to an absolute directory path
 * containing the skill (i.e. a directory with a `SKILL.md`), or returns null when the
 * name cannot be resolved.
 *
 * The default resolver looks up skills from a configured source directory (a local
 * "registry" directory containing one subdirectory per skill, each with a `SKILL.md`).
 * Network-registry resolution is explicitly out of scope.
 */
export type SkillSourceResolver = (name: string) => string | null;

/**
 * Build a simple directory-backed resolver: scans `sourceDir` for immediate
 * subdirectories and maps their basenames to absolute paths.
 */
export function makeDirResolver(sourceDir: string): SkillSourceResolver {
  return (name: string): string | null => {
    const candidate = join(resolve(sourceDir), name);
    if (existsSync(candidate) && statSync(candidate).isDirectory()) {
      return candidate;
    }
    return null;
  };
}

export interface AddSkillOptions {
  /**
   * When true, overwrite an existing skill with the same name.
   * Defaults to false (refuse on collision).
   */
  force?: boolean;
  /**
   * Inject a custom source resolver for non-path names. Defaults to a resolver
   * that always returns null (names not resolvable without explicit path).
   */
  resolver?: SkillSourceResolver;
  /**
   * Project root where `skills/<name>/` is written.
   * Defaults to `process.cwd()`.
   */
  projectRoot?: string;
  /**
   * Override the warning implementation (useful in tests to capture warnings
   * without polluting stdout).  Defaults to `console.warn`.
   */
  warnImpl?: (message: string) => void;
}

export interface AddSkillResult {
  /** The installed skill name (from the SKILL.md `name` field). */
  name: string;
  /** Absolute path to the installed skill directory. */
  installedAt: string;
  /** true when an existing skill was overwritten (requires force:true). */
  replaced: boolean;
}

/**
 * Install a skill into the project's local skills directory.
 *
 * Source resolution:
 *  - If `source` looks like a path (absolute, or starts with `.`/`..`/contains `/`),
 *    it is treated as a local directory containing a `SKILL.md`.
 *  - Otherwise `source` is treated as a name and passed to the `resolver`.
 *
 * Validation: the `SKILL.md` is parsed with `parseSkillMd` (from `@eidentic/skills`)
 * before installation. Invalid skills are rejected with a clear error.
 *
 * Collision: if the target directory already exists and `force` is false, throws
 * an error naming the conflicting path.
 *
 * @param source - Local path OR name to resolve.
 * @param opts   - Options (force, resolver, projectRoot).
 * @returns AddSkillResult on success; throws on failure.
 */
export async function addSkill(
  source: string,
  opts: AddSkillOptions = {},
): Promise<AddSkillResult> {
  const projectRoot = opts.projectRoot ?? process.cwd();
  const resolver = opts.resolver ?? ((): null => null);
  const force = opts.force ?? false;

  // ── 1. Resolve source directory ─────────────────────────────────────────
  let skillSrcDir: string;
  const isPath = isAbsolute(source) || source.startsWith(".") || source.includes("/");
  if (isPath) {
    skillSrcDir = isAbsolute(source) ? source : resolve(projectRoot, source);
  } else {
    const resolved = resolver(source);
    if (resolved === null) {
      throw new Error(
        `addSkill: cannot resolve skill "${source}". ` +
        `Pass a path (starting with . / .. or absolute) or inject a resolver that knows where to find "${source}".`,
      );
    }
    skillSrcDir = resolved;
  }

  // ── 2. Check source exists and is a directory ────────────────────────────
  if (!existsSync(skillSrcDir)) {
    throw new Error(`addSkill: source not found: "${skillSrcDir}"`);
  }
  const srcStat = statSync(skillSrcDir);
  if (!srcStat.isDirectory()) {
    throw new Error(
      `addSkill: source must be a directory containing SKILL.md, got a file: "${skillSrcDir}"`,
    );
  }

  // ── 3. Read and validate SKILL.md ────────────────────────────────────────
  const skillMdPath = join(skillSrcDir, "SKILL.md");
  if (!existsSync(skillMdPath)) {
    throw new Error(
      `addSkill: no SKILL.md found in "${skillSrcDir}". ` +
      `A skill directory must contain a SKILL.md file.`,
    );
  }

  const skillMdContent = readFileSync(skillMdPath, "utf8");

  // Dynamic import so the CLI package does not add @eidentic/skills as a hard dep —
  // vitest aliases resolve it in tests; the real CLI resolves it from the workspace.
  let parseSkillMd: (content: string) => { manifest: { name: string; description: string }; body: string };
  try {
    const mod = await import("@eidentic/skills");
    parseSkillMd = mod.parseSkillMd as typeof parseSkillMd;
  } catch {
    throw new Error(
      "addSkill: @eidentic/skills is not installed. Add it to your project to use `eidentic add skill`.",
    );
  }

  let manifest: { name: string; description: string };
  try {
    ({ manifest } = parseSkillMd(skillMdContent));
  } catch (err) {
    throw new Error(
      `addSkill: invalid SKILL.md in "${skillSrcDir}": ${(err as Error).message}`,
    );
  }

  // ── 4. Determine install destination ─────────────────────────────────────
  const skillsDir = join(projectRoot, SKILLS_DIR_NAME);
  const destDir = join(skillsDir, manifest.name);

  // ── 5. Collision check ───────────────────────────────────────────────────
  const alreadyExists = existsSync(destDir);
  if (alreadyExists && !force) {
    throw new Error(
      `addSkill: skill "${manifest.name}" already exists at "${destDir}". ` +
      `Pass --force to overwrite.`,
    );
  }

  // ── 6. Warn if the skill bundle contains executable files ────────────────
  const executableFiles = collectExecutableFiles(skillSrcDir);
  if (executableFiles.length > 0) {
    const warn = opts.warnImpl ?? console.warn;
    warn(
      `[eidentic add skill] The skill bundle contains executable file(s) — review before trusting:\n` +
      executableFiles.map((f) => `  • ${f}`).join("\n"),
    );
  }

  // ── 7. Copy skill files ──────────────────────────────────────────────────
  mkdirSync(destDir, { recursive: true });
  copySkillDir(skillSrcDir, destDir);

  return {
    name: manifest.name,
    installedAt: destDir,
    replaced: alreadyExists,
  };
}

/** File extensions considered executable / potentially dangerous in a skill bundle. */
const EXECUTABLE_EXTENSIONS = new Set([".ts", ".js", ".mjs", ".cjs", ".tsx", ".jsx", ".sh", ".py", ".rb", ".pl"]);

/**
 * Collect all executable-looking file paths under `dir` recursively
 * (relative to `dir`).  Used to warn before installing a skill.
 */
function collectExecutableFiles(dir: string, base = ""): string[] {
  const results: string[] = [];
  const entries = readdirSync(dir, { withFileTypes: true });
  for (const entry of entries) {
    if (entry.isSymbolicLink()) continue;
    if (entry.name === ".memory.md") continue;
    const rel = base ? `${base}/${entry.name}` : entry.name;
    if (entry.isDirectory()) {
      results.push(...collectExecutableFiles(join(dir, entry.name), rel));
    } else if (entry.isFile()) {
      const ext = entry.name.includes(".") ? `.${entry.name.split(".").pop()!.toLowerCase()}` : "";
      if (EXECUTABLE_EXTENSIONS.has(ext)) {
        results.push(rel);
      }
    }
  }
  return results;
}

/**
 * Recursively copy a skill directory (excluding `.memory.md` — runtime artefact
 * that should not be carried from the source). Symlinks are not followed.
 */
function copySkillDir(src: string, dest: string): void {
  const entries = readdirSync(src, { withFileTypes: true });
  for (const entry of entries) {
    // Skip symlinks and the per-skill memory file (runtime artefact).
    if (entry.isSymbolicLink()) continue;
    if (entry.name === ".memory.md") continue;

    const srcPath = join(src, entry.name);
    const destPath = join(dest, entry.name);

    if (entry.isDirectory()) {
      mkdirSync(destPath, { recursive: true });
      copySkillDir(srcPath, destPath);
    } else if (entry.isFile()) {
      copyFileSync(srcPath, destPath);
    }
  }
}

// ---------------------------------------------------------------------------
// addComponent — pure, injectable, testable
// ---------------------------------------------------------------------------

/** Names of the built-in components shipped in `templates/components/`. */
export const COMPONENT_NAMES = ["chat", "workflow-trace", "run-status"] as const;
export type ComponentName = typeof COMPONENT_NAMES[number];

/** One-line descriptions for each built-in component. */
export const COMPONENT_DESCRIPTIONS: Record<ComponentName, string> = {
  chat: "Full-featured streaming chat UI using useAgent (messages, tool-call display, stop).",
  "workflow-trace": "Workflow run trace viewer using useWorkflowRun (step timeline, status badges).",
  "run-status": "Fire-and-poll async run status badge using useAsyncRun and useRunStatus.",
};

/**
 * The default target directory (relative to project root) where components
 * are installed.
 */
export const COMPONENTS_DIR_NAME = "components/eidentic";

export interface AddComponentOptions {
  /**
   * When true, overwrite an existing component file with the same name.
   * Defaults to false (refuse on collision). Also accepted as `overwrite`.
   */
  force?: boolean;
  /**
   * Alias for `force`. When true, overwrite an existing component file.
   */
  overwrite?: boolean;
  /**
   * Project root where `components/eidentic/<name>.tsx` is written.
   * Defaults to `process.cwd()`.
   */
  projectRoot?: string;
  /**
   * Override the target directory relative to `projectRoot`.
   * Defaults to `components/eidentic`.
   */
  targetDir?: string;
  /**
   * Override the source templates directory (absolute path).
   * Defaults to `<cli-package-root>/templates/components`.
   * Injected in tests for hermeticity.
   */
  templatesDir?: string;
}

export interface AddComponentResult {
  /** The component name that was installed. */
  name: ComponentName;
  /** Absolute path to the installed file. */
  installedAt: string;
  /** true when an existing file was overwritten (requires force:true). */
  replaced: boolean;
}

/**
 * Resolve the built-in templates directory.
 * This is `<package-root>/templates/components`, where package-root is the
 * directory containing this source file's compiled output.
 */
function resolveBuiltinTemplatesDir(): string {
  // In ESM the compiled output sits at `dist/commands.js` — two dirs up gives the package root.
  // We use `import.meta.url` for ESM builds; fall back to __dirname for CJS (tests use tsx/vitest
  // which may resolve as CJS).
  let pkgRoot: string;
  try {
    pkgRoot = dirname(dirname(fileURLToPath(import.meta.url)));
  } catch {
    // If import.meta.url is unavailable (e.g. CJS context), walk up from __dirname.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    pkgRoot = dirname(dirname((globalThis as any).__filename ?? __filename));
  }
  return join(pkgRoot, "templates", "components");
}

/**
 * Install a named UI component into the project's components directory.
 *
 * @param name - One of the COMPONENT_NAMES.
 * @param opts - Options (force, projectRoot, targetDir, templatesDir).
 * @returns AddComponentResult on success; throws on failure.
 */
export function addComponent(
  name: string,
  opts: AddComponentOptions = {},
): AddComponentResult {
  // ── 1. Validate name ──────────────────────────────────────────────────────
  if (!(COMPONENT_NAMES as readonly string[]).includes(name)) {
    throw new Error(
      `addComponent: unknown component "${name}". ` +
      `Available components: ${COMPONENT_NAMES.join(", ")}.`,
    );
  }
  const componentName = name as ComponentName;

  const projectRoot = opts.projectRoot ?? process.cwd();
  const force = opts.force ?? opts.overwrite ?? false;
  const relTargetDir = opts.targetDir ?? COMPONENTS_DIR_NAME;
  const templatesDir = opts.templatesDir ?? resolveBuiltinTemplatesDir();

  // ── 2. Locate source template ─────────────────────────────────────────────
  const srcFile = join(templatesDir, `${componentName}.tsx`);
  if (!existsSync(srcFile)) {
    throw new Error(
      `addComponent: template file not found: "${srcFile}". ` +
      `This is a bug in @eidentic/cli — please file an issue.`,
    );
  }

  // ── 3. Determine install destination ─────────────────────────────────────
  const destDir = join(projectRoot, relTargetDir);
  const destFile = join(destDir, `${componentName}.tsx`);

  // ── 4. Collision check ───────────────────────────────────────────────────
  const alreadyExists = existsSync(destFile);
  if (alreadyExists && !force) {
    throw new Error(
      `addComponent: component "${componentName}" already exists at "${destFile}". ` +
      `Pass --force to overwrite.`,
    );
  }

  // ── 5. Copy file ─────────────────────────────────────────────────────────
  mkdirSync(destDir, { recursive: true });
  copyFileSync(srcFile, destFile);

  return {
    name: componentName,
    installedAt: destFile,
    replaced: alreadyExists,
  };
}

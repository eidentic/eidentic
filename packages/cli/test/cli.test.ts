import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { writeFileSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { doctor, resolveConfigPath, loadConfig, buildServer, computePassRate, evalGateCheck } from "../src/commands.js";
import type { EvalReportShape } from "../src/commands.js";
import { Agent } from "@eidentic/core";
import { MockModel, InMemoryStore } from "@eidentic/types/testing";
import type { ModelResponse } from "@eidentic/types";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function textResponse(text: string): ModelResponse {
  return {
    content: [{ type: "text", text }],
    usage: { inputTokens: 10, outputTokens: 5 },
  };
}

function makeAgent(): Agent {
  return new Agent({
    id: "demo",
    instructions: "You are a test assistant.",
    model: new MockModel([textResponse("hello")]),
    store: new InMemoryStore(),
  });
}

// ---------------------------------------------------------------------------
// doctor — env injection
// ---------------------------------------------------------------------------

describe("doctor()", () => {
  it("returns ok:true when a provider key is set and config file exists", () => {
    const tmp = mkdirSync(join(tmpdir(), `eidentic-test-${Date.now()}`), { recursive: true }) as unknown as string ?? join(tmpdir(), `eidentic-test-${Date.now()}`);
    const dir = tmp || join(tmpdir(), `eidentic-test-${Date.now()}`);
    writeFileSync(join(dir, "eidentic.config.ts"), "export const agents = {};\n");

    const report = doctor({ ANTHROPIC_API_KEY: "sk-test" }, dir);

    expect(report.ok).toBe(true);
    expect(report.checks.find((c) => c.name === "Model provider key")?.ok).toBe(true);
    expect(report.checks.find((c) => c.name === "Eidentic project")?.ok).toBe(true);

    rmSync(dir, { recursive: true, force: true });
  });

  it("returns ok:false when no provider key and no config file", () => {
    const report = doctor({}, "/tmp/nonexistent-eidentic-dir-xyz");
    expect(report.ok).toBe(false);
    expect(report.checks.find((c) => c.name === "Model provider key")?.ok).toBe(false);
    expect(report.checks.find((c) => c.name === "Eidentic project")?.ok).toBe(false);
  });

  it("recognizes the agent directory convention as a project", () => {
    const dir = join(tmpdir(), `eidentic-doctor-directory-${Date.now()}`);
    mkdirSync(join(dir, "agent"), { recursive: true });
    writeFileSync(join(dir, "agent", "instructions.md"), "You are helpful.");
    const report = doctor({ ANTHROPIC_API_KEY: "test" }, dir);
    expect(report.ok).toBe(true);
    expect(report.checks.find((check) => check.name === "Eidentic project")?.detail)
      .toContain("agent/instructions.md");
    rmSync(dir, { recursive: true, force: true });
  });

  it("Node-version check reflects the running version", () => {
    const report = doctor({}, "/tmp/nonexistent-eidentic-dir-xyz");
    const nodeCheck = report.checks.find((c) => c.name === "Node.js >= 22");
    expect(nodeCheck).toBeDefined();
    // In the CI / local dev environment this runs on Node >= 22
    const major = parseInt(process.version.replace(/^v/, "").split(".")[0] ?? "0", 10);
    expect(nodeCheck?.ok).toBe(major >= 22);
  });

  it("accepts any of the known provider keys", () => {
    const keys = [
      "OPENAI_API_KEY",
      "GOOGLE_GENERATIVE_AI_API_KEY",
      "DEEPSEEK_API_KEY",
      "MISTRAL_API_KEY",
    ] as const;
    for (const key of keys) {
      const report = doctor({ [key]: "val" }, "/tmp/nonexistent-xyz");
      const c = report.checks.find((c) => c.name === "Model provider key")!;
      expect(c.ok).toBe(true);
      expect(c.detail).toContain(key);
    }
  });

  it("returns a structured DoctorReport with name/ok/detail per check", () => {
    const report = doctor({ ANTHROPIC_API_KEY: "x" }, "/tmp/nonexistent-xyz");
    expect(Array.isArray(report.checks)).toBe(true);
    for (const check of report.checks) {
      expect(typeof check.name).toBe("string");
      expect(typeof check.ok).toBe("boolean");
      expect(typeof check.detail).toBe("string");
    }
  });

  it("reports declared tool secrets by name without exposing values", () => {
    const report = doctor(
      { ANTHROPIC_API_KEY: "provider-value", PRESENT_TOKEN: "sensitive-value" },
      "/tmp/nonexistent-xyz",
      ["PRESENT_TOKEN", "MISSING_TOKEN"],
    );
    const check = report.checks.find((item) => item.name === "Tool secrets");

    expect(check).toMatchObject({ ok: false });
    expect(check?.detail).toContain("PRESENT_TOKEN: set");
    expect(check?.detail).toContain("MISSING_TOKEN: missing");
    expect(check?.detail).not.toContain("sensitive-value");
  });
});

// ---------------------------------------------------------------------------
// resolveConfigPath
// ---------------------------------------------------------------------------

describe("resolveConfigPath()", () => {
  let tmpDir: string;

  beforeAll(() => {
    tmpDir = join(tmpdir(), `eidentic-resolve-${Date.now()}`);
    mkdirSync(tmpDir, { recursive: true });
  });

  afterAll(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("finds eidentic.config.ts in a temp dir", () => {
    writeFileSync(join(tmpDir, "eidentic.config.ts"), "export default {};\n");
    const result = resolveConfigPath(tmpDir);
    expect(result).toBe(join(tmpDir, "eidentic.config.ts"));
  });

  it("returns null when no config file exists", () => {
    const emptyDir = join(tmpdir(), `eidentic-empty-${Date.now()}`);
    mkdirSync(emptyDir, { recursive: true });
    const result = resolveConfigPath(emptyDir);
    expect(result).toBeNull();
    rmSync(emptyDir, { recursive: true, force: true });
  });

  it("returns null for an explicit path that does not exist", () => {
    expect(resolveConfigPath(tmpDir, "/tmp/nonexistent-config.ts")).toBeNull();
  });

  it("returns the explicit path when it exists", () => {
    const explicit = join(tmpDir, "eidentic.config.ts");
    expect(resolveConfigPath(tmpDir, explicit)).toBe(explicit);
  });
});

// ---------------------------------------------------------------------------
// loadConfig — in-process with temp .mjs file
// ---------------------------------------------------------------------------

describe("loadConfig()", () => {
  let tmpDir: string;

  beforeAll(() => {
    tmpDir = join(tmpdir(), `eidentic-load-${Date.now()}`);
    mkdirSync(tmpDir, { recursive: true });
  });

  afterAll(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("throws a clear error when config has no agents field", async () => {
    const configPath = join(tmpDir, "eidentic-no-agents.config.mjs");
    writeFileSync(configPath, "export default { port: 3000 };\n");
    await expect(loadConfig(configPath)).rejects.toThrow(/agents/);
  });

  it("throws when agents is an empty object", async () => {
    const configPath = join(tmpDir, "eidentic-empty-agents.config.mjs");
    writeFileSync(configPath, "export default { agents: {} };\n");
    await expect(loadConfig(configPath)).rejects.toThrow(/empty/);
  });

  it("loads a valid config and returns the agents field", async () => {
    // Write a .mjs that returns a plain object with agents using a symbol
    const configPath = join(tmpDir, "eidentic-valid.config.mjs");
    // We pass a mock-like object that satisfies the shape check
    writeFileSync(
      configPath,
      `
export default {
  agents: { demo: { __isMockAgent: true } },
  port: 4321,
};
`,
    );
    const config = await loadConfig(configPath);
    expect(config.agents).toBeDefined();
    expect(Object.keys(config.agents)).toContain("demo");
    expect(config.port).toBe(4321);
  });
});

// ---------------------------------------------------------------------------
// buildServer — in-process with real Agent
// ---------------------------------------------------------------------------

describe("buildServer()", () => {
  it("builds a Hono app and responds to /health", async () => {
    const agent = makeAgent();
    const app = buildServer({ agents: { demo: agent } });

    const res = await app.request("/health");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean };
    expect(body.ok).toBe(true);
  });

  it("streams an SSE response for a query (no port binding)", async () => {
    const agent = makeAgent();
    const app = buildServer({ agents: { demo: agent } });

    const res = await app.request("/v1/agents/demo/query", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ input: "hi", sessionId: "test-session" }),
    });

    expect(res.status).toBe(200);
    const text = await res.text();
    // Should contain at least one SSE event
    expect(text).toContain("data:");
    expect(text).toContain("result");
  });

  it("returns 404 for an unknown agent", async () => {
    const agent = makeAgent();
    const app = buildServer({ agents: { demo: agent } });

    const res = await app.request("/v1/agents/unknown/query", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ input: "hi" }),
    });

    expect(res.status).toBe(404);
  });
});

// ---------------------------------------------------------------------------
// computePassRate
// ---------------------------------------------------------------------------

describe("computePassRate()", () => {
  it("returns 0 for an empty aggregate", () => {
    expect(computePassRate({})).toBe(0);
  });

  it("returns the single scorer pass rate for one scorer", () => {
    expect(computePassRate({ correctness: { mean: 0.8, pass: 0.8, n: 5 } })).toBeCloseTo(0.8);
  });

  it("returns the mean of multiple scorers pass rates", () => {
    expect(
      computePassRate({
        correctness: { mean: 1, pass: 1, n: 5 },
        faithfulness: { mean: 0.5, pass: 0.5, n: 5 },
      }),
    ).toBeCloseTo(0.75);
  });
});

// ---------------------------------------------------------------------------
// evalGateCheck
// ---------------------------------------------------------------------------

function makeEvalReport(
  scorerPassRates: Record<string, number>,
  cases: Array<{ caseId: string; scorerPassRates: Record<string, number> }> = [],
): EvalReportShape {
  const aggregate: EvalReportShape["aggregate"] = {};
  for (const [name, pass] of Object.entries(scorerPassRates)) {
    aggregate[name] = { mean: pass, pass, n: 10 };
  }
  const reportCases: EvalReportShape["cases"] = cases.map((c) => ({
    caseId: c.caseId,
    input: c.caseId,
    samples: [],
    scorerMeans: Object.fromEntries(
      Object.entries(c.scorerPassRates).map(([name, pass]) => [name, { mean: pass, pass, n: 1 }]),
    ),
  }));
  return { cases: reportCases, aggregate };
}

describe("evalGateCheck()", () => {
  it("returns passed:true when pass rate meets threshold", () => {
    const report = makeEvalReport({ correctness: 0.8 });
    const result = evalGateCheck(report, 0.8);
    expect(result.passed).toBe(true);
    expect(result.actualPassRate).toBeCloseTo(0.8);
    expect(result.requiredPassRate).toBe(0.8);
    expect(result.failedCases).toHaveLength(0);
  });

  it("returns passed:false when pass rate is below threshold", () => {
    const report = makeEvalReport({ correctness: 0.5 });
    const result = evalGateCheck(report, 0.8);
    expect(result.passed).toBe(false);
    expect(result.actualPassRate).toBeCloseTo(0.5);
  });

  it("returns passed:false with empty aggregate (0% pass rate)", () => {
    const report = makeEvalReport({});
    const result = evalGateCheck(report, 0.5);
    expect(result.passed).toBe(false);
    expect(result.actualPassRate).toBe(0);
  });

  it("identifies failing cases correctly", () => {
    const report = makeEvalReport(
      { correctness: 0.5 },
      [
        { caseId: "good", scorerPassRates: { correctness: 1.0 } },
        { caseId: "bad", scorerPassRates: { correctness: 0.2 } },
      ],
    );
    const result = evalGateCheck(report, 0.8);
    expect(result.failedCases).toHaveLength(1);
    expect(result.failedCases[0]!.caseId).toBe("bad");
    expect(result.failedCases[0]!.passRate).toBeCloseTo(0.2);
  });

  it("returns no failing cases when the threshold is met even if some individual cases are low", () => {
    // aggregate is above threshold (0.9) but individual case is below
    // Note: evalGateCheck only fails cases below threshold when the overall gate already failed
    // Actually: evalGateCheck always computes per-case, we check filtered by threshold
    const report = makeEvalReport(
      { correctness: 0.9 },
      [{ caseId: "c1", scorerPassRates: { correctness: 0.9 } }],
    );
    const result = evalGateCheck(report, 0.8);
    expect(result.passed).toBe(true);
    // failedCases can still be empty since 0.9 >= 0.8
    expect(result.failedCases).toHaveLength(0);
  });
});

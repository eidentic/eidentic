#!/usr/bin/env node
// Load .env before any commands run — Node-native, no deps needed.
try { process.loadEnvFile(); } catch { /* no .env present — fine */ }

import { defineCommand, runMain } from "citty";
import { consola } from "consola";
import pc from "picocolors";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { existsSync } from "node:fs";
import { spawn } from "node:child_process";
import { createInterface } from "node:readline/promises";
import { doctor, resolveProject, loadProject, buildServer, initProject, INIT_PROVIDERS, runEval, addSkill, makeDirResolver, addComponent, COMPONENT_NAMES, COMPONENT_DESCRIPTIONS } from "./commands.js";
import { consumeDevInput, watchAgentDirectory, type AgentDirectoryWatcher } from "./dev-console.js";
import type { EidenticConfig, Provider } from "./commands.js";
import { serveNode, NoAuth, type ServeNodeHandle } from "@eidentic/server";

// ---------------------------------------------------------------------------
// Version
// ---------------------------------------------------------------------------

const __dirname = dirname(fileURLToPath(import.meta.url));
const _require = createRequire(import.meta.url);
let PKG_VERSION = "0.0.0";
try {
  const pkg = _require(join(__dirname, "../package.json")) as { version: string };
  PKG_VERSION = pkg.version;
} catch {
  // fallback — stays "0.0.0"
}

// ---------------------------------------------------------------------------
// Subcommands
// ---------------------------------------------------------------------------

const doctorCmd = defineCommand({
  meta: {
    name: "doctor",
    description: "Check environment readiness: Node version, model-provider key, config file.",
  },
  async run() {
    const report = doctor();
    for (const check of report.checks) {
      if (check.ok) {
        consola.log(`  ${pc.green("✓")} ${check.name}: ${check.detail}`);
      } else {
        consola.log(`  ${pc.red("✗")} ${check.name}: ${check.detail}`);
      }
    }
    consola.log("");
    if (report.ok) {
      consola.success("All checks passed.");
    } else {
      consola.error("Some checks failed. Fix the issues above before running eidentic dev.");
      process.exit(1);
    }
  },
});

const devCmd = defineCommand({
  meta: {
    name: "dev",
    description:
      "Start a local dev server from eidentic.config.* or an agent directory.",
  },
  args: {
    config: {
      type: "positional",
      description: "Path to an Eidentic config file or agent directory (optional)",
      required: false,
    },
    port: {
      type: "string",
      description: "Port to listen on (default: 3000)",
      alias: ["p"],
    },
  },
  async run({ args }) {
    const explicitPath = args.config as string | undefined;
    const port = args.port ? parseInt(String(args.port), 10) : undefined;

    const project = resolveProject(process.cwd(), explicitPath);

    if (!project) {
      consola.error("No eidentic.config.* or agent/instructions.md found.");
      consola.info(
        "Create agent/instructions.md or eidentic.config.ts, or pass a path explicitly.",
      );
      consola.info("Run `eidentic doctor` for a full environment check.");
      process.exit(1);
    }

    let config: EidenticConfig;
    try {
      config = await loadProject(project);
    } catch (err) {
      consola.error(`Error loading config: ${(err as Error).message}`);
      process.exit(1);
    }

    const app = buildServer(config);
    const listenPort = port ?? config.port ?? 3000;

    let handle: ServeNodeHandle;
    try {
      handle = await serveNode(app, { port: listenPort });
    } catch (err) {
      consola.error(`Failed to start server: ${(err as Error).message}`);
      process.exit(1);
    }

    const agentIds = Object.keys(config.agents);
    const consoleAgents = { ...config.agents };
    let consoleBusy = false;
    let resolveConsoleIdle: (() => void) | undefined;
    const waitForConsoleIdle = (): Promise<void> => consoleBusy
      ? new Promise<void>((resolve) => { resolveConsoleIdle = resolve; })
      : Promise.resolve();
    let readline: ReturnType<typeof createInterface> | undefined;
    let directoryWatcher: AgentDirectoryWatcher | undefined;
    let stopping = false;
    const shutdown = async (): Promise<void> => {
      if (stopping) return;
      stopping = true;
      directoryWatcher?.close();
      readline?.close();
      await handle.drain(5_000);
      await config.close?.();
    };
    consola.success(
      `eidentic dev server running at ${pc.cyan(`http://localhost:${listenPort}`)}`,
    );
    consola.info(`Agents: ${pc.bold(agentIds.join(", "))}`);
    consola.info(process.stdin.isTTY ? "Chat below. Type /help for commands or press Ctrl+C to stop." : "Press Ctrl+C to stop.");

    if (process.stdin.isTTY && process.stdout.isTTY) {
      readline = createInterface({ input: process.stdin, output: process.stdout });
      async function* prompts(): AsyncIterable<string> {
        while (true) yield await readline!.question(pc.cyan("you › "));
      }
      void consumeDevInput(prompts(), {
        agents: consoleAgents,
        write: (line) => consola.log(line),
        onActivityChange: (active) => {
          consoleBusy = active;
          if (!active) {
            resolveConsoleIdle?.();
            resolveConsoleIdle = undefined;
          }
        },
      }).catch((error: unknown) => {
        if ((error as NodeJS.ErrnoException).code !== "ABORT_ERR") {
          consola.error(`Dev console stopped: ${(error as Error).message}`);
        }
      }).finally(() => {
        void shutdown();
      });
    }

    if (project.kind === "directory") {
      directoryWatcher = watchAgentDirectory(project.agentRoot, async () => {
        try {
          const nextProject = resolveProject(project.root, explicitPath);
          if (!nextProject || nextProject.kind !== "directory") throw new Error("agent directory is no longer valid");
          const nextConfig = await loadProject(nextProject);
          const nextApp = buildServer(nextConfig);
          await waitForConsoleIdle();
          const previousConfig = config;
          const previousApp = buildServer(previousConfig);
          await handle.drain(5_000);
          try {
            handle = await serveNode(nextApp, { port: listenPort });
          } catch (error) {
            handle = await serveNode(previousApp, { port: listenPort });
            await nextConfig.close?.();
            throw error;
          }
          config = nextConfig;
          for (const id of Object.keys(consoleAgents)) delete consoleAgents[id];
          Object.assign(consoleAgents, nextConfig.agents);
          await previousConfig.close?.();
          consola.success("Agent reloaded.");
        } catch (error) {
          consola.error(`Reload failed: ${(error as Error).message}`);
        }
      });
      consola.info("Watching agent/ for changes.");
    }

    process.on("SIGINT", async () => {
      await shutdown();
      process.exit(0);
    });
  },
});

// ---------------------------------------------------------------------------
// studio command
// ---------------------------------------------------------------------------

function openBrowser(url: string): void {
  try {
    const platform = process.platform;
    let cmd: string;
    let args: string[];
    if (platform === "darwin") {
      cmd = "open";
      args = [url];
    } else if (platform === "win32") {
      cmd = "cmd";
      args = ["/c", "start", url];
    } else {
      cmd = "xdg-open";
      args = [url];
    }
    spawn(cmd, args, { detached: true, stdio: "ignore" }).unref();
  } catch {
    // best-effort — ignore failures
  }
}

const studioCmd = defineCommand({
  meta: {
    name: "studio",
    description:
      "Start Eidentic Studio from eidentic.config.* or an agent directory.",
  },
  args: {
    config: {
      type: "positional",
      description: "Path to an Eidentic config file or agent directory (optional)",
      required: false,
    },
    port: {
      type: "string",
      description: "Port to listen on (default: 3535)",
      alias: ["p"],
    },
  },
  async run({ args }) {
    const explicitPath = args.config as string | undefined;
    const port = args.port ? parseInt(String(args.port), 10) : 3535;

    const project = resolveProject(process.cwd(), explicitPath);

    if (!project) {
      consola.error("No eidentic.config.* or agent/instructions.md found.");
      consola.info(
        "Create agent/instructions.md or eidentic.config.ts, or pass a path explicitly.",
      );
      process.exit(1);
    }

    let config;
    try {
      config = await loadProject(project);
    } catch (err) {
      consola.error(`Error loading config: ${(err as Error).message}`);
      process.exit(1);
    }

    // Auth-enabled Studio reads the token from the URL fragment so it is not sent in HTTP requests.
    if (config.auth && config.auth !== NoAuth) {
      consola.warn(`Studio run and admin auth are active. Open the studio URL with #key=<your-token> appended so the UI can authenticate (e.g. http://localhost:${port}/#key=<your-token>).`);
    }

    let serveStudio: (opts: unknown, serveOpts: { port: number }) => Promise<{ close(): void }>;
    try {
      const studioMod = await import("@eidentic/studio");
      serveStudio = studioMod.serveStudio as typeof serveStudio;
    } catch (err) {
      consola.error(`Failed to load @eidentic/studio: ${(err as Error).message}`);
      consola.info("Make sure @eidentic/studio is installed.");
      process.exit(1);
    }

    let handle: { close(): void };
    try {
      handle = await serveStudio(
        {
          agents: config.agents,
          auth: config.auth,
          // The CLI intentionally uses its single configured credential for both boundaries.
          // Studio itself no longer promotes run credentials to admin implicitly.
          adminAuth: config.auth,
          skillBanks: config.skillBanks,
        },
        { port },
      );
    } catch (err) {
      consola.error(`Failed to start studio: ${(err as Error).message}`);
      process.exit(1);
    }

    const url = `http://localhost:${port}`;
    consola.success(`Eidentic Studio → ${pc.cyan(url)}`);
    consola.info("Press Ctrl+C to stop.");

    openBrowser(url);

    process.on("SIGINT", () => {
      handle.close();
      process.exit(0);
    });
  },
});

// ---------------------------------------------------------------------------
// init command helpers
// ---------------------------------------------------------------------------

const PROVIDER_CHOICES = ["anthropic", "openai", "google", "deepseek", "mistral"] as const;
const OTHER_MODEL_SENTINEL = "__other__";

function detectPackageManager(cwd: string): string {
  if (existsSync(join(cwd, "pnpm-lock.yaml"))) return "pnpm";
  if (existsSync(join(cwd, "yarn.lock"))) return "yarn";
  if (existsSync(join(cwd, "bun.lockb"))) return "bun";
  return "npm";
}

function spawnInstall(pm: string, pkgs: string[], devPkgs: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const installArgs = pm === "npm" ? ["install"] : ["add"];
    const devFlag = pm === "npm" ? "--save-dev" : "-D";

    const child = spawn(pm, [...installArgs, ...pkgs], { stdio: "inherit" });
    child.on("close", (code) => {
      if (code !== 0) { reject(new Error(`${pm} install exited with code ${code}`)); return; }
      const devChild = spawn(pm, [...installArgs, devFlag, ...devPkgs], { stdio: "inherit" });
      devChild.on("close", (devCode) => {
        if (devCode !== 0) { reject(new Error(`${pm} install -D exited with code ${devCode}`)); return; }
        resolve();
      });
      devChild.on("error", reject);
    });
    child.on("error", reject);
  });
}

function printInitResult(created: string[], skipped: string[]): void {
  for (const f of created) {
    consola.log(`  ${pc.green("+")} ${f}`);
  }
  for (const f of skipped) {
    consola.log(`  ${pc.yellow("~")} ${f} ${pc.dim("(already exists, skipped)")}`);
  }
}

function printNextSteps(provider: Provider, apiKeyProvided: boolean): void {
  consola.log("");
  consola.success("Eidentic init complete.");
  consola.log("");
  consola.log(pc.bold("Next steps:"));
  let step = 1;
  if (!apiKeyProvided) {
    const envVar = INIT_PROVIDERS[provider].envVar;
    consola.log(`  ${pc.cyan(`${step})`)} Add your API key to ${pc.bold(".env")}: ${pc.dim(`${envVar}=<your-key>`)}`);
    step++;
  }
  consola.log(`  ${pc.cyan(`${step})`)} ${pc.cyan("npx eidentic dev")}  ${pc.dim("(or npx eidentic studio)")}`);
}

// ---------------------------------------------------------------------------
// init command
// ---------------------------------------------------------------------------

const initCmd = defineCommand({
  meta: {
    name: "init",
    description:
      "Scaffold a readable agent directory into the current project. Idempotent — never overwrites existing files.",
  },
  args: {
    provider: {
      type: "string",
      description: `Model provider (${PROVIDER_CHOICES.join(" | ")}). Default: anthropic`,
      alias: ["p"],
    },
    model: {
      type: "string",
      description: "Model ID to use (e.g. claude-sonnet-4-5). Defaults to the provider default.",
      alias: ["m"],
    },
    "api-key": {
      type: "string",
      description: "API key to write into .env (optional — can be added later).",
    },
    yes: {
      type: "boolean",
      description: "Skip interactive prompts; use flags/defaults. Does not install deps unless --install is also given.",
      alias: ["y"],
    },
    install: {
      type: "boolean",
      description: "Install dependencies after scaffolding (default: prompted interactively).",
    },
  },
  async run({ args }) {
    const isInteractive = process.stdin.isTTY && !args.yes;

    // -------------------------------------------------------------------------
    // Resolve provider
    // -------------------------------------------------------------------------
    let provider: Provider;
    {
      const rawProvider = args.provider as string | undefined;
      if (rawProvider) {
        if (!(PROVIDER_CHOICES as readonly string[]).includes(rawProvider)) {
          consola.error(`Unknown provider "${rawProvider}". Choose one of: ${PROVIDER_CHOICES.join(", ")}`);
          process.exit(1);
        }
        provider = rawProvider as Provider;
      } else if (isInteractive) {
        const { intro, select, isCancel, cancel } = await import("@clack/prompts");
        intro(pc.bold("eidentic init"));

        const providerAnswer = await select({
          message: "Model provider",
          options: [
            { value: "anthropic", label: "Anthropic", hint: "Claude — needs ANTHROPIC_API_KEY" },
            { value: "openai",    label: "OpenAI",    hint: "GPT — needs OPENAI_API_KEY" },
            { value: "google",    label: "Google",    hint: "Gemini — needs GOOGLE_GENERATIVE_AI_API_KEY" },
            { value: "deepseek",  label: "DeepSeek",  hint: "needs DEEPSEEK_API_KEY" },
            { value: "mistral",   label: "Mistral",   hint: "needs MISTRAL_API_KEY" },
          ],
        });
        if (isCancel(providerAnswer)) { cancel("Cancelled."); process.exit(0); }
        provider = providerAnswer as Provider;
      } else {
        provider = "anthropic";
      }
    }

    const providerMeta = INIT_PROVIDERS[provider];

    // -------------------------------------------------------------------------
    // Resolve model
    // -------------------------------------------------------------------------
    let model: string;
    {
      const rawModel = args.model as string | undefined;
      if (rawModel) {
        model = rawModel;
      } else if (isInteractive) {
        // We may or may not have already called intro; import clack fresh (safe to re-import)
        const { select, text, isCancel, cancel } = await import("@clack/prompts");
        const modelOptions = [
          ...providerMeta.models.map((m) => ({ value: m, label: m })),
          { value: OTHER_MODEL_SENTINEL, label: "Other (type manually)" },
        ];
        const modelAnswer = await select({ message: "Model", options: modelOptions });
        if (isCancel(modelAnswer)) { cancel("Cancelled."); process.exit(0); }
        if (modelAnswer === OTHER_MODEL_SENTINEL) {
          const customModel = await text({
            message: "Enter model ID",
            placeholder: providerMeta.modelId,
          });
          if (isCancel(customModel)) { cancel("Cancelled."); process.exit(0); }
          model = (customModel as string) || providerMeta.modelId;
        } else {
          model = modelAnswer as string;
        }
      } else {
        model = providerMeta.modelId;
      }
    }

    // -------------------------------------------------------------------------
    // Resolve API key
    // -------------------------------------------------------------------------
    let apiKey: string | undefined;
    {
      const rawKey = args["api-key"] as string | undefined;
      if (rawKey !== undefined) {
        apiKey = rawKey || undefined;
      } else if (isInteractive) {
        const { password, isCancel, cancel } = await import("@clack/prompts");
        const keyAnswer = await password({
          message: `API key for ${providerMeta.envVar} (leave blank to add later)`,
        });
        if (isCancel(keyAnswer)) { cancel("Cancelled."); process.exit(0); }
        apiKey = (keyAnswer as string) || undefined;
      }
    }

    // -------------------------------------------------------------------------
    // Resolve install
    // -------------------------------------------------------------------------
    let shouldInstall: boolean;
    {
      if (args.install !== undefined) {
        shouldInstall = Boolean(args.install);
      } else if (isInteractive) {
        const { confirm, isCancel, cancel } = await import("@clack/prompts");
        const installAnswer = await confirm({
          message: `Install dependencies now? (eidentic, ai, @ai-sdk/${provider}, zod)`,
          initialValue: true,
        });
        if (isCancel(installAnswer)) { cancel("Cancelled."); process.exit(0); }
        shouldInstall = Boolean(installAnswer);
      } else {
        // non-interactive / --yes with no --install: scaffold only
        shouldInstall = false;
      }
    }

    // -------------------------------------------------------------------------
    // Scaffold
    // -------------------------------------------------------------------------
    const cwd = process.cwd();

    if (!isInteractive) {
      consola.info(`Scaffolding Eidentic into ${pc.cyan(cwd)} (provider: ${pc.bold(provider)}, model: ${pc.bold(model)})`);
    }

    const { created, skipped } = initProject(cwd, { provider, model, apiKey, format: "directory" });
    printInitResult(created, skipped);

    // -------------------------------------------------------------------------
    // Install
    // -------------------------------------------------------------------------
    if (shouldInstall) {
      const pm = detectPackageManager(cwd);
      const prodPkgs = ["eidentic", "ai", `@ai-sdk/${provider}`, "zod"];
      const devPkgs = ["tsx", "typescript"];
      consola.info(`Running ${pm} install...`);
      try {
        await spawnInstall(pm, prodPkgs, devPkgs);
        consola.success("Dependencies installed.");
      } catch (err) {
        consola.warn(`Install failed: ${(err as Error).message}`);
        consola.info(`Run manually: ${pm} ${pm === "npm" ? "install" : "add"} ${prodPkgs.join(" ")}`);
      }
    }

    // -------------------------------------------------------------------------
    // Outro
    // -------------------------------------------------------------------------
    if (isInteractive) {
      const { outro } = await import("@clack/prompts");
      const steps: string[] = [];
      if (!apiKey) {
        steps.push(`Set your API key in .env: ${providerMeta.envVar}=<your-key>`);
      }
      if (!shouldInstall) {
        steps.push(`Install deps: ${detectPackageManager(cwd)} ${detectPackageManager(cwd) === "npm" ? "install" : "add"} eidentic ai @ai-sdk/${provider} zod`);
      }
      steps.push("Start dev server: npx eidentic dev");
      outro(
        [pc.bold("Done!"), "", ...steps.map((s, i) => `  ${pc.cyan(`${i + 1})`)} ${s}`)].join("\n"),
      );
    } else {
      printNextSteps(provider, Boolean(apiKey));
    }
  },
});

// ---------------------------------------------------------------------------
// eval command
// ---------------------------------------------------------------------------

const evalCmd = defineCommand({
  meta: {
    name: "eval",
    description:
      "Run an evaluation against a config/dataset file. Prints a summary and, with --ci, exits non-zero when the pass rate is below --threshold or when regressions are detected against --baseline.",
  },
  args: {
    config: {
      type: "positional",
      description: "Path to the eval config file (.ts/.js/.mjs) that exports { runner, dataset, scorers }.",
      required: true,
    },
    ci: {
      type: "boolean",
      description: "Exit non-zero when the pass rate is below --threshold or regressions are detected.",
      default: false,
    },
    threshold: {
      type: "string",
      description: "Pass-rate threshold in [0, 1] (default: 1). Only used with --ci.",
      alias: ["t"],
    },
    baseline: {
      type: "string",
      description: "Path to a baseline EvalReport JSON file. When provided, compares current run against the baseline and fails CI on any regression.",
    },
    "save-baseline": {
      type: "string",
      description: "Path where the current EvalReport will be saved as a JSON baseline snapshot.",
    },
    report: {
      type: "string",
      description: "Path where the Markdown eval report will be written (GitHub-comment-friendly).",
    },
  },
  async run({ args }) {
    const configPath = args.config as string;
    const ci = Boolean(args.ci);
    const threshold = args.threshold ? parseFloat(String(args.threshold)) : 1;
    const baselinePath = args.baseline as string | undefined;
    const saveBaselinePath = args["save-baseline"] as string | undefined;
    const reportPath = args.report as string | undefined;

    if (ci && (isNaN(threshold) || threshold < 0 || threshold > 1)) {
      consola.error(`--threshold must be a number in [0, 1], got: ${args.threshold}`);
      process.exit(1);
    }

    let result: Awaited<ReturnType<typeof runEval>>;
    try {
      result = await runEval(configPath, { ci, threshold, baselinePath, saveBaselinePath, reportPath });
    } catch (err) {
      const e = err as Error & { name?: string; actualPassRate?: number; requiredPassRate?: number };
      if (e.name === "EvalThresholdError") {
        consola.log(e.message);
        consola.error(
          `CI gate FAILED — pass rate ${(e.actualPassRate! * 100).toFixed(1)}% < required ${(e.requiredPassRate! * 100).toFixed(1)}%`,
        );
        process.exit(1);
      }
      if (e.name === "EvalRegressionError") {
        consola.log(e.message);
        consola.error("CI gate FAILED — regressions detected against baseline.");
        process.exit(1);
      }
      consola.error(`Eval failed: ${e.message}`);
      process.exit(1);
    }

    consola.log(result.summary);
    consola.log("");
    consola.success(`Pass rate: ${pc.bold((result.passRate * 100).toFixed(1) + "%")}`);

    if (result.compareResult) {
      const { regressions, improvements, unchanged, verdict } = result.compareResult;
      consola.log(`Baseline comparison: ${verdict === "pass" ? pc.green("no regressions") : pc.red(`${regressions.length} regression(s)`)}, ${improvements.length} improvement(s), ${unchanged} unchanged.`);
    }

    if (reportPath) {
      consola.success(`Markdown report written to ${pc.cyan(reportPath)}`);
    }

    if (saveBaselinePath) {
      consola.success(`Baseline snapshot saved to ${pc.cyan(saveBaselinePath)}`);
    }

    if (ci) {
      consola.success("CI gate passed.");
    }
  },
});

// ---------------------------------------------------------------------------
// add skill command
// ---------------------------------------------------------------------------

const addSkillCmd = defineCommand({
  meta: {
    name: "skill",
    description:
      "Install a skill into the project's local skills directory (skills/<name>/).",
  },
  args: {
    source: {
      type: "positional",
      description:
        "Path to a skill directory (must contain SKILL.md), or a skill name resolvable via --from.",
      required: true,
    },
    force: {
      type: "boolean",
      description: "Overwrite an existing skill with the same name.",
      alias: ["f"],
      default: false,
    },
    from: {
      type: "string",
      description:
        "Path to a local skills source directory (a directory of skill subdirs). " +
        "Used when <source> is a name rather than a path.",
    },
    cwd: {
      type: "string",
      description: "Project root to install into (default: current directory).",
    },
  },
  async run({ args }) {
    const source = args.source as string;
    const force = Boolean(args.force);
    const fromDir = args.from as string | undefined;
    const projectRoot = (args.cwd as string | undefined) ?? process.cwd();

    const resolver = fromDir ? makeDirResolver(fromDir) : undefined;

    let result: Awaited<ReturnType<typeof addSkill>>;
    try {
      result = await addSkill(source, { force, resolver, projectRoot });
    } catch (err) {
      consola.error((err as Error).message);
      process.exit(1);
    }

    if (result.replaced) {
      consola.success(
        `Skill ${pc.bold(result.name)} replaced at ${pc.cyan(result.installedAt)}`,
      );
    } else {
      consola.success(
        `Skill ${pc.bold(result.name)} installed at ${pc.cyan(result.installedAt)}`,
      );
    }
  },
});

// ---------------------------------------------------------------------------
// add component command
// ---------------------------------------------------------------------------

const addComponentCmd = defineCommand({
  meta: {
    name: "component",
    description: `Copy a pre-built UI component into the project (components/eidentic/<name>.tsx). Use --list to see all available components.`,
  },
  args: {
    name: {
      type: "positional",
      description: `Component name: ${COMPONENT_NAMES.join(" | ")}. Omit when using --list.`,
      required: false,
    },
    list: {
      type: "boolean",
      description: "List available components with descriptions and exit.",
      alias: ["l"],
      default: false,
    },
    overwrite: {
      type: "boolean",
      description: "Overwrite an existing component file (required if the file already exists).",
      alias: ["f"],
      default: false,
    },
    dir: {
      type: "string",
      description:
        "Target directory relative to --cwd (default: components/eidentic).",
    },
    cwd: {
      type: "string",
      description: "Project root to install into (default: current directory).",
    },
  },
  run({ args }) {
    // --list: print available components and exit.
    if (args.list) {
      consola.log(pc.bold("Available components:"));
      consola.log("");
      for (const name of COMPONENT_NAMES) {
        consola.log(`  ${pc.cyan(pc.bold(name))}`);
        consola.log(`    ${pc.dim(COMPONENT_DESCRIPTIONS[name])}`);
      }
      consola.log("");
      consola.info(`Install with: ${pc.cyan("eidentic add component <name>")}`);
      return;
    }

    const name = args.name as string | undefined;
    if (!name) {
      consola.error("Component name is required. Use --list to see available components.");
      consola.info(`Available components: ${pc.bold(COMPONENT_NAMES.join(", "))}`);
      process.exit(1);
    }

    const overwrite = Boolean(args.overwrite);
    const projectRoot = (args.cwd as string | undefined) ?? process.cwd();
    const targetDir = args.dir as string | undefined;

    let result: ReturnType<typeof addComponent>;
    try {
      result = addComponent(name, { overwrite, projectRoot, targetDir });
    } catch (err) {
      const msg = (err as Error).message;
      // Surface the available-names hint prominently.
      if (msg.includes("unknown component")) {
        consola.error(msg);
        consola.info(`Available components: ${pc.bold(COMPONENT_NAMES.join(", "))}`);
      } else if (msg.includes("already exists")) {
        consola.error(msg);
        consola.info(`Re-run with ${pc.bold("--overwrite")} to replace the existing file.`);
      } else {
        consola.error(msg);
      }
      process.exit(1);
    }

    if (result.replaced) {
      consola.success(
        `Component ${pc.bold(result.name)} replaced at ${pc.cyan(result.installedAt)}`,
      );
    } else {
      consola.success(
        `Component ${pc.bold(result.name)} installed at ${pc.cyan(result.installedAt)}`,
      );
    }
  },
});

const addCmd = defineCommand({
  meta: {
    name: "add",
    description: "Add resources to the current Eidentic project.",
  },
  subCommands: {
    skill: addSkillCmd,
    component: addComponentCmd,
  },
});

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

const main = defineCommand({
  meta: {
    name: "eidentic",
    version: PKG_VERSION,
    description: "Eidentic agent toolkit CLI",
  },
  subCommands: {
    doctor: doctorCmd,
    dev: devCmd,
    eval: evalCmd,
    studio: studioCmd,
    init: initCmd,
    add: addCmd,
  },
});

runMain(main);

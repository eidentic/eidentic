#!/usr/bin/env node
import { intro, outro, text, select, confirm, isCancel, cancel } from "@clack/prompts";
import pc from "picocolors";
import { resolve } from "node:path";
import { scaffold } from "./scaffold.js";
import type { Provider, Template } from "./scaffold.js";

// ---------------------------------------------------------------------------
// Parse argv
// ---------------------------------------------------------------------------

const rawArgv = process.argv.slice(2);
const argv = rawArgv.filter((a) => !a.startsWith("-"));
const dirArg = argv[0]; // may be undefined

// Support --template <name> or --template=<name>
function getFlagValue(flag: string): string | undefined {
  const eqForm = rawArgv.find((a) => a.startsWith(`--${flag}=`));
  if (eqForm) return eqForm.slice(`--${flag}=`.length);
  const idx = rawArgv.indexOf(`--${flag}`);
  const next = idx !== -1 ? rawArgv[idx + 1] : undefined;
  if (next !== undefined && !next.startsWith("-")) {
    return next;
  }
  return undefined;
}

const templateArg = getFlagValue("template") as Template | undefined;

// ---------------------------------------------------------------------------
// Non-TTY fast path: if stdin is not a TTY, use defaults without prompting.
// This prevents the process from hanging in CI / non-interactive pipes.
// ---------------------------------------------------------------------------

const isInteractive = process.stdin.isTTY && !dirArg;

async function run(): Promise<void> {
  intro(pc.bold("create-eidentic"));

  // --- Project directory ---
  let projectDir: string;
  if (dirArg) {
    projectDir = dirArg;
  } else if (isInteractive) {
    const answer = await text({
      message: "Project name",
      placeholder: "my-eidentic-app",
      defaultValue: "my-eidentic-app",
    });
    if (isCancel(answer)) {
      cancel("Cancelled.");
      process.exit(0);
    }
    projectDir = (answer as string) || "my-eidentic-app";
  } else {
    projectDir = "my-eidentic-app";
  }

  // --- Template ---
  let template: Template = templateArg ?? "default";
  if (isInteractive && !templateArg) {
    const templateAnswer = await select({
      message: "Template",
      options: [
        { value: "default", label: "Default", hint: "bare Node script — fast, zero framework" },
        { value: "nextjs-chat", label: "Next.js Chat", hint: "streaming chat UI — App Router + useChat" },
      ],
    });
    if (isCancel(templateAnswer)) {
      cancel("Cancelled.");
      process.exit(0);
    }
    template = templateAnswer as Template;
  }

  // --- Model provider ---
  let provider: Provider = "anthropic";
  if (isInteractive) {
    const providerAnswer = await select({
      message: "Model provider",
      options: [
        { value: "anthropic", label: "Anthropic", hint: "Claude — needs ANTHROPIC_API_KEY" },
        { value: "openai", label: "OpenAI", hint: "GPT-4o — needs OPENAI_API_KEY" },
        { value: "google", label: "Google", hint: "Gemini — needs GOOGLE_GENERATIVE_AI_API_KEY" },
        { value: "deepseek", label: "DeepSeek", hint: "needs DEEPSEEK_API_KEY" },
        { value: "mistral", label: "Mistral", hint: "needs MISTRAL_API_KEY" },
      ],
    });
    if (isCancel(providerAnswer)) {
      cancel("Cancelled.");
      process.exit(0);
    }
    provider = providerAnswer as Provider;
  }

  // --- Optional: vector memory (informational for now, default template only) ---
  if (isInteractive && template === "default") {
    const addVector = await confirm({
      message: "Add a vector memory adapter? (you can install one later)",
    });
    if (isCancel(addVector)) {
      cancel("Cancelled.");
      process.exit(0);
    }
    if (addVector) {
      // NOTE: future — prompt for lance/pgvector and add the dep to the generated package.json.
      // For now, surface the install commands in outro so the scaffold stays simple.
    }
  }

  // --- Scaffold ---
  const target = resolve(process.cwd(), projectDir);
  let files: string[];
  try {
    files = scaffold(target, { provider, template });
  } catch (err) {
    cancel(`Error: ${(err as Error).message}`);
    process.exit(1);
  }

  // Print created files
  for (const f of files) {
    process.stdout.write(`  ${pc.green("+")} ${f}\n`);
  }

  // --- Outro ---
  const envKey = {
    anthropic: "ANTHROPIC_API_KEY",
    openai: "OPENAI_API_KEY",
    google: "GOOGLE_GENERATIVE_AI_API_KEY",
    deepseek: "DEEPSEEK_API_KEY",
    mistral: "MISTRAL_API_KEY",
  }[provider];

  const isNextjs = template === "nextjs-chat";

  outro(
    [
      pc.bold("Next steps:"),
      `  ${pc.cyan(`cd ${projectDir}`)}`,
      `  ${pc.cyan("npm install")}`,
      isNextjs
        ? `  ${pc.cyan("cp .env.local.example .env.local")}   ${pc.dim(`# add your ${envKey}`)}`
        : `  ${pc.cyan("cp .env.example .env")}   ${pc.dim(`# add your ${envKey}`)}`,
      `  ${pc.cyan("npm run dev")}`,
    ].join("\n"),
  );
}

run().catch((err) => {
  cancel(`Unexpected error: ${(err as Error).message}`);
  process.exit(1);
});

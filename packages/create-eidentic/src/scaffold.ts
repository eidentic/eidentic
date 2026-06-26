/**
 * Core scaffolding logic for `create-eidentic`, kept separate from the CLI entry so it
 * is unit-testable without spawning a process. Zero runtime dependencies (Node built-ins only).
 */
import { mkdirSync, writeFileSync, existsSync, readdirSync } from "node:fs";
import { join, basename } from "node:path";

// ---------------------------------------------------------------------------
// Template type
// ---------------------------------------------------------------------------

export type Template = "default" | "nextjs-chat" | "bun-agent";

// ---------------------------------------------------------------------------
// Provider map
// ---------------------------------------------------------------------------

export type Provider = "anthropic" | "openai" | "google" | "deepseek" | "mistral";

interface ProviderMeta {
  /** npm package name for @ai-sdk/<provider> */
  package: string;
  /** v7-compatible npm version range for the provider package. */
  packageVersion: string;
  /** environment variable key */
  envVar: string;
  /** import line for src/agent.ts */
  importLine: string;
  /** model id string (first arg to the provider function) */
  modelId: string;
  /** provider function name imported from the sdk package */
  providerFn: string;
}

const PROVIDERS: Record<Provider, ProviderMeta> = {
  anthropic: {
    package: "@ai-sdk/anthropic",
    packageVersion: "^4.0.0",
    envVar: "ANTHROPIC_API_KEY",
    importLine: 'import { anthropic } from "@ai-sdk/anthropic";',
    modelId: "claude-sonnet-4-5",
    providerFn: "anthropic",
  },
  openai: {
    package: "@ai-sdk/openai",
    packageVersion: "^4.0.0",
    envVar: "OPENAI_API_KEY",
    importLine: 'import { openai } from "@ai-sdk/openai";',
    modelId: "gpt-4o",
    providerFn: "openai",
  },
  google: {
    package: "@ai-sdk/google",
    packageVersion: "^4.0.0",
    envVar: "GOOGLE_GENERATIVE_AI_API_KEY",
    importLine: 'import { google } from "@ai-sdk/google";',
    modelId: "gemini-2.5-pro",
    providerFn: "google",
  },
  deepseek: {
    package: "@ai-sdk/deepseek",
    packageVersion: "^3.0.0",
    envVar: "DEEPSEEK_API_KEY",
    importLine: 'import { deepseek } from "@ai-sdk/deepseek";',
    modelId: "deepseek-chat",
    providerFn: "deepseek",
  },
  mistral: {
    package: "@ai-sdk/mistral",
    packageVersion: "^4.0.0",
    envVar: "MISTRAL_API_KEY",
    importLine: 'import { mistral } from "@ai-sdk/mistral";',
    modelId: "mistral-large-latest",
    providerFn: "mistral",
  },
};

// ---------------------------------------------------------------------------
// ScaffoldOptions
// ---------------------------------------------------------------------------

export interface ScaffoldOptions {
  /** Project name written into package.json. Defaults to the target directory's basename. */
  name?: string;
  /** Model provider. Defaults to "anthropic". */
  provider?: Provider;
  /** Project template. Defaults to "default" (bare Node script). */
  template?: Template;
}

// ---------------------------------------------------------------------------
// File templates
// ---------------------------------------------------------------------------

const TSCONFIG = `{
  "compilerOptions": {
    "target": "ESNext",
    "module": "ESNext",
    "moduleResolution": "bundler",
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "verbatimModuleSyntax": true,
    "noEmit": true
  },
  "include": ["src"]
}
`;

const GITIGNORE = `node_modules
dist
*.sqlite
.env
`;

function envExample(providerMeta: ProviderMeta): string {
  return `# Get a key at https://console.anthropic.com (or your provider's dashboard)\n${providerMeta.envVar}=\n`;
}

function agentTs(providerMeta: ProviderMeta): string {
  return `import { Agent, AIModel, SqliteStore, createTool } from "eidentic";
${providerMeta.importLine}
import { z } from "zod";

// Persistent, event-sourced session store (durable resume comes for free).
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
  id: "my-agent",
  instructions: "You are a helpful assistant. Use tools when relevant, then answer concisely.",
  model: new AIModel(${providerMeta.providerFn}("${providerMeta.modelId}")), // needs ${providerMeta.envVar}
  tools: [getTime],
  store,
});

for await (const ev of agent.query("What time is it right now?", { sessionId: "session-1" })) {
  if (ev.type === "result") console.log("\\n" + String(ev.output));
}

await store.close();
`;
}

function packageJson(name: string, providerMeta: ProviderMeta): string {
  return (
    JSON.stringify(
      {
        name,
        version: "0.1.0",
        private: true,
        type: "module",
        scripts: { dev: "tsx src/agent.ts", typecheck: "tsc --noEmit" },
        dependencies: {
          eidentic: "latest",
          ai: "^7.0.2",
          [providerMeta.package]: providerMeta.packageVersion,
          zod: "^4.0.0",
        },
        devDependencies: { tsx: "^4.19.0", typescript: "^5.9.0" },
      },
      null,
      2,
    ) + "\n"
  );
}

function readme(name: string): string {
  return `# ${name}

A [Eidentic](https://github.com/eidentic/eidentic) agent project.

## Quickstart

\`\`\`bash
npm install
cp .env.example .env   # add your API key
npm run dev
\`\`\`

## Add optional power-ups

Eidentic's adapters are à la carte — install only what you use:

\`\`\`bash
npm i @eidentic/pgvector      # PostgreSQL vector memory
npm i @eidentic/lancedb       # embedded LanceDB vector memory
npm i @eidentic/transformers  # local embeddings / reranking
npm i @eidentic/mcp           # connect MCP servers
npm i @eidentic/e2b           # sandboxed code execution
npm i @eidentic/eval          # agent evaluation harness
\`\`\`
`;
}

// ---------------------------------------------------------------------------
// Next.js chat template
// ---------------------------------------------------------------------------

/**
 * Protocol choice: "ai-sdk-ui" (default withEidentic protocol) + useChat from @ai-sdk/react.
 * This is the recommended integration path — structured, typed, full AI SDK ecosystem compat.
 */

function nextjsChatRoute(providerMeta: ProviderMeta): string {
  return `import { Agent, AIModel } from "eidentic";
import { LibsqlStore } from "@eidentic/libsql";
import { withEidentic } from "@eidentic/nextjs";
${providerMeta.importLine}

// LibsqlStore is bundler-safe (no native addon). "file:eidentic.db" persists
// sessions to a local SQLite file via @libsql/client.
const store = new LibsqlStore("file:eidentic.db");
// Run migrations before the first request (top-level await is valid in Next.js
// App Router route modules, which are treated as ESM with async context).
await store.migrate();

const agent = new Agent({
  id: "chat-agent",
  instructions: "You are a helpful assistant.",
  model: new AIModel(${providerMeta.providerFn}("${providerMeta.modelId}")),
  store,
});

// withEidentic wraps the agent in a Next.js App Router POST handler.
// Default protocol is "ai-sdk-ui" — compatible with useChat from @ai-sdk/react.
export const POST = withEidentic(agent);

// Eidentic requires the Node.js runtime (crypto, LibSQL, etc.).
export const runtime = "nodejs";
`;
}

function nextjsChatPage(): string {
  return `"use client";

import { useChat } from "@ai-sdk/react";

export default function ChatPage() {
  const { messages, input, handleInputChange, handleSubmit, status } = useChat({
    api: "/api/chat",
  });

  return (
    <main className="flex flex-col items-center min-h-screen p-8 max-w-2xl mx-auto">
      <h1 className="text-2xl font-bold mb-6">Eidentic Chat</h1>

      {/* Message list */}
      <div className="flex flex-col gap-4 w-full flex-1 mb-6">
        {messages.map((m) => (
          <div
            key={m.id}
            className={\`rounded-lg px-4 py-2 text-sm max-w-[85%] whitespace-pre-wrap \${
              m.role === "user"
                ? "self-end bg-blue-600 text-white"
                : "self-start bg-gray-100 text-gray-900"
            }\`}
          >
            {m.parts
              .filter((p) => p.type === "text")
              .map((p, i) => (
                // @ts-expect-error — text part type is narrowed
                <span key={i}>{p.text}</span>
              ))}
          </div>
        ))}
        {status === "streaming" && (
          <div className="self-start text-gray-400 text-sm italic">Thinking…</div>
        )}
      </div>

      {/* Input form */}
      <form onSubmit={handleSubmit} className="flex gap-2 w-full">
        <input
          className="flex-1 rounded-lg border border-gray-300 px-4 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
          placeholder="Type a message…"
          value={input}
          onChange={handleInputChange}
          disabled={status === "streaming"}
        />
        <button
          type="submit"
          disabled={status === "streaming" || !input.trim()}
          className="rounded-lg bg-blue-600 text-white px-4 py-2 text-sm font-medium disabled:opacity-50 hover:bg-blue-700 transition-colors"
        >
          Send
        </button>
      </form>
    </main>
  );
}
`;
}

function nextjsConfig(): string {
  return `import { eidenticNextConfig } from "@eidentic/nextjs";
import type { NextConfig } from "next";

const nextConfig: NextConfig = {};

export default eidenticNextConfig(nextConfig);
`;
}

function nextjsPackageJson(name: string, providerMeta: ProviderMeta): string {
  return (
    JSON.stringify(
      {
        name,
        version: "0.1.0",
        private: true,
        scripts: {
          dev: "next dev",
          build: "next build",
          start: "next start",
          typecheck: "tsc --noEmit",
        },
        dependencies: {
          eidentic: "latest",
          "@eidentic/nextjs": "latest",
          "@eidentic/libsql": "latest",
          ai: "^7.0.2",
          "@ai-sdk/react": "^4.0.2",
          [providerMeta.package]: providerMeta.packageVersion,
          next: "^15.0.0",
          react: "^19.0.0",
          "react-dom": "^19.0.0",
        },
        devDependencies: {
          typescript: "^5.9.0",
          "@types/node": "^22.0.0",
          "@types/react": "^19.0.0",
          "@types/react-dom": "^19.0.0",
        },
      },
      null,
      2,
    ) + "\n"
  );
}

function nextjsEnvLocalExample(providerMeta: ProviderMeta): string {
  return `# Copy this file to .env.local and fill in your key.
# Get a key at: https://console.anthropic.com (or your provider's dashboard)
${providerMeta.envVar}=
`;
}

function nextjsReadme(name: string): string {
  return `# ${name}

A streaming AI chat app built with [Eidentic](https://github.com/eidentic/eidentic) + Next.js.

## Quickstart

\`\`\`bash
npm install
cp .env.local.example .env.local   # add your API key
npm run dev
\`\`\`

Open [http://localhost:3000](http://localhost:3000) to start chatting.

## How it works

- **\`app/api/chat/route.ts\`** — Eidentic agent wrapped with \`withEidentic\` from \`@eidentic/nextjs\`.
  Uses the default \`"ai-sdk-ui"\` protocol so the frontend can use \`useChat\` directly.
- **\`app/page.tsx\`** — Minimal chat UI using \`useChat\` from \`@ai-sdk/react\`.
- **\`next.config.ts\`** — \`eidenticNextConfig\` ensures native modules are not bundled by Webpack.
- **\`LibsqlStore("file:eidentic.db")\`** — Durable session store backed by a local SQLite file
  via \`@libsql/client\` (no native addon, works in serverless/edge Node runtimes).

## Add power-ups

\`\`\`bash
npm i @eidentic/pgvector      # PostgreSQL vector memory
npm i @eidentic/lancedb       # embedded LanceDB vector memory
npm i @eidentic/transformers  # local embeddings / reranking
npm i @eidentic/mcp           # connect MCP servers
npm i @eidentic/e2b           # sandboxed code execution
npm i @eidentic/eval          # agent evaluation harness
\`\`\`
`;
}

function nextjsGitignore(): string {
  return `node_modules
.next
out
*.db
*.sqlite
.env.local
.env
`;
}

function nextjsTsConfig(): string {
  return `{
  "compilerOptions": {
    "target": "ESNext",
    "lib": ["dom", "dom.iterable", "esnext"],
    "module": "ESNext",
    "moduleResolution": "bundler",
    "allowJs": true,
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "verbatimModuleSyntax": true,
    "noEmit": true,
    "jsx": "preserve",
    "incremental": true,
    "plugins": [{ "name": "next" }],
    "paths": { "@/*": ["./*"] }
  },
  "include": ["next-env.d.ts", "**/*.ts", "**/*.tsx", ".next/types/**/*.ts"],
  "exclude": ["node_modules"]
}
`;
}

// ---------------------------------------------------------------------------
// Bun agent template
// ---------------------------------------------------------------------------

/**
 * Bun-native HTTP server entry using Hono (same framework as @eidentic/server),
 * served directly with Bun.serve via @hono/node-server/bun.
 * Uses LibsqlStore (pure-JS, works under Bun without native addons).
 */
function bunAgentServer(providerMeta: ProviderMeta): string {
  return `import { Agent, AIModel } from "eidentic";
import { LibsqlStore } from "@eidentic/libsql";
import { createServer } from "@eidentic/server";
${providerMeta.importLine}

// LibsqlStore is pure-JS and bundler-safe — works under Bun without native addons.
const store = new LibsqlStore("file:eidentic.db");
await store.migrate();

const agent = new Agent({
  id: "my-agent",
  instructions: "You are a helpful assistant.",
  model: new AIModel(${providerMeta.providerFn}("${providerMeta.modelId}")), // needs ${providerMeta.envVar}
  store,
});

// createServer returns a Hono app — Bun can serve it directly.
const app = createServer({ agents: { "my-agent": agent } });

// Bun.serve accepts any fetch-compatible handler (Hono implements the interface).
const server = Bun.serve({
  port: Number(process.env["PORT"] ?? 3000),
  fetch: app.fetch,
});

console.log(\`Eidentic agent running at http://localhost:\${server.port}\`);
console.log("POST /v1/agents/my-agent/query  — SSE stream");
`;
}

function bunAgentPackageJson(name: string, providerMeta: ProviderMeta): string {
  return (
    JSON.stringify(
      {
        name,
        version: "0.1.0",
        private: true,
        type: "module",
        scripts: {
          dev: "bun run --watch src/server.ts",
          start: "bun run src/server.ts",
          typecheck: "tsc --noEmit",
        },
        dependencies: {
          eidentic: "latest",
          "@eidentic/server": "latest",
          "@eidentic/libsql": "latest",
          ai: "^7.0.2",
          [providerMeta.package]: providerMeta.packageVersion,
          hono: "^4.0.0",
        },
        devDependencies: {
          "bun-types": "latest",
          typescript: "^5.9.0",
        },
      },
      null,
      2,
    ) + "\n"
  );
}

function bunfig(): string {
  return `# Bun configuration
[install]
# Use the lockfile from the project root
production = false
`;
}

function bunAgentTsConfig(): string {
  return `{
  "compilerOptions": {
    "target": "ESNext",
    "lib": ["ESNext"],
    "module": "ESNext",
    "moduleResolution": "bundler",
    "types": ["bun-types"],
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "verbatimModuleSyntax": true,
    "noEmit": true
  },
  "include": ["src"]
}
`;
}

function bunAgentEnvExample(providerMeta: ProviderMeta): string {
  return `# Copy this file to .env and fill in your key.
# Get a key at: https://console.anthropic.com (or your provider's dashboard)
${providerMeta.envVar}=
PORT=3000
`;
}

function bunAgentGitignore(): string {
  return `node_modules
*.db
*.sqlite
.env
`;
}

function bunAgentReadme(name: string): string {
  return `# ${name}

A [Eidentic](https://github.com/eidentic/eidentic) agent server running natively on Bun.

## Quickstart

\`\`\`bash
bun install
cp .env.example .env   # add your API key
bun run dev
\`\`\`

The server starts at http://localhost:3000.

## Query the agent

\`\`\`bash
curl -N -X POST http://localhost:3000/v1/agents/my-agent/query \\
  -H "Content-Type: application/json" \\
  -d '{"input":"Hello!","sessionId":"demo"}'
\`\`\`

## How it works

- **\`src/server.ts\`** — Eidentic agent wrapped with \`createServer\` from \`@eidentic/server\`
  (returns a Hono app), served via \`Bun.serve\`.
- **\`LibsqlStore("file:eidentic.db")\`** — Durable session store backed by a local SQLite file
  via \`@libsql/client\` (pure-JS, no native addon).
- **Hot-reload** — \`bun run --watch\` restarts on file changes.

## Add power-ups

\`\`\`bash
bun add @eidentic/pgvector      # PostgreSQL vector memory
bun add @eidentic/lancedb       # embedded LanceDB vector memory
bun add @eidentic/transformers  # local embeddings / reranking
bun add @eidentic/mcp           # connect MCP servers
bun add @eidentic/e2b           # sandboxed code execution
bun add @eidentic/eval          # agent evaluation harness
\`\`\`
`;
}

// ---------------------------------------------------------------------------
// scaffold
// ---------------------------------------------------------------------------

/**
 * Write the project template into `targetDir`. Returns the list of relative paths written.
 * Throws if the target exists and is non-empty (never clobbers existing files).
 */
export function scaffold(targetDir: string, opts: ScaffoldOptions = {}): string[] {
  if (existsSync(targetDir) && readdirSync(targetDir).length > 0) {
    throw new Error(`Target directory "${targetDir}" already exists and is not empty.`);
  }
  const projectName = opts.name ?? (basename(targetDir) || "my-eidentic-app");
  const provider = opts.provider ?? "anthropic";
  const providerMeta = PROVIDERS[provider];
  const template = opts.template ?? "default";

  if (template === "bun-agent") {
    mkdirSync(join(targetDir, "src"), { recursive: true });

    const files: Record<string, string> = {
      "package.json": bunAgentPackageJson(projectName, providerMeta),
      "tsconfig.json": bunAgentTsConfig(),
      "bunfig.toml": bunfig(),
      "src/server.ts": bunAgentServer(providerMeta),
      ".env.example": bunAgentEnvExample(providerMeta),
      ".gitignore": bunAgentGitignore(),
      "README.md": bunAgentReadme(projectName),
    };

    const written: string[] = [];
    for (const [rel, content] of Object.entries(files)) {
      writeFileSync(join(targetDir, rel), content);
      written.push(rel);
    }
    return written;
  }

  if (template === "nextjs-chat") {
    mkdirSync(join(targetDir, "app", "api", "chat"), { recursive: true });

    const files: Record<string, string> = {
      "package.json": nextjsPackageJson(projectName, providerMeta),
      "tsconfig.json": nextjsTsConfig(),
      "next.config.ts": nextjsConfig(),
      "app/api/chat/route.ts": nextjsChatRoute(providerMeta),
      "app/page.tsx": nextjsChatPage(),
      ".env.local.example": nextjsEnvLocalExample(providerMeta),
      ".gitignore": nextjsGitignore(),
      "README.md": nextjsReadme(projectName),
    };

    const written: string[] = [];
    for (const [rel, content] of Object.entries(files)) {
      writeFileSync(join(targetDir, rel), content);
      written.push(rel);
    }
    return written;
  }

  // default template
  mkdirSync(join(targetDir, "src"), { recursive: true });

  const files: Record<string, string> = {
    "package.json": packageJson(projectName, providerMeta),
    "tsconfig.json": TSCONFIG,
    "src/agent.ts": agentTs(providerMeta),
    ".env.example": envExample(providerMeta),
    ".gitignore": GITIGNORE,
    "README.md": readme(projectName),
  };

  const written: string[] = [];
  for (const [rel, content] of Object.entries(files)) {
    writeFileSync(join(targetDir, rel), content);
    written.push(rel);
  }
  return written;
}

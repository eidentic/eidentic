#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const args = process.argv.slice(2);
const command = args[0] ?? "check";
const flags = new Set(args.slice(1));

function run(cmd, cmdArgs, opts = {}) {
  const printable = [cmd, ...cmdArgs].join(" ");
  console.log(`\n$ ${printable}`);
  const result = spawnSync(cmd, cmdArgs, {
    stdio: "inherit",
    shell: process.platform === "win32",
    ...opts,
  });
  if (result.status !== 0) {
    process.exit(result.status ?? 1);
  }
}

function read(cmd, cmdArgs) {
  const result = spawnSync(cmd, cmdArgs, {
    encoding: "utf8",
    shell: process.platform === "win32",
  });
  if (result.status !== 0) return "";
  return result.stdout.trim();
}

function ensureCleanWorktree() {
  const status = read("git", ["status", "--porcelain"]);
  if (status.length > 0) {
    console.error("Release versioning requires a clean worktree.");
    console.error(status);
    process.exit(1);
  }
}

function hasPendingChangeset() {
  return readdirSync(join(process.cwd(), ".changeset")).some(
    (name) => name.endsWith(".md") && name !== "README.md",
  );
}

function ensurePendingChangeset() {
  if (!hasPendingChangeset()) {
    console.error("No pending changeset found. Run `pnpm changeset` before versioning.");
    process.exit(1);
  }
}

function ensurePublishContext() {
  if (flags.has("--allow-local")) return;

  if (process.env.CI !== "true") {
    console.error("Refusing to publish outside CI. Pass --allow-local only for emergency dry infrastructure tests.");
    process.exit(1);
  }

  if (process.env.GITHUB_ACTIONS === "true" && process.env.GITHUB_REF_TYPE !== "tag") {
    console.error("Refusing to publish from GitHub Actions unless the workflow was triggered by a tag.");
    process.exit(1);
  }
}

function packWorkspacePackages() {
  const destination = mkdtempSync(join(tmpdir(), "eidentic-pack-"));
  try {
    run("pnpm", [
      "--filter",
      "./packages/**",
      "exec",
      "pnpm",
      "pack",
      "--pack-destination",
      destination,
    ]);
  } finally {
    rmSync(destination, { recursive: true, force: true });
  }
}

function qualityGate({ skipInstall = false, publishDryRun = false } = {}) {
  if (!skipInstall) run("pnpm", ["install", "--frozen-lockfile"]);
  run("pnpm", ["run", "build"]);
  run("pnpm", ["test"]);
  run("pnpm", ["run", "typecheck"]);
  run("pnpm", ["run", "check:readme"]);
  run("pnpm", ["audit", "--audit-level", "low"]);
  if (publishDryRun) packWorkspacePackages();
}

switch (command) {
  case "check":
    qualityGate({
      skipInstall: flags.has("--skip-install"),
      publishDryRun: flags.has("--pack"),
    });
    break;

  case "dry-run":
    qualityGate({
      skipInstall: flags.has("--skip-install"),
      publishDryRun: true,
    });
    break;

  case "version":
    ensureCleanWorktree();
    ensurePendingChangeset();
    run("pnpm", ["changeset", "version"]);
    run("pnpm", ["install", "--lockfile-only"]);
    qualityGate({ skipInstall: true });
    console.log("\nVersion files are ready. Commit them, tag the release, then push with --follow-tags.");
    break;

  case "publish":
    ensurePublishContext();
    qualityGate();
    run("pnpm", ["changeset", "publish"]);
    break;

  default:
    console.error(`Unknown release command: ${command}`);
    console.error("Usage: node scripts/release.mjs <check|dry-run|version|publish>");
    process.exit(1);
}

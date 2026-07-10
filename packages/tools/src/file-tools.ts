import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { open } from "node:fs/promises";
import { z } from "zod";
import { createTool, type Tool } from "@eidentic/core";
import { atomicWriteConfined, confinedResolve, confineWriteTarget } from "./confine.js";
import { matchGlob, walkDir } from "./glob.js";

/** Hard caps so a tool result can never blow up the context window. */
const MAX_READ_BYTES = 256 * 1024;   // 256 KB per read_file
const MAX_GREP_MATCHES = 500;        // bounded grep output
const MAX_GLOB_RESULTS = 1000;       // bounded glob output
const MAX_PATTERN_LEN = 1024;        // reject oversized grep/glob patterns (ReDoS defense)
const MAX_GREP_FILE_BYTES = 1024 * 1024;
const MAX_GREP_TOTAL_BYTES = 8 * 1024 * 1024;
const MAX_GREP_FILES = 10_000;
const MAX_GREP_REGEX_MS = 2_000;
const MAX_GREP_REGEX_FILE_MS = 250;

const sha256 = (s: string): string => createHash("sha256").update(s).digest("hex");

function assertRegexSafe(pattern: string): void {
  // JavaScript's backtracking regexp engine has no timeout/cancellation hook. Reject constructs
  // with well-known super-linear behavior. This is deliberately conservative; callers needing
  // the full regexp language should use a sandboxed RE2/ripgrep adapter.
  const nestedQuantifier = /(^|[^\\])\((?:\\.|[^()])*[+*}](?:\\.|[^()])*\)\s*(?:[+*{])/;
  const quantifiedAlternation = /(^|[^\\])\((?:\\.|[^()])*\|(?:\\.|[^()])*\)\s*(?:[+*{])/;
  const backreference = /(^|[^\\])\\[1-9]/;
  if (nestedQuantifier.test(pattern) || quantifiedAlternation.test(pattern) || backreference.test(pattern)) {
    throw new Error("grep: unsafe regular expression rejected (catastrophic backtracking/ReDoS risk)");
  }
}

const REGEX_WORKER_SOURCE = String.raw`
  const { parentPort } = require("node:worker_threads");
  parentPort.on("message", ({ id, pattern, lines, maxMatches }) => {
    try {
      const regex = new RegExp(pattern);
      const matches = [];
      for (let i = 0; i < lines.length && matches.length < maxMatches; i++) {
        if (regex.test(lines[i])) matches.push(i);
      }
      parentPort.postMessage({ id, matches });
    } catch (error) {
      parentPort.postMessage({ id, error: error instanceof Error ? error.message : String(error) });
    }
  });
`;

async function createRegexRunner(pattern: string): Promise<{
  match(lines: string[], maxMatches: number, timeoutMs: number): Promise<number[]>;
  close(): Promise<void>;
}> {
  const { Worker } = await import("node:worker_threads");
  const worker = new Worker(REGEX_WORKER_SOURCE, { eval: true });
  let nextId = 0;
  let closed = false;

  return {
    match(lines, maxMatches, timeoutMs) {
      if (closed) return Promise.reject(new Error("grep: regex worker is closed"));
      const id = ++nextId;
      return new Promise<number[]>((resolve, reject) => {
        const cleanup = () => {
          clearTimeout(timer);
          worker.off("message", onMessage);
          worker.off("error", onError);
        };
        const onMessage = (message: { id?: number; matches?: number[]; error?: string }) => {
          if (message.id !== id) return;
          cleanup();
          if (message.error) reject(new Error(`grep: regex evaluation failed: ${message.error}`));
          else resolve(message.matches ?? []);
        };
        const onError = (error: Error) => {
          cleanup();
          reject(error);
        };
        const timer = setTimeout(() => {
          cleanup();
          closed = true;
          void worker.terminate();
          reject(new Error("grep: regex execution timed out (possible ReDoS pattern)"));
        }, timeoutMs);
        worker.on("message", onMessage);
        worker.on("error", onError);
        worker.postMessage({ id, pattern, lines, maxMatches });
      });
    },
    async close() {
      if (closed) return;
      closed = true;
      await worker.terminate();
    },
  };
}

export interface FileToolsOptions {
  /** Workspace root. Every path is resolved under here and CANNOT escape it (§5.6). */
  root: string;
}

/** The 5 path-confined file tools (§5.8). read/glob/grep are read-only; write/edit are destructive. */
export function fileTools(opts: FileToolsOptions): Tool[] {
  const { root } = opts;

  const readFileTool = createTool({
    id: "read_file",
    description: "Read a UTF-8 text file under the workspace root. Large files are truncated.",
    inputSchema: z.object({ path: z.string().describe("Path relative to the workspace root") }),
    sideEffect: "read-only",
    execute: async ({ input }) => {
      const resolved = await confinedResolve(root, input.path);
      if (resolved === null) throw new Error(`read_file: not found: ${input.path}`);
      let handle;
      try {
        handle = await open(resolved, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ELOOP") {
          throw new Error(`read_file: symlink changed during read: ${input.path}`);
        }
        throw error;
      }
      try {
        const entry = await handle.stat();
        if (!entry.isFile()) throw new Error(`read_file: not a regular file: ${input.path}`);
        const buffer = Buffer.allocUnsafe(MAX_READ_BYTES + 1);
        const { bytesRead } = await handle.read(buffer, 0, buffer.byteLength, 0);
        const truncated = bytesRead > MAX_READ_BYTES || entry.size > MAX_READ_BYTES;
        const content = buffer.subarray(0, Math.min(bytesRead, MAX_READ_BYTES)).toString("utf8");
        return { path: input.path, content, truncated };
      } finally {
        await handle.close();
      }
    },
  });

  const writeFileTool = createTool({
    id: "write_file",
    description: "Write (create or overwrite) a UTF-8 text file under the workspace root, creating parent directories.",
    inputSchema: z.object({
      path: z.string().describe("Path relative to the workspace root"),
      content: z.string().describe("Full file content"),
    }),
    sideEffect: "destructive",
    idempotencyKey: (input) => `write_file:${input.path}:${sha256(input.content)}`,
    execute: async ({ input }) => {
      await atomicWriteConfined(root, input.path, input.content);
      return { path: input.path, bytesWritten: Buffer.byteLength(input.content, "utf8") };
    },
  });

  const editFileTool = createTool({
    id: "edit_file",
    description: "Replace the unique occurrence of oldString with newString in a file under the workspace root.",
    inputSchema: z.object({
      path: z.string().describe("Path relative to the workspace root"),
      oldString: z.string().describe("Exact text to replace (must occur exactly once)"),
      newString: z.string().describe("Replacement text"),
    }),
    sideEffect: "destructive",
    idempotencyKey: (input) =>
      `edit_file:${input.path}:${sha256(input.oldString)}:${sha256(input.newString)}`,
    execute: async ({ input }) => {
      const target = await confineWriteTarget(root, input.path);
      let handle;
      try {
        handle = await open(target, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") {
          throw new Error(`edit_file: not found: ${input.path}`);
        }
        throw error;
      }
      const fileStat = await handle.stat();
      if (!fileStat.isFile()) {
        await handle.close();
        throw new Error(`edit_file: not a regular file: ${input.path}`);
      }
      const original = await handle.readFile("utf8").finally(() => handle.close());
      const first = original.indexOf(input.oldString);
      if (first === -1) throw new Error(`edit_file: oldString not found in ${input.path}`);
      const second = original.indexOf(input.oldString, first + input.oldString.length);
      if (second !== -1) {
        throw new Error(`edit_file: oldString is ambiguous (occurs more than once) in ${input.path}`);
      }
      const updated =
        original.slice(0, first) + input.newString + original.slice(first + input.oldString.length);
      await atomicWriteConfined(root, input.path, updated);
      return { path: input.path, replaced: true };
    },
  });

  const globTool = createTool({
    id: "glob",
    description: "List files under the workspace root matching a glob (* and ** and ?). Returns relative paths.",
    inputSchema: z.object({ pattern: z.string().describe("Glob pattern, e.g. **/*.ts") }),
    sideEffect: "read-only",
    execute: async ({ input }) => {
      const all = await matchGlob(root, input.pattern);
      const matches = all.slice(0, MAX_GLOB_RESULTS);
      return { matches, truncated: all.length > matches.length };
    },
  });

  const grepTool = createTool({
    id: "grep",
    description: "Search files under the workspace root (or a subpath) for a JS regular expression. Returns matching lines.",
    inputSchema: z.object({
      pattern: z.string().describe("JavaScript regular expression"),
      path: z.string().optional().describe("Optional subdirectory under the root to limit the search"),
    }),
    sideEffect: "read-only",
    execute: async ({ input }) => {
      if (input.pattern.length > MAX_PATTERN_LEN) {
        throw new Error(`grep: pattern too long (max ${MAX_PATTERN_LEN} chars) — full ReDoS mitigation is not possible for a regex tool; this cap is a pragmatic defense`);
      }
      assertRegexSafe(input.pattern);
      try {
        new RegExp(input.pattern);
      } catch (e) {
        throw new Error(`grep: invalid regex: ${e instanceof Error ? e.message : String(e)}`);
      }
      // Confine the search base. Default to root; a provided path must stay inside.
      let base = root;
      if (input.path !== undefined && input.path !== "" && input.path !== ".") {
        const resolved = await confinedResolve(root, input.path);
        if (resolved === null) throw new Error(`grep: path not found: ${input.path}`);
        base = resolved;
      }
      const walked = await walkDir(base, "", MAX_GREP_FILES + 1);
      const files = walked.slice(0, MAX_GREP_FILES);
      const results: Array<{ file: string; line: number; text: string }> = [];
      let scannedBytes = 0;
      let scanTruncated = walked.length > files.length;
      const regexRunner = await createRegexRunner(input.pattern);
      const regexDeadline = Date.now() + MAX_GREP_REGEX_MS;
      try {
        for (const rel of files) {
          if (results.length >= MAX_GREP_MATCHES) break;
          const path = base === root ? `${root}/${rel}` : `${base}/${rel}`;
          let handle;
          try {
            handle = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
          } catch {
            continue; // unreadable / binary — skip
          }
          let content: string;
          try {
            const fileStat = await handle.stat();
            if (!fileStat.isFile() || fileStat.size > MAX_GREP_FILE_BYTES ||
                scannedBytes + fileStat.size > MAX_GREP_TOTAL_BYTES) {
              scanTruncated = true;
              continue;
            }
            scannedBytes += fileStat.size;
            content = await handle.readFile("utf8");
          } finally {
            await handle.close();
          }
          const lines = content.split("\n");
          const remainingMs = Math.min(MAX_GREP_REGEX_FILE_MS, regexDeadline - Date.now());
          if (remainingMs <= 0) {
            throw new Error("grep: regex execution timed out (scan budget exhausted)");
          }
          const matchingLines = await regexRunner.match(
            lines,
            MAX_GREP_MATCHES - results.length,
            remainingMs,
          );
          for (const i of matchingLines) {
            results.push({ file: rel, line: i + 1, text: lines[i]!.slice(0, 1000) });
            if (results.length >= MAX_GREP_MATCHES) break;
          }
        }
      } finally {
        await regexRunner.close();
      }
      return {
        matches: results,
        truncated: scanTruncated || results.length >= MAX_GREP_MATCHES,
      };
    },
  });

  return [readFileTool, writeFileTool, editFileTool, globTool, grepTool];
}

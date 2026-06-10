import { createHash } from "node:crypto";
import { readFile, writeFile, mkdir, stat } from "node:fs/promises";
import { dirname } from "node:path";
import { z } from "zod";
import { createTool, type Tool } from "@eidentic/core";
import { confinedResolve, confineWriteTarget } from "./confine.js";
import { matchGlob, walkDir } from "./glob.js";

/** Hard caps so a tool result can never blow up the context window. */
const MAX_READ_BYTES = 256 * 1024;   // 256 KB per read_file
const MAX_GREP_MATCHES = 500;        // bounded grep output
const MAX_GLOB_RESULTS = 1000;       // bounded glob output
const MAX_PATTERN_LEN = 1024;        // reject oversized grep/glob patterns (ReDoS defense)

const sha256 = (s: string): string => createHash("sha256").update(s).digest("hex");

function truncate(text: string, maxBytes: number): { text: string; truncated: boolean } {
  const buf = Buffer.from(text, "utf8");
  if (buf.length <= maxBytes) return { text, truncated: false };
  return { text: buf.subarray(0, maxBytes).toString("utf8"), truncated: true };
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
      const st = await stat(resolved);
      if (!st.isFile()) throw new Error(`read_file: not a regular file: ${input.path}`);
      const raw = await readFile(resolved, "utf8");
      const { text, truncated } = truncate(raw, MAX_READ_BYTES);
      return { path: input.path, content: text, truncated };
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
      const target = await confineWriteTarget(root, input.path);
      await mkdir(dirname(target), { recursive: true });
      await writeFile(target, input.content, "utf8");
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
      const resolved = await confinedResolve(root, input.path);
      if (resolved === null) throw new Error(`edit_file: not found: ${input.path}`);
      const original = await readFile(resolved, "utf8");
      const first = original.indexOf(input.oldString);
      if (first === -1) throw new Error(`edit_file: oldString not found in ${input.path}`);
      const second = original.indexOf(input.oldString, first + input.oldString.length);
      if (second !== -1) {
        throw new Error(`edit_file: oldString is ambiguous (occurs more than once) in ${input.path}`);
      }
      const updated =
        original.slice(0, first) + input.newString + original.slice(first + input.oldString.length);
      await writeFile(resolved, updated, "utf8");
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
      let re: RegExp;
      try {
        re = new RegExp(input.pattern);
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
      const files = await walkDir(base);
      const results: Array<{ file: string; line: number; text: string }> = [];
      for (const rel of files) {
        if (results.length >= MAX_GREP_MATCHES) break;
        let content: string;
        try {
          content = await readFile(base === root ? `${root}/${rel}` : `${base}/${rel}`, "utf8");
        } catch {
          continue; // unreadable / binary — skip
        }
        const lines = content.split("\n");
        for (let i = 0; i < lines.length; i++) {
          if (re.test(lines[i]!)) {
            results.push({ file: rel, line: i + 1, text: lines[i]!.slice(0, 1000) });
            if (results.length >= MAX_GREP_MATCHES) break;
          }
        }
      }
      return { matches: results, truncated: results.length >= MAX_GREP_MATCHES };
    },
  });

  return [readFileTool, writeFileTool, editFileTool, globTool, grepTool];
}

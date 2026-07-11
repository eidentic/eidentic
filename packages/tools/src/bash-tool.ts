import { z } from "zod";
import { createTool, type Tool } from "@eidentic/core";
import type { SandboxPort } from "@eidentic/types";

export interface BashToolOptions {
  /** Wall-clock budget per command, in ms. Passed straight to SandboxPort.run. */
  timeoutMs?: number;
}

/**
 * The sealed shell tool (§5.6, §5.8). `bash` executes ONLY via the injected `SandboxPort` —
 * NEVER the host process. With a `NoopSandbox` it refuses (secure default, §10.7) and the
 * refusal surfaces as a tool error.
 *
 * `sideEffect: "destructive"` and intentionally NO `idempotencyKey`: arbitrary shell is
 * non-idempotent, so under durable runs `bash` is `durableUnprotected` (the framework's
 * existing destructive-without-key warning applies — re-runs on resume are possible).
 */
export function bashTool(sandbox: SandboxPort, opts?: BashToolOptions): Tool {
  return createTool({
    id: "bash",
    description:
      "Run a bash command in the configured sandbox and return its stdout, stderr and exit code. " +
      "Executes off the host process; refuses if no real sandbox is configured.",
    inputSchema: z.object({ command: z.string().describe("The bash command line to execute") }),
    sideEffect: "destructive",
    execute: async ({ input, ctx }) => {
      const res = await sandbox.run(input.command, {
        language: "bash",
        ...(opts?.timeoutMs !== undefined ? { timeoutMs: opts.timeoutMs } : {}),
        ...(ctx?.signal !== undefined ? { signal: ctx.signal } : {}),
      });
      // NoopSandbox (and other refusals) return exitCode 1 + a populated `error` with empty streams.
      if (res.exitCode !== 0 && res.error !== undefined && res.stdout === "" && res.stderr === "") {
        throw new Error(`bash refused or failed: ${res.error}`);
      }
      return {
        stdout: res.stdout,
        stderr: res.stderr,
        exitCode: res.exitCode,
        ...(res.error !== undefined ? { error: res.error } : {}),
      };
    },
  });
}

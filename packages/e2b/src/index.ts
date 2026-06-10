import type { SandboxPort, SandboxResult, SandboxRunOptions } from "@eidentic/types";

/** Error object E2B returns when execution throws (subset of `@e2b/code-interpreter`'s `ExecutionError`). */
export interface E2BExecutionError {
  name: string;
  value: string;
  traceback: string;
}

/** Result of `runCode` (subset of `@e2b/code-interpreter`'s `Execution`). E2B has NO numeric exit code. */
export interface E2BExecution {
  logs: { stdout: string[]; stderr: string[] };
  error?: E2BExecutionError;
}

/** A live sandbox handle (subset of `@e2b/code-interpreter`'s `Sandbox` instance). */
export interface E2BSandboxHandle {
  runCode(code: string, opts?: { language?: string; timeoutMs?: number; envs?: Record<string, string> }): Promise<E2BExecution>;
  /** NOTE: real @e2b/code-interpreter@^2.6.0 kill() returns Promise<void>. */
  kill(): Promise<void>;
}

/**
 * Structural subset of the `@e2b/code-interpreter` `Sandbox` STATIC factory the adapter uses.
 * Pass the real class as `{ client: Sandbox }`, or an in-memory fake of this shape for tests.
 */
export interface E2BLike {
  create(opts?: { apiKey?: string; timeoutMs?: number }): Promise<E2BSandboxHandle>;
}

/**
 * `SandboxPort` over E2B Firecracker microVMs (§10.5, default cloud adapter). Creates a fresh
 * sandbox per `run()` and always kills it afterward (no pooling in this version). Maps the E2B
 * `Execution` to a `SandboxResult`: stdout/stderr arrays are joined with newlines; since E2B has no
 * numeric exit code, `exitCode` is derived from `error` presence.
 */
export class E2BSandbox implements SandboxPort {
  private constructor(
    private readonly client: E2BLike,
    private readonly defaultTimeoutMs: number | undefined,
    private readonly apiKey: string | undefined,
  ) {}

  static async create(opts: { client: E2BLike; apiKey?: string; defaultTimeoutMs?: number }): Promise<E2BSandbox> {
    return new E2BSandbox(opts.client, opts.defaultTimeoutMs, opts.apiKey);
  }

  async run(code: string, opts?: SandboxRunOptions): Promise<SandboxResult> {
    const timeoutMs = opts?.timeoutMs ?? this.defaultTimeoutMs;
    const signal = opts?.signal;

    // If already aborted before we start, throw immediately (fast-path).
    if (signal?.aborted) {
      throw new DOMException("sandbox run aborted", "AbortError");
    }

    // Set up the abort promise BEFORE awaiting create() so that a signal fired during creation is
    // also caught. The sandbox handle is initially null; the listener updates it once create() returns.
    let sandboxHandle: E2BSandboxHandle | null = null;
    let abortListener: (() => void) | undefined;
    const abortPromise = signal
      ? new Promise<never>((_resolve, reject) => {
          abortListener = () => {
            sandboxHandle?.kill().catch(() => undefined);
            reject(new DOMException("sandbox run aborted", "AbortError"));
          };
          signal.addEventListener("abort", abortListener);
        })
      : null;

    try {
      // Race create() against the abort promise so a mid-creation abort is handled.
      sandboxHandle = abortPromise
        ? await Promise.race([
            this.client.create({
              ...(this.apiKey !== undefined ? { apiKey: this.apiKey } : {}),
              ...(timeoutMs !== undefined ? { timeoutMs } : {}),
            }),
            abortPromise,
          ])
        : await this.client.create({
            ...(this.apiKey !== undefined ? { apiKey: this.apiKey } : {}),
            ...(timeoutMs !== undefined ? { timeoutMs } : {}),
          });

      // M18 fix: forward timeoutMs to runCode so execution is also bounded (not just sandbox
      // creation). Race against the abort promise when a signal is provided.
      const runPromise = sandboxHandle.runCode(code, {
        ...(opts?.language !== undefined ? { language: opts.language } : {}),
        ...(opts?.env !== undefined ? { envs: opts.env } : {}),
        ...(timeoutMs !== undefined ? { timeoutMs } : {}),
      });
      const exec = abortPromise ? await Promise.race([runPromise, abortPromise]) : await runPromise;
      const stdout = exec.logs.stdout.join("\n");
      const stderr = exec.logs.stderr.join("\n");
      // E2B has no numeric exit code: success unless an execution error was reported.
      const exitCode = exec.error ? 1 : 0;
      return {
        stdout,
        stderr,
        exitCode,
        ...(exec.error ? { error: `${exec.error.name}: ${exec.error.value}` } : {}),
      };
    } finally {
      if (abortListener && signal) signal.removeEventListener("abort", abortListener);
      // Always tear down the microVM; ignore kill failures so they never mask the run result.
      await sandboxHandle?.kill().catch(() => undefined);
    }
  }
}

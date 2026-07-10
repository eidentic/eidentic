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
    private readonly defaultTimeoutMs: number,
    private readonly apiKey: string | undefined,
    private readonly maxOutputBytes: number,
  ) {}

  static async create(opts: {
    client: E2BLike;
    apiKey?: string;
    defaultTimeoutMs?: number;
    /** Maximum UTF-8 bytes returned per stdout/stderr stream. Default: 512 KiB. */
    maxOutputBytes?: number;
  }): Promise<E2BSandbox> {
    const defaultTimeoutMs = opts.defaultTimeoutMs ?? 60_000;
    if (!Number.isSafeInteger(defaultTimeoutMs) || defaultTimeoutMs <= 0) {
      throw new Error("E2BSandbox: defaultTimeoutMs must be a positive safe integer");
    }
    const maxOutputBytes = opts.maxOutputBytes ?? 512 * 1024;
    if (!Number.isSafeInteger(maxOutputBytes) || maxOutputBytes < 0) {
      throw new Error("E2BSandbox: maxOutputBytes must be a non-negative safe integer");
    }
    return new E2BSandbox(opts.client, defaultTimeoutMs, opts.apiKey, maxOutputBytes);
  }

  async run(code: string, opts?: SandboxRunOptions): Promise<SandboxResult> {
    const timeoutMs = opts?.timeoutMs ?? this.defaultTimeoutMs;
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0) {
      throw new Error("E2BSandbox: timeoutMs must be a positive safe integer");
    }
    const signal = opts?.signal;

    // If already aborted before we start, throw immediately (fast-path).
    if (signal?.aborted) {
      throw new DOMException("sandbox run aborted", "AbortError");
    }

    // Set up the abort promise BEFORE awaiting create() so that a signal fired during creation is
    // also caught. The sandbox handle is initially null; the listener updates it once create() returns.
    let sandboxHandle: E2BSandboxHandle | null = null;
    let sandboxKilled = false;
    let boundaryTripped = false;
    const killSandbox = async (handle: E2BSandboxHandle | null = sandboxHandle): Promise<void> => {
      if (!handle || sandboxKilled) return;
      sandboxKilled = true;
      await handle.kill().catch(() => undefined);
    };
    let abortListener: (() => void) | undefined;
    const abortPromise = signal
      ? new Promise<never>((_resolve, reject) => {
          abortListener = () => {
            boundaryTripped = true;
            void killSandbox();
            reject(new DOMException("sandbox run aborted", "AbortError"));
          };
          signal.addEventListener("abort", abortListener, { once: true });
        })
      : null;
    let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
    const timeoutPromise = new Promise<never>((_resolve, reject) => {
      timeoutHandle = setTimeout(() => {
        boundaryTripped = true;
        void killSandbox();
        reject(new Error(`sandbox run timed out after ${timeoutMs}ms`));
      }, timeoutMs);
    });

    try {
      // Race create() against the abort promise so a mid-creation abort is handled.
      const createPromise = this.client.create({
        ...(this.apiKey !== undefined ? { apiKey: this.apiKey } : {}),
        timeoutMs,
      }).then((handle) => {
        sandboxHandle = handle;
        // Promise.race does not cancel the losing create(). If abort won while the remote
        // sandbox was still provisioning, tear down the handle as soon as it arrives.
        if (boundaryTripped || signal?.aborted) void killSandbox(handle);
        return handle;
      });
      sandboxHandle = await Promise.race([
        createPromise,
        timeoutPromise,
        ...(abortPromise ? [abortPromise] : []),
      ]);
      if (signal?.aborted) {
        await killSandbox(sandboxHandle);
        throw new DOMException("sandbox run aborted", "AbortError");
      }

      // M18 fix: forward timeoutMs to runCode so execution is also bounded (not just sandbox
      // creation). Race against the abort promise when a signal is provided.
      const runPromise = sandboxHandle.runCode(code, {
        ...(opts?.language !== undefined ? { language: opts.language } : {}),
        ...(opts?.env !== undefined ? { envs: opts.env } : {}),
        timeoutMs,
      });
      const exec = await Promise.race([
        runPromise,
        timeoutPromise,
        ...(abortPromise ? [abortPromise] : []),
      ]);
      const stdout = joinOutputBounded(exec.logs.stdout, this.maxOutputBytes);
      const stderr = joinOutputBounded(exec.logs.stderr, this.maxOutputBytes);
      // E2B has no numeric exit code: success unless an execution error was reported.
      const exitCode = exec.error ? 1 : 0;
      return {
        stdout,
        stderr,
        exitCode,
        ...(exec.error
          ? { error: truncateOutput(`${exec.error.name}: ${exec.error.value}`, this.maxOutputBytes) }
          : {}),
      };
    } finally {
      if (timeoutHandle !== undefined) clearTimeout(timeoutHandle);
      if (abortListener && signal) signal.removeEventListener("abort", abortListener);
      // Always tear down the microVM; ignore kill failures so they never mask the run result.
      await killSandbox();
    }
  }
}

const OUTPUT_TRUNCATION_MARKER = "\n…[output truncated]";

function joinOutputBounded(parts: readonly string[], maxBytes: number): string {
  if (maxBytes === 0 || parts.length === 0) return "";
  let output = "";
  let used = 0;
  for (let index = 0; index < parts.length; index++) {
    const separator = index === 0 ? "" : "\n";
    const remaining = maxBytes - used;
    if (remaining <= 0) return truncateOutput(output + "x", maxBytes);
    const part = parts[index]!;
    // At most one ASCII code unit can fit per remaining byte, so this slice bounds allocation even
    // when a malicious client returns a multi-gigabyte string in one array element.
    const candidate = separator + part.slice(0, remaining);
    const candidateBytes = Buffer.byteLength(candidate, "utf8");
    if (candidateBytes > remaining || part.length > remaining) {
      return truncateOutput(output + utf8Prefix(candidate, remaining) + "x", maxBytes);
    }
    output += candidate;
    used += candidateBytes;
  }
  return output;
}

function truncateOutput(value: string, maxBytes: number): string {
  const bytes = Buffer.from(value, "utf8");
  if (bytes.byteLength <= maxBytes) return value;
  const marker = Buffer.from(OUTPUT_TRUNCATION_MARKER, "utf8");
  if (marker.byteLength >= maxBytes) return utf8Prefix(OUTPUT_TRUNCATION_MARKER, maxBytes);
  return utf8Prefix(value, maxBytes - marker.byteLength) + OUTPUT_TRUNCATION_MARKER;
}

function utf8Prefix(value: string, maxBytes: number): string {
  let prefix = Buffer.from(value, "utf8").subarray(0, maxBytes).toString("utf8");
  // A byte slice can end in the middle of a code point; decoding inserts U+FFFD (three bytes),
  // which can itself exceed the intended budget. Remove code points until the contract holds.
  while (Buffer.byteLength(prefix, "utf8") > maxBytes) {
    prefix = Array.from(prefix).slice(0, -1).join("");
  }
  return prefix;
}

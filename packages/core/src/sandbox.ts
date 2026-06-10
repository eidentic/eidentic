import type { SandboxPort, SandboxResult, SandboxRunOptions } from "@eidentic/types";

const REFUSAL =
  "no sandbox configured: refusing to execute untrusted code " +
  "(configure a SandboxPort, e.g. @eidentic/e2b)";

/**
 * The secure-default `SandboxPort` (§10.7). It CANNOT isolate, so it CANNOT safely run untrusted
 * code — and therefore it refuses every `run()`. This is what makes "no sandbox ⇒ no untrusted exec"
 * real: a deployment that wires no real adapter gets refusals, not silent host-process execution.
 *
 * By default `run()` returns an error `SandboxResult` (so callers can branch without try/catch).
 * Pass `{ throwOnRun: true }` to make `run()` THROW instead — useful when a missing sandbox should
 * hard-fail a flow rather than degrade.
 */
export class NoopSandbox implements SandboxPort {
  private readonly throwOnRun: boolean;

  constructor(opts?: { throwOnRun?: boolean }) {
    this.throwOnRun = opts?.throwOnRun ?? false;
  }

  async run(_code: string, _opts?: SandboxRunOptions): Promise<SandboxResult> {
    if (this.throwOnRun) throw new Error(REFUSAL);
    return { stdout: "", stderr: "", exitCode: 1, error: REFUSAL };
  }
}

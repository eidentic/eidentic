/**
 * Sandbox substrate (§10.5, §10.7).
 *
 * 1. The SECURE DEFAULT (`NoopSandbox`) REFUSES to run untrusted code when no real isolation is
 *    configured — "no sandbox ⇒ no untrusted exec".
 * 2. A configured `SandboxPort` (here the trusted-dev `EchoSandbox`; swap for `E2BSandbox` with a
 *    real key in production) runs the code and returns its output.
 *
 * Run:  pnpm hello:sandbox
 */
import { NoopSandbox } from "@eidentic/core";
import { EchoSandbox } from "@eidentic/types/testing";
import type { SandboxPort } from "@eidentic/types";

async function main() {
  const untrusted = "console.log('I could be a prompt-injected payload')";

  // 1. Secure default: refuses.
  const secureDefault: SandboxPort = new NoopSandbox();
  const refused = await secureDefault.run(untrusted);
  console.log("[NoopSandbox] exitCode:", refused.exitCode);
  console.log("[NoopSandbox] error  :", refused.error);
  //  → exitCode 1, error: "no sandbox configured: refusing to execute untrusted code …"

  // 2. A configured sandbox runs it. EchoSandbox is for TRUSTED-DEV/tests only (it does NOT isolate).
  //    In production wire a real microVM adapter instead:
  //
  //      import { E2BSandbox, type E2BLike } from "@eidentic/e2b";
  //      import { Sandbox } from "@e2b/code-interpreter";
  //      const client: E2BLike = { create: (o) => Sandbox.create({ apiKey: process.env.E2B_API_KEY, ...o }) as never };
  //      const sandbox = await E2BSandbox.create({ client, apiKey: process.env.E2B_API_KEY });
  //
  const sandbox: SandboxPort = new EchoSandbox();
  const ran = await sandbox.run(untrusted);
  console.log("[EchoSandbox] exitCode:", ran.exitCode, "stdout:", ran.stdout);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

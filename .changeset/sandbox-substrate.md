---
"@eidentic/types": minor
"@eidentic/core": minor
"@eidentic/e2b": minor
---

Sandbox substrate (§10.3, §10.5, §10.7): run untrusted / agent-generated code off the host process.

**`@eidentic/types`** — new `SandboxPort` (in `security.ts`): `run(code, opts?) => SandboxResult`
(`{ stdout, stderr, exitCode, error? }`) with `SandboxRunOptions` (`language?`, `timeoutMs?`, `env?`).
Adds an `EchoSandbox` fake + a `sandboxConformanceCases` contract to `@eidentic/types/testing`
(trusted-dev/tests only — `EchoSandbox` does NOT isolate).

**`@eidentic/core`** — new `NoneSandbox`: the secure default. `run()` refuses every call ("no sandbox
configured: refusing to execute untrusted code …") — returns an error `SandboxResult` by default,
or throws with `new NoneSandbox({ throwOnRun: true })`. This makes "no sandbox ⇒ no untrusted exec"
(§10.7) real.

**`@eidentic/e2b`** (new) — `E2BSandbox implements SandboxPort` over E2B Firecracker microVMs via an
injected structural `E2BLike` client. CI conformance runs against a faithful in-memory fake; a gated
live test (`EIDENTIC_TEST_E2B_API_KEY`) hits the real `@e2b/code-interpreter` (devDependency + optional
peerDependency; only runtime dep is `@eidentic/types`).

Deferred (not in this release): microsandbox/libkrun adapter, egress allowlisting, the executable-skill
kind + test-gate (Plan 12b), and any portable OS-level sandbox (Landlock/Seatbelt — §10.5 says there is
none).

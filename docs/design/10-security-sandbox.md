# 10. Security & Sandbox

[← 9. Durable Execution](09-durable-execution.md) · [Index](master-design.md) · Next: [11. Observability + Cost + Eval →](11-observability-cost-eval.md)

Only **11%** of production agents pass a basic security bar (June-2026 research). **98%** are
structurally exploitable by the lethal trifecta, and human red-teamers achieve **100%
bypass** of static prompt-injection defenses. Eidentic's stance is **assume-breach**: we
cannot prevent injection, so we contain blast radius. Security is a Constitution-#7
fundamental, not optional hardening.

## 10.1 Threat model

- **Indirect prompt injection.** Untrusted content the agent reads (web pages, emails, tool
  outputs, retrieved memory, imported skills) carries instructions the model may follow with
  the user's privileges. System prompts and safety training operate *above* the data layer and
  cannot reliably stop this. EchoLeak (CVE-2025-32711) exfiltrated data with zero user interaction.
- **The lethal trifecta.** Any agent with (1) private-data access + (2) untrusted-content
  exposure + (3) external communication is exploitable. The **Agents Rule of Two**: satisfy at
  most two of {untrusted input, sensitive access, external state change} in one un-gated flow.
- **Self-extension risks.** Agent-authored skills/tools are vulnerable 76% of the time and
  accept malicious external tools 93% of the time; one injection can persist a backdoor to disk.

## 10.2 Five-layer defense (independent, no single point of failure)

A naive harness has one gate. Eidentic has five (the production pattern from the harness
research), each independent so no single failure compromises safety:

1. **Prompt layer.** Policy guardrails, read-before-edit, git/workflow rules in the system
   prompt. *Necessary but insufficient* (100% bypass alone) — never the only layer.
2. **Schema layer.** Plan-mode and per-sub-agent tool filtering: forbidden tools are *absent
   from the schema*, so the model cannot invoke what it cannot see. The strongest practical
   control because it removes capability, not just permission.
3. **Runtime approval.** Deny-by-default permission modes (§10.4) + human-gates for
   irreversible actions, evaluated *outside* model reasoning (the model can't argue past it).
4. **Tool validation.** Dangerous-pattern blocklists, stale-read detection, output truncation,
   per-tool timeouts, idempotency enforcement (§9.3).
5. **Lifecycle hooks.** User pre/post-tool hooks (§3.5) for org-specific policy: block, mutate,
   audit, or route to human.

**Core principle: never let the model call tools directly.** Reasoning and permission
enforcement are separated, so prompt injection cannot escalate capability.

## 10.3 Blast-radius containment (what actually works now)

Since prevention is imperfect, containment is primary:

- **Sandboxed execution.** All agent-generated/untrusted code and skill scripts run in a
  sandbox via `SandboxPort` — never the host process.
- **Credential isolation.** Secrets live in a vault process; the dispatcher injects them into
  sealed tools at call time. The **model never sees credentials**; they never enter context.
- **Sealed tool endpoints (§5.6).** Fixed schema/endpoint; the agent supplies typed params and
  cannot author or alter network calls, URLs, headers, or auth. No default generic `http`/`exec`.
- **Egress allowlisting.** Outbound network is allowlisted per agent/tool; secret-detection on
  egress; upload-volume thresholds. Defeats exfiltration even after injection.
- **Human-gated irreversible actions.** Destructive tools (§5.2) require cryptographic human
  approval (passkey/CIBA-style) unless explicitly pre-approved — durably suspended while waiting
  (§9.4). *"What keeps an agent safe is what it cannot do, even when it tries."*
- **Injection propagation boundaries.** Classify injection severity (session → memory →
  cross-agent → cross-system) and instrument each boundary; untrusted content is tagged so it
  can't silently flow into a privileged sink (e.g., into a shared memory block or a signed skill).

## 10.4 Permission system

Deny-by-default, evaluated in strict order, changeable mid-session:

```
1. Hooks (PreToolUse)        → can deny outright
2. Deny rules                → bare name removes the tool from schema; scoped pattern blocks args
3. Permission mode           → default | plan(read-only) | acceptEdits | ask | bypass
4. Allow rules               → pre-approve specific tools/patterns
5. canUseTool callback       → programmatic decision (or human gate)
```

- **`plan` mode** exposes only read-only tools (schema-filtered) — safe analysis without writes.
- Scoped rules: `refund_order(*)` denied while `read_*` allowed. Bare-name deny removes from
  schema; pattern deny blocks specific arguments even under `bypass`.
- Modes are per-run and adjustable live (`session.setPermissionMode(...)`).

## 10.5 Sandbox adapters (`SandboxPort`)

| Adapter | Isolation | Startup | Use |
|---------|-----------|---------|-----|
| **microsandbox** (default self-host) | microVM (libkrun) | ~ hundreds ms | local/self-hosted skill & code exec |
| **E2B** (default cloud) | Firecracker microVM | ~150 ms | cloud agent workloads |
| **none** | — | 0 | trusted-only deployments (explicit opt-in) |

Standard Docker is **not** a default for untrusted code — shared kernel is insufficient for
hostile LLM-generated code (research-backed).

**Honest capability matrix (correction from review §0-C7):** there is **no portable OS-level
sandbox**. Landlock is Linux-only and kernel-gated; Seatbelt is macOS-only and effectively
undocumented for third-party use. So:

| Environment | Real default | Guarantee |
|-------------|-------------|-----------|
| Embedded dev (Mac laptop) | `none`, or **remote E2B** | no local microVM; we say so plainly |
| Linux self-host | **microsandbox** (libkrun microVM) | strong (dedicated kernel) |
| Cloud | **E2B** (Firecracker) | strong |

We do **not** claim portable Landlock/Seatbelt protection. If a deployment runs untrusted code or
executable skills without a real sandbox adapter, the SDK **warns** and (configurably) refuses —
secure-by-default means "no sandbox ⇒ no untrusted exec," not "we silently sandboxed it."

## 10.6 Skill/tool provenance (ties to §7)

Generated and imported skills carry signed `skill.lock` provenance; the loader can require
signatures, quarantine agent-authored skills until tested + approved, and enforce
capability scopes. This is the architecture that makes self-evolving agents safe enough for
regulated use — the gap no current framework fills.

## 10.7 Secure defaults

Out of the box: deny-by-default permissions, no generic network/exec tool, sandbox on for
code/skill execution, credential vault required for secret-bearing tools, egress allowlist
empty (opt-in), destructive tools human-gated. A developer must *opt into* danger, never out
of safety.

## 10.8 Traceability

- Lethal trifecta / 98% exploitable → §10.3 containment + Rule-of-Two design.
- Unauth RCE via sandbox escape → §10.5 sandbox-by-default + §10.7 secure defaults.
- Skill poisoning / persistent backdoors → §10.6 provenance + §7.6 quarantine.
- Prompt injection 100% bypass of static defenses → §10.2 five independent layers, not one.

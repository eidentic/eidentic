# 20. Secrets, Rate Limiting & Quotas

[← 19. Schema & Prompt Evolution](19-schema-prompt-evolution.md) · [Index](master-design.md) · *(end of spec)*

Added after adversarial review flagged a **major**: §10.3 said "a vault process injects secrets"
but defined no interface, no rotation, no per-tool scoping, and no embedded-mode story (there is no
vault process on a laptop). And rate limiting / quotas — table stakes for any multi-tenant agent
service and a key defense against runaway cost — had no home.

## 20.1 SecretsPort

Secrets are never in code, context, traces, or memory (§10.3, §15.2 `secret` class). They are
resolved at tool-dispatch time through a port:

```ts
interface SecretsPort {
  resolve(ref: SecretRef, scope: Scope): Promise<SecretValue>   // injected into sealed tool, never to the model
  rotate?(ref: SecretRef): Promise<void>
}
type SecretRef = { name: string; version?: string }
```

- **Sealed-tool injection (§5.6):** the dispatcher resolves a tool's declared `SecretRef`s and
  injects them into the handler's `ctx.deps` at call time. The model never sees the value; it
  supplies only typed business params.
- **Per-tool scoping:** a tool declares exactly which secrets it needs; it cannot read others.
  Secrets are scoped (org/agent) so tenant A's tool can't resolve tenant B's key.
- **Rotation:** `rotate` + versioned refs allow zero-downtime key rotation; in-flight runs pin a version.

## 20.2 Adapters & the embedded-mode story

`SecretsPort` adapters (honest about what each environment offers):

| Environment | Default adapter | Notes |
|-------------|-----------------|-------|
| Embedded dev (laptop) | **env vars / OS keychain / 0600 file** | No vault process exists locally — we say so; secrets come from the process env or the OS keychain, never written to Eidentic state |
| Server / cloud | **Vault / cloud KMS** (HashiCorp Vault, AWS/GCP KMS, Doppler, Infisical) | a real secret manager; rotation + audit |
| Test | in-memory fake | §18 |

This replaces the §10.3 "vault process" hand-wave with a real, environment-appropriate matrix.

## 20.3 Rate limiting

Multi-tenant agent services must throttle to protect both their own infra and upstream providers:

- **Tenanted limiters:** token-bucket limits per `user`, `org`, and `apiKey` (scopes from §6.7,
  keys from `AuthPort` §0-A). Configurable; enforced before the loop starts and per model/tool call.
- **Provider-429 coordination (fleet-wide):** a shared limiter (backed by the store / Redis adapter)
  coordinates provider rate limits across processes, so N server instances don't collectively
  exceed an Anthropic/OpenAI account limit. Parses provider rate-limit headers (§9.2) to adapt
  dynamically (cooperative, not just reactive backoff).
- **Per-agent concurrency caps** (§16) compose with rate limits.

## 20.4 Quotas

Quotas tie usage to the cost governor (§11.2) at the tenant level:

- Per-tenant ceilings on $, tokens, runs, and storage, enforced by the governor's pre-flight
  (`budget.unavailable` error, §17) — the multi-tenant generalization of per-run caps.
- Soft quotas warn / downgrade models; hard quotas block. Monthly ceilings require approval to exceed.
- Quota + cost accounting share the `CostBreakdown` ledger (foreground/background/cached), so a
  tenant's *background* memory/skill spend counts against their quota — never hidden (Constitution #5).

## 20.5 Batching (cost lever)

Added to the §11.2 cost levers:

- **Provider batch APIs** (≈50% discount) for non-interactive work: embedding re-index (§19.3),
  consolidation (§6.5), and eval (§11.3) runs use batch endpoints where available.
- **Embedding batching:** ingest batches embeddings rather than one call per item.
- **Batched consolidation:** one consolidation pass per scope per window (§16.3 debounce), not per event.

## 20.6 Traceability

- §10.3 "vault" hand-wave (review major) → §20.1 SecretsPort + §20.2 honest env matrix.
- Runaway multi-tenant cost → §20.3 rate limits + §20.4 quotas + §11.2 enforcement.
- Provider 429 across a fleet → §20.3 shared limiter.
- Cost levers missing batching → §20.5.
- "Background spend counts, never hidden" → §20.4 shared ledger (Constitution #5).

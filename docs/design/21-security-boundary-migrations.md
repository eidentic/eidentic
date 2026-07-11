# 21. Security Boundary Migrations

[← 20. Secrets, Rate Limiting & Quotas](20-secrets-rate-limiting.md) · [Index](master-design.md)

**Status:** Accepted · **Date:** 2026-07-10

This decision records the compatibility rules introduced by the July 2026 security hardening.
These are runtime boundaries, not optional recommendations.

## Identity and ownership

- New sessions store API-key ownership as `eidentic.credential.sha256:<sha256>`; plaintext API keys
  are never written. A legacy plaintext owner is upgraded only after the presented credential
  matches, using compare-and-swap so concurrent migration cannot overwrite another update.
- An owned session requires the matching canonical principal. User ownership takes precedence over
  organisation ownership; omission of identity is not an authorization bypass.
- MCP, A2A, Next.js, Server and Studio bind identity from authenticated transport metadata. Request
  bodies cannot select their own owner unless a deliberately named unsafe compatibility flag is set.
- Ownerless legacy sessions remain readable only to ownerless trusted/single-tenant callers.
  Authenticated principals are denied by default; `unsafeAllowOwnerlessSessionAccess` is a temporary
  migration escape hatch and may be enabled only after an independent authorization check proves
  the caller owns the requested session. Tenant deployments should migrate or erase ownerless data.

## Storage keys and durable execution

- Scope tuples containing delimiters use the injective `eidentic.scope.v2:<JSON tuple>` format.
  Unambiguous legacy scope strings retain their existing key. Ambiguous legacy rows fail closed;
  operators must map them from authoritative tenant data rather than guessing ownership.
- Tool idempotency uses `eidentic.idem.v2:<JSON tuple>`. The previous session-prefixed format is read
  only when stored session metadata proves exact ownership; bare ambiguous keys are not replayed.
- `DurablePort.claimIntent` is the atomic dispatch boundary. A surviving `intent` claim is not
  automatically re-executed after a crash; an operator/reconciler must prove whether the external
  side effect happened, then complete or release the claim.
- `StorePort` adds durable memory listing/deletion and credential compare-and-swap operations.
  Custom adapters must implement the complete runtime structural contract before use.
- Workflow resume claims are renewable leases. Replay verifies the live claim before every
  uncached step and rejects stale completion. External systems still need idempotency or their own
  fencing token because arbitrary step code can ignore cancellation after losing a lease.

## Untrusted data and output boundaries

- Guardrails run before persistence. Retrieved memory, skill catalogs and recalled text are marked as
  untrusted user data and cannot become system instructions.
- Tool/provider values cross a bounded recursive sanitizer before model, persistence and client
  boundaries. Credential-shaped fields, bearer values, credential-bearing URLs, oversized values,
  cycles and excessive depth are redacted or truncated.
- Multimodal input accepts bounded PNG/JPEG/GIF base64 data. Remote URLs are denied unless a trusted
  resolver returns bounded bytes. Tool-enabled multimodal runs require explicit opt-in.
- Terminal results and interrupted partial assistant output are persisted before being exposed, so
  fresh streams and replay share the same event sequence and terminal semantics.

## Network, files and browser lifecycle

- `SafeEgressPort` centralizes scheme, host, DNS/IP, redirect, response-size and timeout policy.
  Webhooks, RAG, web tools and browser HTTP routing use deny-by-default policies. Private hosts and
  insecure HTTP require explicitly named unsafe migration options.
- File stores use private modes, random exclusive temporary files, link checks, synchronization and
  atomic replacement. These defenses do not replace an OS sandbox when an attacker can rename parent
  directories concurrently; production deployments should isolate writable roots.
- `withBrowserTools` creates and closes one context per verified tenant/run, blocks service workers
  and installs routing before page creation. The deprecated shared-page API requires an explicit
  unsafe opt-in.

## Known infrastructure boundaries

Application-level DNS validation cannot pin the exact address used by every transport. Browser
WebSockets and browser-process compromise are also outside request interception. Production agents
with network capability therefore require a deny-by-default proxy/firewall and a process supervisor.
The in-process session mutex prevents races within one runtime; multi-process deployments must use a
single-writer queue or adapter-level distributed lease for each session.

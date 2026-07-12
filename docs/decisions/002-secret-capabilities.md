# ADR-002: Extend the existing secret port instead of owning a vault

## Status

Accepted

## Date

2026-07-12

## Context

Eidentic already has a provider-neutral `SecretsPort` and per-tool `requiredSecrets`, but the
current interface loses tenant/tool context, requires duplicated allowlists, has no ergonomic
required-value operation, and cannot contain a secret that a buggy tool returns in its output.

## Decision

Keep vault storage outside Eidentic. Extend secret resolution with optional immutable access
context, expose a per-invocation `SecretCapability` to tools, and redact values resolved during that
invocation before results cross the dispatcher boundary. Directory projects derive a safe
environment allowlist from tool declarations when no custom vault is supplied.

## Alternatives considered

### Build an Eidentic cloud vault

Rejected. Secret custody, rotation, billing, tenancy, and incident response are a separate product,
not an SDK convenience feature.

### Pass environment variables directly to tools

Rejected. It gives every tool ambient credentials and makes least privilege unverifiable.

### Rely on tool authors never returning secrets

Rejected. That is a useful coding rule but not a security boundary. The dispatcher already owns the
last safe point before tool output reaches durable state and the model.

## Consequences

- Existing vault adapters remain valid and can optionally use richer context.
- Directory projects need less duplicated configuration.
- The dispatcher carries a small per-call redaction tracker and must keep sanitation bounded.
- Only secrets resolved through Eidentic can be redacted exactly; unknown credentials still require
  normal secure tool design and output guardrails.

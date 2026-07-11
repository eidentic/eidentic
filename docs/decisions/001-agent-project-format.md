# ADR-001: Add a directory convention above the programmatic runtime

## Status

Accepted

## Date

2026-07-12

## Context

Eidentic exposes deep runtime controls but requires users to assemble and register an agent before
they can experience them. File conventions make an agent understandable at a glance and allow the
CLI to provide a coherent local workflow. Existing users rely on the programmatic config and must
not be forced through a migration.

## Decision

Add an optional `agent/` project convention compiled by the CLI into the existing
`EidenticConfig`. Keep `eidentic.config.*` authoritative and fully supported. Discovery remains a
CLI concern; core continues to accept explicit typed objects and does not gain filesystem behavior.

Directory loading is additive, local-root confined, deterministic, and fail-closed for malformed
or ambiguous inputs. Platform deployment integrations consume the same resolved project contract
rather than introducing platform-specific core behavior.

## Alternatives considered

### Replace `eidentic.config.ts`

Rejected because it breaks advanced and existing applications and makes dynamic composition harder.

### Put filesystem discovery in core

Rejected because core must remain portable to edge runtimes and embeddable applications.

### Generate a config once and never load directories at runtime

Rejected because generated registration boilerplate drifts and weakens the local development loop.

## Consequences

- Beginners get convention and defaults; advanced users retain full programmatic control.
- CLI becomes the compiler boundary and requires strict path/module validation.
- Directory features can land incrementally without destabilizing core.
- Deploy adapters must invoke the same resolver or compile its result during build.

# Spec: Least-Privilege Secret Capabilities

## Objective

Make secret-bearing tools easy to configure without weakening Eidentic's core guarantee: the model,
event log, durable ledger, hooks, and normal tool output must never receive a secret value. Extend
the existing `SecretsPort` and `requiredSecrets` design rather than introducing a hosted vault or a
provider-specific secret manager.

Success means:

- a tool declares each secret once through `requiredSecrets`;
- directory projects automatically expose only those declared environment variables when no custom
  vault is configured;
- secret resolution receives immutable agent/tool/scope context for tenant-aware adapters;
- tools can use `ctx.secrets.require(ref)` for a clear missing-secret failure;
- undeclared access fails closed;
- any resolved secret accidentally returned or thrown by a tool is recursively redacted before it
  reaches hooks, persistence, durable replay, stream events, or the model;
- CLI diagnostics list missing secret **names** without reading or printing their values;
- existing custom `SecretsPort` implementations with `get(ref)` continue to compile and run.

## Assumptions

1. Eidentic remains vault-provider neutral. HashiCorp Vault, AWS/GCP secret managers, Doppler, and
   Infisical can implement the public port later.
2. Model-provider credentials remain owned by their provider SDK. This feature governs secrets
   consumed by Eidentic tools.
3. Exact-value output redaction is a last-resort safety boundary, not permission for tools to return
   credentials intentionally.
4. Secret values shorter than eight characters are still redacted when returned as an exact value,
   but are not replaced as substrings inside unrelated text to avoid corrupting ordinary output.

## Public interfaces

```ts
export interface SecretAccessContext {
  agentId?: string;
  sessionId?: string;
  toolId: string;
  scope?: Scope;
}

export interface SecretsPort {
  get(ref: string, context?: SecretAccessContext): Promise<string | undefined>;
}

export interface SecretCapability {
  get(ref: string): Promise<string | undefined>;
  require(ref: string): Promise<string>;
}
```

`ToolContext.secrets` becomes `SecretCapability`. The optional second argument on
`SecretsPort.get` is source-compatible with one-argument implementations. Capability objects are
created per invocation, contain no enumeration API, and accept only the current tool's immutable
`requiredSecrets` set.

`createTool` validates and freezes `requiredSecrets`: names must match
`^[A-Za-z_][A-Za-z0-9_]*$`, duplicates are rejected, and a caller-owned array cannot mutate the
compiled tool.

## Directory-project ergonomics

When a directory definition omits `secrets`, the CLI derives the union of discovered tools'
`requiredSecrets` and supplies `new EnvSecrets(refs)`. This reads values lazily at dispatch time.
An explicitly configured custom vault always wins. Legacy programmatic configs remain unchanged.

`eidentic doctor` reports required tool-secret names as present/missing without including values.

## Redaction boundary

The per-invocation capability records only successfully resolved non-empty values. Before a tool
result crosses the dispatch boundary, Eidentic creates a bounded, cycle-safe sanitized copy:

- strings equal to a resolved value become `[REDACTED_SECRET]`;
- values of at least eight characters are also replaced when embedded in a larger string;
- object keys, prototypes, getters, symbols, and non-JSON runtime objects are never traversed in a
  way that executes user code;
- depth, node count, string length, and array length are bounded consistently with existing boundary
  sanitation;
- thrown error messages pass through the same exact-value redaction;
- durable completions and post-tool hooks receive only the sanitized result.

## Testing strategy

- Type tests prove old one-argument vaults remain assignable.
- Tool tests cover invalid/duplicate declarations, immutability, `require`, undeclared access, and
  context propagation.
- Regression tests prove secrets cannot appear in tool events, subsequent model messages, durable
  completions, post-tool hooks, errors, or replay.
- Boundary tests cover nested values, arrays, cycles, short secrets, substring replacement,
  lookalikes, getters, large structures, and multiple secrets.
- CLI tests cover automatic directory env capabilities and name-only doctor diagnostics.
- Full release gates remain mandatory.

## Boundaries

- Always: lazy resolution, least privilege, immutable capability sets, no enumeration, structured
  audit metadata, output/error redaction, and backwards-compatible interfaces.
- Ask first: adding a provider SDK, writing secrets to disk/keychain, rotation, or changing a remote
  vault.
- Never: print secret values, persist them, include them in schemas/prompts, expose ambient
  `process.env`, silently allow undeclared access, or claim exact-value redaction replaces a real
  vault.

## Delivery slices

1. Contract types, declaration validation, capability `require`, and contextual resolution.
2. Cycle-safe resolved-secret output/error redaction at the single dispatch boundary.
3. Directory auto-wiring and name-only CLI diagnostics.
4. Examples, compatibility docs, release gates, npm publish, and docs-site update.

## Non-goals

- A hosted Eidentic vault, secret rotation service, or cloud account integration.
- Managing provider model keys on behalf of AI SDK providers.
- Automatically copying `.env` values into a deployment platform.
- Detecting arbitrary unknown secrets that were never resolved through the capability.

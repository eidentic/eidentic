# @eidentic/types

Shared TypeScript types and port interfaces for Eidentic — the canonical protocol types
(`StoredEvent`, `MemoryBlock`, `Fact`, `ContentBlock`), storage/vector/auth/sandbox/quota
ports, error classes, observability spans, and utility types. All other Eidentic packages
depend on this package; it has no runtime dependencies itself.

## Install

```bash
pnpm add @eidentic/types
```

## Usage

```ts
import type {
  StorePort,
  VectorPort,
  AuthPort,
  AuthPrincipal,
  SandboxPort,
  TracerPort,
  MemoryBlock,
  Scope,
  StoredEvent,
} from "@eidentic/types";

// Implement a custom store adapter (bring-your-own-store)
class MyStore implements StorePort {
  async upsertBlock(
    scope: Scope,
    block: { label: string; value: string },
    expectVersion?: number, // optimistic-concurrency check; throw StoreConflictError on mismatch
  ): Promise<MemoryBlock> {
    /* ... */
  }
  // ...implement the remaining StorePort methods (sessions, events, memory index, eraseScope, ...)
}

// Validate any adapter against the canonical conformance suite:
//   import { storeConformanceCases } from "@eidentic/types/testing";
//   for (const c of storeConformanceCases(() => new MyStore())) it(c.name, c.run);
// See @eidentic/convex for a complete worked example (StorePort + GraphPort + VectorPort over Convex).

// Write a custom auth adapter
class MyAuth implements AuthPort {
  async authenticate(req: AuthRequest): Promise<AuthPrincipal | null> {
    const token = req.headers.get("x-api-key");
    if (token !== process.env.API_KEY) return null;
    return { userId: "user-1" };
  }
}
```

## Links

- [GitHub](https://github.com/eidentic/eidentic)
- [Issue tracker](https://github.com/eidentic/eidentic/issues)
- [Root README](https://github.com/eidentic/eidentic#readme)

Apache-2.0

# Legacy scope-key migration

Scope components containing `:` use the injective `eidentic.scope.v2` encoding. Older releases
stored delimiter-based keys that can map to more than one logical tenant. Eidentic therefore does
not fall back to those rows during reads.

For each affected scope, an operator must verify the intended owner and explicitly run the concrete
store's `migrateLegacyScope(scope)` method. First-party InMemory, SQLite, libSQL, PostgreSQL, and
Convex stores implement this capability. The method moves blocks, block history, lexical memories,
facts, and scoped idempotency records in one store transaction where the backend supports it. It
returns `{ migrated }`, is a no-op when the old and current key are identical, and refuses to merge
when the v2 destination already contains store data.

Vector stores are migrated separately with `migrateLegacyScopeVectors(vector, scope)` from
`@eidentic/memory`. The vector adapter must implement `list`. The helper copies and verifies every
entry before erasing the legacy source. An identical partial destination is treated as a resumable
attempt; unrelated destination data is rejected.

Run migrations in a maintenance window with writers stopped. Back up persistent data first, migrate
one reviewed scope at a time, record the returned counts, and verify reads under the v2 scope before
resuming traffic. Never derive a destination merely by splitting a legacy key on `:`.

Convex's `migrateLegacyScope` mutation also migrates vectors stored in the same Convex component, so
do not additionally call the generic vector helper for that deployment.

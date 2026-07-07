# Dependency Migration Notes

These notes capture v1 dependency decisions so Dependabot noise does not become release risk.

## Status as of 2026-07-08

| Dependency | Current repo range | Latest checked | v1 decision |
|---|---:|---:|---|
| TypeScript | `^5.9.0` | `6.0.3` | Defer major migration until a dedicated branch proves full CI and declaration output. |
| Vite | `^6.0.0` root, `^6.3.5` Studio | `8.1.3` | Defer major migration; Studio build is green on the current supported range. |
| `@electric-sql/pglite` | `^0.4.6` | `0.5.4` | Keep Dependabot ignore for `>=0.5.0` until pgvector tests are migrated from the removed vector export. |
| `@changesets/cli` | `^2.31.0` | `2.31.0` | Updated before v1; release gate must stay green. |
| `read-yaml-file` | transitive `1.1.0` | `3.0.0` | Keep the pnpm patch while Changesets still pulls `1.1.0`; audit remains clean. |

## TypeScript 6 / Vite 8

Do not merge automatic grouped major updates for TypeScript 6, Vite 8, or Node types 25. Use a human-owned migration PR:

1. Create a short-lived branch.
2. Upgrade TypeScript first; run `pnpm run typecheck` and inspect declaration output.
3. Upgrade Vite/Studio separately; run `pnpm --filter @eidentic/studio build`.
4. Run `pnpm run release:check -- --skip-install`.
5. Document any user-facing tsconfig or bundler migration notes.

If either migration needs compatibility shims, ship those as explicit code changes rather than hiding them inside a dependency PR.

## pglite 0.5

`@electric-sql/pglite@0.5.x` removed the vector import path used by the pgvector/postgres tests. Until the replacement extension path is wired and tested:

- keep `@electric-sql/pglite` pinned below `0.5.0` via Dependabot ignore;
- do not accept grouped dependency PRs that include pglite 0.5;
- migrate pgvector tests in a dedicated PR and run Node 22/24 CI plus cross-runtime smoke.

## Changesets / `read-yaml-file` Patch

Security hardening requires `js-yaml` APIs that do not expose the removed `safeLoad` call. Changesets still depends on `read-yaml-file@1.1.0`, so this repo keeps:

```yaml
patchedDependencies:
  read-yaml-file@1.1.0:
    path: patches/read-yaml-file@1.1.0.patch
```

The patch is intentionally tiny: it replaces `yaml.safeLoad(...)` with `yaml.load(...)`. Remove it only when the Changesets dependency graph no longer installs `read-yaml-file@1.1.0`, then rerun:

```bash
pnpm install --lockfile-only
pnpm run release:check -- --skip-install
pnpm audit --audit-level low
```

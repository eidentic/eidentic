# Changesets

This folder is managed by [Changesets](https://github.com/changesets/changesets). Each change
to a published `@eidentic/*` package should include a changeset describing the change and the
semver bump.

Add one with:

```bash
pnpm changeset
```

Pick the affected packages, choose `patch` / `minor` / `major`, and write a short summary.
The accumulated changesets drive version bumps and changelog entries at release time
(`pnpm changeset version`).

Per the project's stability promise: **no breaking changes in a minor across the 1.x line** —
breaking changes are `major` only, and ship with a codemod.

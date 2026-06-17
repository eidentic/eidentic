# Releasing

Eidentic publishes with Changesets and npm Trusted Publishing from GitHub Actions.
Do not publish from a local machine during the normal release path.

## Why

- Changesets owns package version bumps, changelogs, and internal dependency ranges.
- npm Trusted Publishing uses GitHub Actions OIDC instead of long-lived npm write tokens.
- npm provenance is generated automatically for public packages published from the public repo.
- The publish workflow runs the same release gate used locally before it calls `changeset publish`.

## Per-Change Flow

Every PR that affects a published package needs a changeset:

```sh
pnpm changeset
```

Use `patch` for bug fixes and security hardening, `minor` for new public APIs, and `major`
only for intentional breaking changes. Empty/internal-only PRs may use:

```sh
pnpm changeset --empty
```

Before opening or updating the PR:

```sh
pnpm run release:check -- --skip-install
```

For a packaging preview:

```sh
pnpm run release:dry-run -- --skip-install
```

## v1 Release Criteria

Do not tag `v1.0.0` until these checks are true:

- GitHub has no open `p0` issues in the `v1.0` milestone.
- `pnpm run release:check -- --skip-install` passes locally on a clean tree.
- CI is green for Node 22 and Node 24.
- Cross-runtime smoke is green for Node, Bun, and Deno.
- `pnpm audit --audit-level low` reports no known vulnerabilities.
- README and package README examples match the current public API.
- Fresh install quickstarts work from outside the monorepo.
- npm Trusted Publishing is the only normal publish path.
- Public API stability is documented for core packages and experimental surfaces are named explicitly.
- Release notes call out breaking changes, migration notes, security changes, and known limitations.

For v1, major dependency migrations must be handled as explicit migration PRs, not automatic grouped dependency updates.

## Release Flow

After the PR is merged into `main`:

```sh
git checkout main
git pull --ff-only
pnpm run release:version
git add .
git commit -m "chore(release): version packages"
git tag vX.Y.Z
git push origin main --follow-tags
```

The `v*` tag triggers `.github/workflows/publish.yml`, which runs:

```sh
pnpm run release:publish
```

That command installs with the frozen lockfile, builds, tests, typechecks, checks README examples,
runs `pnpm audit --audit-level low`, and publishes only versioned packages with:

```sh
pnpm changeset publish
```

## Dependency Automation

Dependabot is enabled for weekly npm and GitHub Actions updates. Patch and minor updates can be merged when CI is green.

Semver-major npm updates are intentionally ignored by Dependabot. Open a human-owned migration issue/PR for those updates, run the full release gate, and document any required user migration.

If a Dependabot PR fails CI, either:

- fix the PR and merge it with green checks, or
- close it with a comment explaining the blocker and create a follow-up issue.

## npm Trusted Publisher Setup

Each public npm package must be configured on npmjs.com:

- Publisher: GitHub Actions
- Owner/repository: `eidentic/eidentic`
- Workflow filename: `publish.yml`
- Allowed action: `npm publish`

The workflow must keep `id-token: write`, use GitHub-hosted runners, and must not set
`NODE_AUTH_TOKEN` for the publish step. If npm is configured with a GitHub environment name,
add the same `environment` to the publish job.

## Emergency Local Publish

Avoid this. Local publishes lose the normal OIDC/provenance path and are easier to botch.
If infrastructure is broken and maintainers explicitly choose to publish locally, run the
same gate first and publish only from a clean, versioned release commit.

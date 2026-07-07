# Launch Feedback Triage

Use this loop during the v1 launch window so feedback from Product Hunt, GitHub, npm, Discord, email, and social threads turns into tracked engineering work.

## Daily Loop

Run this once per launch day, ideally at the same time:

1. Sweep all feedback sources and copy reproducible reports into GitHub issues.
2. Label each issue with `v1` and one priority: `p0`, `p1`, or `p2`.
3. Assign an owner or write `owner-needed` in the issue body.
4. Comment with the current status: `investigating`, `fixed in <sha/pr>`, `needs reproduction`, or `deferred`.
5. Re-run the fresh-install smoke and release gate after any install, packaging, docs, or public API fix.

## Priority Rules

`p0` means do not tag v1 while this is open:

- Fresh install fails on a supported package manager.
- README or quickstart code is wrong for the latest published package.
- Security posture is materially weaker than documented.
- Data isolation, auth, quota, rate-limit, erasure, or durability claims are false.
- CI, cross-runtime smoke, or `pnpm run release:check -- --skip-install` fails on `main`.

`p1` means strongly desired before v1, but may be explicitly deferred with a rationale:

- Confusing docs that do not break execution.
- Performance/bundle regressions with a workaround.
- Missing observability for a non-critical path.
- Dependency migration decisions that are safe to defer because the current supported range is green.

`p2` means post-v1 backlog:

- New adapters or integrations.
- Product/UI polish.
- Research features and broader ecosystem compatibility.

## Issue Template

```markdown
## Source
Where did this come from? Link if public.

## User impact
Who is blocked or confused?

## Reproduction
Exact commands, package manager, Node/Bun/Deno version, OS, and output.

## Current status
investigating | fixed in <sha/pr> | needs reproduction | deferred

## Release decision
block v1 | defer with rationale | post-v1
```

## Verification Commands

Local release gate:

```bash
pnpm run release:check -- --skip-install
```

Cross-runtime smoke:

```bash
pnpm -r build
node scripts/runtime-smoke.mjs
bun run scripts/runtime-smoke.mjs
deno run --allow-read --allow-env scripts/runtime-smoke.mjs
```

Fresh install smoke:

```bash
node scripts/fresh-install-smoke.mjs --package eidentic
```

When testing unpublished release candidates, pass the packed tarball path:

```bash
node scripts/fresh-install-smoke.mjs --package ./eidentic-1.0.0.tgz
```

## Closeout

Before tagging v1:

- No open `p0` issues in the `v1.0` milestone.
- Every open `p1` issue has an owner and an explicit release decision.
- The latest launch-feedback sweep is linked from the release PR or release issue.
- Fresh install smoke and release gate outputs are pasted into the release PR or issue.

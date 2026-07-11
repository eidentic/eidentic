# Spec: Agent Project Format and Local Development

## Objective

Make the first Eidentic agent runnable in under ten minutes from a readable directory while
preserving the existing programmatic `eidentic.config.*` API. A project may start with
`agent/instructions.md`; optional TypeScript files add model/runtime configuration, tools, skills,
and subagents. The same project remains portable across supported deployment targets.

## User and success measures

The primary user is a TypeScript developer building a production agent without accepting a single
cloud dependency. Success means:

- a scaffolded project starts through `eidentic dev` without hand-registering discovered files;
- existing `eidentic.config.ts` projects continue to load unchanged;
- discovery is deterministic, rejects unsafe/ambiguous layouts, and never executes files outside
  the selected project root;
- the terminal supports an interactive conversation and a readable live event timeline;
- generated projects typecheck, build, and pass packed ESM consumer smoke tests.

## Project contract

```text
agent/
  instructions.md        # required when using directory mode
  agent.ts                # optional runtime overrides
  tools/                  # optional TypeScript tool modules
  skills/                 # optional SKILL.md-compatible prompt skills
  subagents/              # optional nested agent directories
```

The first release discovers instructions, optional agent configuration, and tool modules. Skills
and subagent directories are part of the stable layout but become executable only when their
dedicated slices land; unknown files are ignored. A root `eidentic.config.*` remains authoritative
when present. Directory mode is selected only when no legacy config exists or when explicitly
requested.

## Public interfaces

- `resolveProject(cwd, explicit?)` returns a discriminated `config` or `directory` project.
- `loadProject(project)` returns the existing `EidenticConfig` shape consumed by server and Studio.
- Existing `resolveConfigPath` and `loadConfig` remain supported.
- Directory runtime overrides use a small additive contract; they cannot replace authentication or
  silently enable unsafe server options.

## Commands

```bash
pnpm --filter @eidentic/cli test
pnpm --filter @eidentic/cli typecheck
pnpm --filter @eidentic/cli typecheck:templates
pnpm test
pnpm release:check -- --skip-install
```

## Testing strategy

- Unit tests cover path resolution, precedence, validation, deterministic ordering, symlink escape,
  file-size limits, and malformed modules.
- Integration tests load generated projects and query a real in-memory agent with a mock model.
- CLI process tests cover interactive input, event rendering, reload shutdown, signals, and errors.
- Template and packed-consumer gates prove published artifacts work under supported module modes.

## Threat model and boundaries

Trust boundaries are the filesystem project, dynamically imported modules, terminal input, and
agent event output. Assets include credentials, arbitrary code execution authority, tenant data,
and terminal integrity.

- Always: canonicalize project roots, reject symlink escapes, cap instruction/module discovery,
  use deterministic ordering, redact terminal output, and close stores/processes on reload.
- Ask first: new runtime dependencies, authentication changes, remote module loading, or executing
  modules outside the project root.
- Never: automatically load `.env` from a parent directory, print credentials, follow untrusted
  symlinks, enable `NoAuth` for a public listener, or remove legacy config compatibility.

## Delivery tasks

1. Define project resolver/loader contracts and failing security/compatibility tests.
2. Implement directory instructions and optional runtime module loading.
3. Add deterministic tool discovery and generated project templates.
4. Add interactive `dev` conversation, event renderer, and live reload lifecycle.
5. Run focused and full release gates; perform code/security review.
6. Publish the SDK release, then update and deploy `eidentic/docs` from the published API.

## Not in this release

- Hosted Eidentic control plane or deployment service.
- Slack/Teams channels, approval inbox, schedules, or connection management.
- A new durable engine, secret vault, tracing standard, or model gateway.
- Removing or changing the semantics of `eidentic.config.*`.


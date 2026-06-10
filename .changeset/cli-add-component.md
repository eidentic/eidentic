---
"@eidentic/cli": minor
---

Add `eidentic add component <name>` command to copy pre-built UI components into a project. Ships three Tailwind v4 shadcn-style components under `templates/components/`: `chat` (full chat UI on `useAgent`/`useEidenticStream`), `workflow-trace` (indented step-trace tree on `useWorkflowRun`), and `run-status` (polling status panel on `useAsyncRun`/`useRunStatus`). Installs to `components/eidentic/<name>.tsx` by default; supports `--force`, `--dir`, and `--cwd`. Lists available names on unknown input and refuses collisions without `--force`. Templates are versioned in the package, included in `files`, and typechecked at build time via a dedicated `tsconfig.templates.json`.

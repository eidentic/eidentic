---
"@eidentic/studio": patch
---

Internal refactor: replace studio's private workflow-run registry with the canonical `createWorkflowRunRegistry` from `@eidentic/workflow`. Moves `@eidentic/workflow` from devDependencies to dependencies. No public API changes.

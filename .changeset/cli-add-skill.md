---
"@eidentic/cli": minor
---

Add `eidentic add skill <source>` command to install skills into a project's local skills directory (`skills/<name>/`). Supports local path sources and name-based resolution via an injectable `--from` directory resolver. Validates the SKILL.md schema before installing, refuses collisions unless `--force`, copies all skill files (excluding the `.memory.md` runtime artefact), and exits non-zero with a clear message on any failure.

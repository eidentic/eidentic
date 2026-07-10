---
"@eidentic/workflow": patch
---

Fail fast on invalid workflow numeric options, clean up retry cancellation listeners after normal
completion, and harden the file run store with owner-only permissions, random fsynced atomic
writes, cross-process locking, and symlink-safe path validation.

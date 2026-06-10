---
"@eidentic/tools": patch
"@eidentic/rag": patch
---

Fix SSRF vulnerability in `@eidentic/rag` `ingestDocument({ url })`.

**`@eidentic/tools`**: add `assertFetchableUrl(rawUrl, opts?)` — a reusable safe-URL guard that
parses the URL, rejects non-http(s) schemes, rejects private/loopback/link-local/metadata hosts
via the existing `isBlockedHost`, and optionally enforces a hostname allowlist via `hostAllowed`.
Exported from the package index alongside the existing helpers.

**`@eidentic/rag`**: `ingestDocument({ url })` now calls `assertFetchableUrl` before any network
I/O, blocking requests to cloud-metadata endpoints (e.g. `169.254.169.254`), localhost, RFC-1918
ranges, and IPv6-mapped private addresses. Redirects are now fetched with `redirect: "manual"` and
the redirect target is re-validated with the same guard before following (SSRF redirect defense).
A new optional `allowlist` field on `IngestDocumentOptions` allows callers to further restrict
which hosts may be fetched.

# Security Policy

## Supported versions

| Version | Supported |
|---------|-----------|
| 0.x (latest) | Yes |

Only the latest published 0.x release receives security fixes. Once v1.0 ships, the support window will be updated accordingly.

## Reporting a vulnerability

**Please do not open a public GitHub issue for security-sensitive reports.**

Use one of the following channels:

1. **GitHub private vulnerability reporting** — open a [Security Advisory](https://github.com/eidentic/eidentic/security/advisories/new) directly on this repository. This keeps the report confidential until a fix is ready.
2. **Email** — send details to [info@baranozdemir.com](mailto:info@baranozdemir.com) with the subject line `[eidentic] Security report`.

Please include a description of the issue, steps to reproduce, and any proof-of-concept code if available.

## Response expectations

- **Triage:** we aim to acknowledge receipt and confirm scope within **72 hours**.
- **Fix and disclosure:** we coordinate a fix and agree a disclosure timeline with the reporter. We follow responsible disclosure — please allow reasonable time to patch before publishing details publicly.

## Scope notes

- **Server deployments:** if you are running `@eidentic/server` (the optional HTTP service mode), review the production checklist in the [README](README.md) before exposing the service publicly. In particular: enable authentication, set `EIDENTIC_HMAC_SECRET` for webhook signature verification, and run behind a TLS-terminating reverse proxy.
- **Client-side / browser use:** Eidentic is designed for server-side use. Running agent code in untrusted browser contexts is out of scope.
- **Dependencies:** vulnerabilities in third-party dependencies (e.g. `better-sqlite3`, `ai`) should be reported to their respective maintainers. We will update pinned versions promptly when upstream fixes are available.

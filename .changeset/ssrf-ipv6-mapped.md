---
"@eidentic/tools": patch
---

Harden `isBlockedHost` (web_fetch SSRF guard): block IPv6-mapped/compatible IPv4
(`::ffff:169.254.169.254`, hex `::ffff:a9fe:a9fe`, `::1.2.3.4`), IPv6 unspecified (`::`),
and link-local `fe80::/10` — previously these forms bypassed the private-IP check and could
reach cloud-metadata/internal hosts. Documented the residual DNS-rebinding limitation (the
check is syntactic; use an egress proxy for untrusted-input deployments).

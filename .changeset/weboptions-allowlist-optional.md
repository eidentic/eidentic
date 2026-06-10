---
"@eidentic/tools": patch
---

`webTools` — make `allowlist` optional. Previously every caller had to pass an egress
allowlist even when they only wanted `web_search` (which doesn't use it). Now:
omitted = no domain restriction (any public host); `[]` = explicit deny-all lockdown;
non-empty = restrict to those hosts. The SSRF guard (`isBlockedHost`) still rejects
private/loopback/metadata hosts in every mode.

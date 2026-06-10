---
"@eidentic/rag": patch
"@eidentic/mcp": patch
---

Security hardening: SSRF redirect-chain bypass in `ingestDocument`, OAuth refresh-token loss, and OAuth endpoint scheme validation.

**@eidentic/rag — FIX 1 (A-P1, SSRF): Redirect-chain bypass in `ingestDocument`.** Previously, after validating and following the first redirect, subsequent hops were issued with `redirect:"follow"` — the platform transparently followed any further redirects (including to internal/metadata addresses) without re-running `assertFetchableUrl`. Now every hop in the redirect chain is issued with `redirect:"manual"` and each `Location` header is re-validated before following, up to a bounded hop count of 5. A redirect to `169.254.169.254`, `127.0.0.1`, or any other blocked address on hop 2+ is now rejected. Exceeding the hop limit also rejects to prevent redirect-loop DoS.

**@eidentic/rag — FIX 4 (C-P2): Plain string `ingestDocument` URL misuse warning.** A plain `string` source is raw text — no fetch occurs. A `console.warn` is now emitted when the string starts with `http://` or `https://`, since this is almost certainly a misuse (caller probably meant `{ url: "..." }`). Existing behavior is unchanged.

**@eidentic/mcp — FIX 2 (A-P2): OAuth refresh token dropped on refresh.** When the authorization server's refresh response omits `refresh_token` (permitted by RFC 6749 §6), the prior refresh token is now preserved: `this.tokens = { ...fresh, refreshToken: fresh.refreshToken ?? this.tokens.refreshToken }`. Without this fix, a user was silently logged out when the next expiry cycle triggered a refresh against a now-dropped token. Token rotation (server provides a new refresh token) continues to work correctly.

**@eidentic/mcp — FIX 3 (A-P2): OAuth endpoint scheme validation.** `beginAuthorizationFlow` and `OAuthConnection` constructor now validate that `authorizationEndpoint` and `tokenEndpoint` use `https:` (OAuth 2.1 mandates HTTPS for all server endpoints) and that `redirectUri` is `https:` or a loopback `http:` address (`localhost`, `127.0.0.1`, `[::1]` — the OAuth 2.1 native-app exception). An `http://evil.com` token endpoint or redirect URI is now rejected at configuration time with a clear error message.

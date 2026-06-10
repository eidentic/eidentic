---
"@eidentic/mcp": minor
---

OAuth 2.1 + PKCE client auth for connecting to protected MCP servers.

**New API (`src/oauth.ts`):**

- `generateCodeVerifier()` — cryptographically-random PKCE code_verifier (48 bytes → 64-char base64url).
- `deriveCodeChallenge(verifier)` — `BASE64URL(SHA256(verifier))` per RFC 7636 §4.2 (S256 method). Uses `globalThis.crypto.subtle` — zero-config on Node 18+, Bun, Deno, and Cloudflare Workers.
- `base64urlEncode(bytes)` — RFC 4648 §5 base64url with no padding.
- `generateState()` — 32-byte CSRF state token.
- `beginAuthorizationFlow(config)` — builds the authorization URL with PKCE challenge, state, redirect_uri, and scope, and returns `{ authorizationUrl, state, codeVerifier }`.
- `completeAuthorizationFlow(config, code, verifier, returnedState, expectedState)` — validates state (CSRF guard, constant-time comparison), then exchanges the code + verifier for tokens at the token endpoint.
- `refreshAccessToken(config, refreshToken)` — RFC 6749 §6 refresh grant.
- `OAuthConnection` — manages in-memory bearer tokens; `setTokens()` / `hasTokens()` / `getAuthorizationHeader()` (auto-refreshes when expired with 30-second buffer) / `loadFromStore()`. Accepts an optional `OAuthTokenStore` hook for persist/restore across process restarts.
- `OAuthStateError` — thrown on state mismatch (CSRF).
- `OAuthTokenError` — thrown on token exchange/refresh failure.

**`streamableHttpClient` updated:** new `opts.oauth?: OAuthConnection` — `getAuthorizationHeader()` is called and injected before each connection; merged with static `opts.headers`.

**Security:**
- Tokens and code_verifiers are never logged.
- `state` is validated with a constant-time XOR comparison before the token exchange.
- Only authorization-code + PKCE flow — no implicit flow.
- Discovery (`/.well-known/oauth-protected-resource`) deferred — explicit endpoints required.

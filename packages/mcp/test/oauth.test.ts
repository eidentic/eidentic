/**
 * Unit tests for OAuth 2.1 + PKCE client auth (@eidentic/mcp).
 *
 * Covers:
 *   - PKCE challenge derivation against known RFC 7636 test vectors
 *   - base64urlEncode correctness
 *   - generateCodeVerifier / generateState randomness + length
 *   - beginAuthorizationFlow — URL construction (all required params)
 *   - completeAuthorizationFlow — state validation (CSRF guard) + token exchange request shape
 *   - refreshAccessToken — request shape + response parsing
 *   - OAuthConnection — hasTokens, getAuthorizationHeader, auto-refresh, token-store hook
 *   - OAuthStateError / OAuthTokenError
 *
 * All HTTP is mocked — no real network requests are made.
 */
import { describe, it, expect, vi } from "vitest";
import {
  base64urlEncode,
  generateCodeVerifier,
  generateState,
  deriveCodeChallenge,
  beginAuthorizationFlow,
  completeAuthorizationFlow,
  refreshAccessToken,
  OAuthConnection,
  OAuthStateError,
  OAuthTokenError,
  timingSafeEqual,
  type OAuthServerConfig,
  type OAuthTokens,
  type OAuthTokenStore,
} from "../src/oauth.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const TEST_CONFIG: OAuthServerConfig = {
  authorizationEndpoint: "https://auth.example.com/oauth/authorize",
  tokenEndpoint: "https://auth.example.com/oauth/token",
  clientId: "test-client-id",
  redirectUri: "https://app.example.com/callback",
  scope: "mcp:read mcp:write",
};

/** Build a minimal mock fetch that returns a JSON token response. */
function mockTokenFetch(tokens: Partial<OAuthTokens & { error?: string; error_description?: string }> = {}, status = 200): typeof fetch {
  return vi.fn().mockResolvedValue({
    ok: status >= 200 && status < 300,
    status,
    headers: { get: (_: string) => "application/json" },
    json: () =>
      Promise.resolve(
        status >= 200 && status < 300
          ? {
              access_token: tokens.accessToken ?? "access-token-abc",
              token_type: tokens.tokenType ?? "Bearer",
              expires_in: tokens.expiresIn,
              refresh_token: tokens.refreshToken,
            }
          : {
              error: tokens.error ?? "invalid_grant",
              error_description: tokens.error_description ?? "Token expired",
            },
      ),
    text: () => Promise.resolve(""),
  } as unknown as Response);
}

// ---------------------------------------------------------------------------
// base64urlEncode
// ---------------------------------------------------------------------------
describe("base64urlEncode", () => {
  it("produces URL-safe base64 with no padding", () => {
    // A byte sequence that would produce +/= in standard base64.
    const bytes = new Uint8Array([0xfb, 0xff, 0xfe]);
    const result = base64urlEncode(bytes);
    expect(result).not.toContain("+");
    expect(result).not.toContain("/");
    expect(result).not.toContain("=");
    expect(result).toMatch(/^[A-Za-z0-9_-]+$/);
  });

  it("encodes an empty buffer to an empty string", () => {
    expect(base64urlEncode(new Uint8Array(0))).toBe("");
  });

  it("matches a known vector: 0x00 0x00 0x00 → AAAA", () => {
    // Standard base64 of [0,0,0] = "AAAA" (no +/= involved).
    expect(base64urlEncode(new Uint8Array([0x00, 0x00, 0x00]))).toBe("AAAA");
  });
});

// ---------------------------------------------------------------------------
// PKCE — RFC 7636 known test vector
// ---------------------------------------------------------------------------
describe("deriveCodeChallenge (PKCE S256)", () => {
  /**
   * RFC 7636 Appendix B test vector:
   *   verifier  = "dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk"
   *   challenge = "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM"
   */
  it("matches the RFC 7636 Appendix B test vector", async () => {
    const verifier = "dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk";
    const challenge = await deriveCodeChallenge(verifier);
    expect(challenge).toBe("E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM");
  });

  it("produces a base64url string with no +/= characters", async () => {
    const verifier = generateCodeVerifier();
    const challenge = await deriveCodeChallenge(verifier);
    expect(challenge).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(challenge).not.toContain("=");
  });

  it("SHA-256 output is 32 bytes → 43-char base64url (no padding)", async () => {
    // 32 bytes base64url-encoded = ceil(32 * 4/3) = 43 chars (no padding).
    const challenge = await deriveCodeChallenge("any-verifier");
    expect(challenge.length).toBe(43);
  });
});

// ---------------------------------------------------------------------------
// generateCodeVerifier
// ---------------------------------------------------------------------------
describe("generateCodeVerifier", () => {
  it("returns a 64-character string (48 bytes → base64url)", () => {
    // 48 bytes * 4/3 = 64 chars (no padding needed, since 48 % 3 === 0).
    const v = generateCodeVerifier();
    expect(v.length).toBe(64);
  });

  it("only contains base64url-safe characters", () => {
    const v = generateCodeVerifier();
    expect(v).toMatch(/^[A-Za-z0-9_-]+$/);
  });

  it("two calls produce different values (entropy check)", () => {
    const a = generateCodeVerifier();
    const b = generateCodeVerifier();
    expect(a).not.toBe(b);
  });
});

// ---------------------------------------------------------------------------
// generateState
// ---------------------------------------------------------------------------
describe("generateState", () => {
  it("produces a non-empty base64url string", () => {
    const s = generateState();
    expect(s.length).toBeGreaterThan(0);
    expect(s).toMatch(/^[A-Za-z0-9_-]+$/);
  });

  it("two calls produce different values", () => {
    expect(generateState()).not.toBe(generateState());
  });
});

// ---------------------------------------------------------------------------
// beginAuthorizationFlow — URL construction
// ---------------------------------------------------------------------------
describe("beginAuthorizationFlow", () => {
  it("includes all required OAuth 2.1 + PKCE parameters", async () => {
    const { authorizationUrl, state, codeVerifier } = await beginAuthorizationFlow(TEST_CONFIG);
    const url = new URL(authorizationUrl);
    expect(url.searchParams.get("response_type")).toBe("code");
    expect(url.searchParams.get("client_id")).toBe(TEST_CONFIG.clientId);
    expect(url.searchParams.get("redirect_uri")).toBe(TEST_CONFIG.redirectUri);
    expect(url.searchParams.get("code_challenge_method")).toBe("S256");
    expect(url.searchParams.get("scope")).toBe(TEST_CONFIG.scope);
    // code_challenge must match the verifier
    const expectedChallenge = await deriveCodeChallenge(codeVerifier);
    expect(url.searchParams.get("code_challenge")).toBe(expectedChallenge);
    // state must be present and match what was returned
    expect(url.searchParams.get("state")).toBe(state);
  });

  it("state is included in the URL and returned in the bag", async () => {
    const { authorizationUrl, state } = await beginAuthorizationFlow(TEST_CONFIG);
    const url = new URL(authorizationUrl);
    expect(url.searchParams.get("state")).toBe(state);
    expect(state.length).toBeGreaterThan(8);
  });

  it("omits scope parameter when config.scope is not set", async () => {
    const configNoScope: OAuthServerConfig = { ...TEST_CONFIG, scope: undefined };
    const { authorizationUrl } = await beginAuthorizationFlow(configNoScope);
    const url = new URL(authorizationUrl);
    expect(url.searchParams.has("scope")).toBe(false);
  });

  it("base URL is the authorization endpoint", async () => {
    const { authorizationUrl } = await beginAuthorizationFlow(TEST_CONFIG);
    const url = new URL(authorizationUrl);
    expect(`${url.origin}${url.pathname}`).toBe(TEST_CONFIG.authorizationEndpoint);
  });

  it("two calls produce different state and verifier", async () => {
    const a = await beginAuthorizationFlow(TEST_CONFIG);
    const b = await beginAuthorizationFlow(TEST_CONFIG);
    expect(a.state).not.toBe(b.state);
    expect(a.codeVerifier).not.toBe(b.codeVerifier);
  });
});

// ---------------------------------------------------------------------------
// completeAuthorizationFlow — state validation (CSRF guard)
// ---------------------------------------------------------------------------
describe("completeAuthorizationFlow — state mismatch rejection", () => {
  it("throws OAuthStateError when returned state does not match expected state", async () => {
    const fetch = mockTokenFetch();
    await expect(
      completeAuthorizationFlow(
        TEST_CONFIG,
        "auth-code-123",
        "verifier-abc",
        "evil-state",
        "expected-state",
        fetch as unknown as typeof globalThis.fetch,
      ),
    ).rejects.toThrow(OAuthStateError);
  });

  it("throws OAuthStateError with CSRF message", async () => {
    const fetch = mockTokenFetch();
    await expect(
      completeAuthorizationFlow(
        TEST_CONFIG,
        "code",
        "verifier",
        "wrong-state",
        "right-state",
        fetch as unknown as typeof globalThis.fetch,
      ),
    ).rejects.toThrow(/CSRF/i);
  });

  it("does NOT call fetch when state mismatches", async () => {
    const fetch = mockTokenFetch();
    await completeAuthorizationFlow(
      TEST_CONFIG,
      "code",
      "verifier",
      "x",
      "y",
      fetch as unknown as typeof globalThis.fetch,
    ).catch(() => { /* expected */ });
    expect(fetch).not.toHaveBeenCalled();
  });

  it("succeeds when state matches and exchange succeeds", async () => {
    const fetch = mockTokenFetch({ accessToken: "tok-ok", refreshToken: "ref-ok" });
    const tokens = await completeAuthorizationFlow(
      TEST_CONFIG,
      "auth-code-xyz",
      "verifier-xyz",
      "same-state",
      "same-state",
      fetch as unknown as typeof globalThis.fetch,
    );
    expect(tokens.accessToken).toBe("tok-ok");
    expect(tokens.refreshToken).toBe("ref-ok");
  });
});

// ---------------------------------------------------------------------------
// completeAuthorizationFlow — token exchange request shape
// ---------------------------------------------------------------------------
describe("completeAuthorizationFlow — token exchange request shape", () => {
  it("sends a POST to the token endpoint with correct grant_type and PKCE params", async () => {
    const fetch = mockTokenFetch({ accessToken: "at", expiresIn: 3600 });
    await completeAuthorizationFlow(
      TEST_CONFIG,
      "code-abc",
      "verifier-abc",
      "st",
      "st",
      fetch as unknown as typeof globalThis.fetch,
    );

    expect(fetch).toHaveBeenCalledOnce();
    const [url, init] = (fetch as ReturnType<typeof vi.fn>).mock.calls[0]!;
    expect(url).toBe(TEST_CONFIG.tokenEndpoint);
    expect(init.method).toBe("POST");
    expect(init.headers["Content-Type"]).toBe("application/x-www-form-urlencoded");

    const body = new URLSearchParams(init.body as string);
    expect(body.get("grant_type")).toBe("authorization_code");
    expect(body.get("code")).toBe("code-abc");
    expect(body.get("code_verifier")).toBe("verifier-abc");
    expect(body.get("redirect_uri")).toBe(TEST_CONFIG.redirectUri);
    expect(body.get("client_id")).toBe(TEST_CONFIG.clientId);
  });

  it("parses expiresIn and computes expiresAt", async () => {
    const before = Date.now();
    const fetch = mockTokenFetch({ expiresIn: 3600 });
    const tokens = await completeAuthorizationFlow(
      TEST_CONFIG, "c", "v", "s", "s",
      fetch as unknown as typeof globalThis.fetch,
    );
    const after = Date.now();
    expect(tokens.expiresIn).toBe(3600);
    expect(tokens.expiresAt).toBeGreaterThanOrEqual(before + 3600 * 1000);
    expect(tokens.expiresAt).toBeLessThanOrEqual(after + 3600 * 1000);
  });

  it("throws OAuthTokenError on HTTP error response", async () => {
    const fetch = mockTokenFetch({ error: "invalid_grant", error_description: "Code expired" }, 400);
    await expect(
      completeAuthorizationFlow(
        TEST_CONFIG, "bad-code", "v", "s", "s",
        fetch as unknown as typeof globalThis.fetch,
      ),
    ).rejects.toThrow(OAuthTokenError);
  });

  it("error message includes the server error code and description", async () => {
    const fetch = mockTokenFetch({ error: "invalid_grant", error_description: "Code expired" }, 400);
    await expect(
      completeAuthorizationFlow(
        TEST_CONFIG, "c", "v", "s", "s",
        fetch as unknown as typeof globalThis.fetch,
      ),
    ).rejects.toThrow(/invalid_grant.*Code expired/i);
  });
});

// ---------------------------------------------------------------------------
// refreshAccessToken — request shape
// ---------------------------------------------------------------------------
describe("refreshAccessToken", () => {
  it("sends a POST with grant_type=refresh_token to the token endpoint", async () => {
    const fetch = mockTokenFetch({ accessToken: "fresh-token" });
    await refreshAccessToken(
      TEST_CONFIG,
      "refresh-tok-123",
      fetch as unknown as typeof globalThis.fetch,
    );

    const [url, init] = (fetch as ReturnType<typeof vi.fn>).mock.calls[0]!;
    expect(url).toBe(TEST_CONFIG.tokenEndpoint);
    expect(init.method).toBe("POST");

    const body = new URLSearchParams(init.body as string);
    expect(body.get("grant_type")).toBe("refresh_token");
    expect(body.get("refresh_token")).toBe("refresh-tok-123");
    expect(body.get("client_id")).toBe(TEST_CONFIG.clientId);
  });

  it("returns fresh tokens including the new access_token", async () => {
    const fetch = mockTokenFetch({ accessToken: "new-access", refreshToken: "new-refresh" });
    const tokens = await refreshAccessToken(
      TEST_CONFIG,
      "old-refresh",
      fetch as unknown as typeof globalThis.fetch,
    );
    expect(tokens.accessToken).toBe("new-access");
    expect(tokens.refreshToken).toBe("new-refresh");
  });

  it("throws OAuthTokenError when the refresh token is rejected", async () => {
    const fetch = mockTokenFetch({ error: "invalid_grant" }, 400);
    await expect(
      refreshAccessToken(
        TEST_CONFIG,
        "expired-refresh",
        fetch as unknown as typeof globalThis.fetch,
      ),
    ).rejects.toThrow(OAuthTokenError);
  });
});

// ---------------------------------------------------------------------------
// OAuthConnection
// ---------------------------------------------------------------------------
describe("OAuthConnection", () => {
  it("hasTokens() returns false before setTokens()", async () => {
    const conn = new OAuthConnection(TEST_CONFIG);
    expect(conn.hasTokens()).toBe(false);
  });

  it("hasTokens() returns true after setTokens()", async () => {
    const conn = new OAuthConnection(TEST_CONFIG);
    await conn.setTokens({
      accessToken: "tok-abc",
      tokenType: "Bearer",
    });
    expect(conn.hasTokens()).toBe(true);
  });

  it("getAuthorizationHeader() throws OAuthTokenError when no tokens set", async () => {
    const conn = new OAuthConnection(TEST_CONFIG);
    await expect(conn.getAuthorizationHeader()).rejects.toThrow(OAuthTokenError);
  });

  it("getAuthorizationHeader() returns 'Bearer <token>'", async () => {
    const conn = new OAuthConnection(TEST_CONFIG);
    await conn.setTokens({ accessToken: "my-secret-token", tokenType: "Bearer" });
    const header = await conn.getAuthorizationHeader();
    expect(header).toBe("Bearer my-secret-token");
  });

  it("normalises tokenType case to 'Bearer'", async () => {
    const conn = new OAuthConnection(TEST_CONFIG);
    await conn.setTokens({ accessToken: "tok", tokenType: "bearer" });
    expect(await conn.getAuthorizationHeader()).toBe("Bearer tok");
  });

  it("automatically refreshes when token is expired and refreshToken is present", async () => {
    const mockFetch = mockTokenFetch({ accessToken: "fresh-tok", tokenType: "Bearer" });
    const conn = new OAuthConnection(TEST_CONFIG, { fetch: mockFetch as unknown as typeof globalThis.fetch });

    // Set an already-expired token (expiresAt in the past).
    await conn.setTokens({
      accessToken: "old-tok",
      tokenType: "Bearer",
      refreshToken: "ref-tok",
      expiresAt: Date.now() - 1000, // already expired
    });

    const header = await conn.getAuthorizationHeader();
    expect(header).toBe("Bearer fresh-tok");
    expect(mockFetch).toHaveBeenCalledOnce();

    // Verify it was a refresh grant
    const body = new URLSearchParams((mockFetch as ReturnType<typeof vi.fn>).mock.calls[0]![1].body);
    expect(body.get("grant_type")).toBe("refresh_token");
    expect(body.get("refresh_token")).toBe("ref-tok");
  });

  it("does NOT refresh when token is still valid (not near expiry)", async () => {
    const mockFetch = vi.fn();
    const conn = new OAuthConnection(TEST_CONFIG, { fetch: mockFetch as unknown as typeof globalThis.fetch });

    await conn.setTokens({
      accessToken: "valid-tok",
      tokenType: "Bearer",
      refreshToken: "ref-tok",
      expiresAt: Date.now() + 120_000, // 2 minutes from now (outside 30s buffer)
    });

    const header = await conn.getAuthorizationHeader();
    expect(header).toBe("Bearer valid-tok");
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it("does NOT refresh when token is expired but no refreshToken is available", async () => {
    const mockFetch = vi.fn();
    const conn = new OAuthConnection(TEST_CONFIG, { fetch: mockFetch as unknown as typeof globalThis.fetch });

    await conn.setTokens({
      accessToken: "expired-tok",
      tokenType: "Bearer",
      // no refreshToken
      expiresAt: Date.now() - 5000,
    });

    // Should return the expired token without attempting refresh
    const header = await conn.getAuthorizationHeader();
    expect(header).toBe("Bearer expired-tok");
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it("calls tokenStore.save() when setTokens() is called", async () => {
    const store: OAuthTokenStore = {
      save: vi.fn(),
      load: vi.fn().mockReturnValue(null),
    };
    const conn = new OAuthConnection(TEST_CONFIG, { tokenStore: store });
    const tokens: OAuthTokens = { accessToken: "t", tokenType: "Bearer" };
    await conn.setTokens(tokens);
    expect(store.save).toHaveBeenCalledWith(tokens);
  });

  it("calls tokenStore.save() after auto-refresh", async () => {
    const store: OAuthTokenStore = {
      save: vi.fn(),
      load: vi.fn().mockReturnValue(null),
    };
    const mockFetch = mockTokenFetch({ accessToken: "refreshed", tokenType: "Bearer" });
    const conn = new OAuthConnection(TEST_CONFIG, {
      tokenStore: store,
      fetch: mockFetch as unknown as typeof globalThis.fetch,
    });

    await conn.setTokens({
      accessToken: "old",
      tokenType: "Bearer",
      refreshToken: "ref",
      expiresAt: Date.now() - 1000,
    });

    // setTokens already called save once — clear mock.
    (store.save as ReturnType<typeof vi.fn>).mockClear();

    await conn.getAuthorizationHeader();
    expect(store.save).toHaveBeenCalledOnce();
    const saved = (store.save as ReturnType<typeof vi.fn>).mock.calls[0]![0] as OAuthTokens;
    expect(saved.accessToken).toBe("refreshed");
  });

  it("loadFromStore() restores previously persisted tokens", async () => {
    const storedTokens: OAuthTokens = { accessToken: "persisted-tok", tokenType: "Bearer" };
    const store: OAuthTokenStore = {
      save: vi.fn(),
      load: vi.fn().mockReturnValue(storedTokens),
    };
    const conn = new OAuthConnection(TEST_CONFIG, { tokenStore: store });
    expect(conn.hasTokens()).toBe(false);
    await conn.loadFromStore();
    expect(conn.hasTokens()).toBe(true);
    expect(await conn.getAuthorizationHeader()).toBe("Bearer persisted-tok");
  });

  it("loadFromStore() is a no-op when store.load() returns null", async () => {
    const store: OAuthTokenStore = {
      save: vi.fn(),
      load: vi.fn().mockReturnValue(null),
    };
    const conn = new OAuthConnection(TEST_CONFIG, { tokenStore: store });
    await conn.loadFromStore();
    expect(conn.hasTokens()).toBe(false);
  });

  it("loadFromStore() is a no-op when no store is provided", async () => {
    const conn = new OAuthConnection(TEST_CONFIG);
    await conn.loadFromStore(); // must not throw
    expect(conn.hasTokens()).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// FIX 2: OAuthConnection — refresh token preserved when server omits it (RFC 6749 §6)
// ---------------------------------------------------------------------------
describe("OAuthConnection — refresh token preservation on refresh (FIX 2)", () => {
  /**
   * Attack scenario (token loss): When a refresh response omits `refresh_token`
   * (allowed by RFC 6749 §6), the prior refresh token must be kept. Without this fix,
   * a user is silently logged out on their next session refresh — they must re-authorize.
   */
  it("preserves the old refresh token when refresh response omits refresh_token", async () => {
    // Mock: server returns a NEW access token but NO refresh_token in the refresh response
    const mockFetch = mockTokenFetch({
      accessToken: "new-access-token",
      tokenType: "Bearer",
      expiresIn: 3600,
      // refreshToken is intentionally omitted — simulates RFC 6749 §6 server behavior
    });
    const conn = new OAuthConnection(TEST_CONFIG, { fetch: mockFetch as unknown as typeof globalThis.fetch });

    await conn.setTokens({
      accessToken: "old-access-token",
      tokenType: "Bearer",
      refreshToken: "original-refresh-token",
      expiresAt: Date.now() - 5000, // expired — triggers refresh
    });

    // Trigger auto-refresh via getAuthorizationHeader
    const header = await conn.getAuthorizationHeader();
    expect(header).toBe("Bearer new-access-token");

    // Now the connection MUST still have the original refresh token for next refresh
    // Force expiry again and do another refresh — it must use the preserved token
    const mockFetch2 = mockTokenFetch({
      accessToken: "second-new-access",
      tokenType: "Bearer",
    });
    // Bypass private field by casting to any — test-only hack to force expiry
    (conn as unknown as { tokens: OAuthTokens }).tokens.expiresAt = Date.now() - 1000;
    // Replace the fetch impl via a new connection wrapping same tokens
    const conn2 = new OAuthConnection(TEST_CONFIG, { fetch: mockFetch2 as unknown as typeof globalThis.fetch });
    await conn2.setTokens((conn as unknown as { tokens: OAuthTokens }).tokens);

    const header2 = await conn2.getAuthorizationHeader();
    expect(header2).toBe("Bearer second-new-access");

    // The refresh call to conn2 must use the PRESERVED original-refresh-token
    const body = new URLSearchParams((mockFetch2 as ReturnType<typeof vi.fn>).mock.calls[0]![1].body);
    expect(body.get("refresh_token")).toBe("original-refresh-token");
  });

  it("rotates the refresh token when the server provides a new one", async () => {
    // Mock: server returns BOTH new access and new refresh tokens (token rotation)
    const mockFetch = mockTokenFetch({
      accessToken: "rotated-access",
      tokenType: "Bearer",
      expiresIn: 3600,
      refreshToken: "rotated-refresh-token",
    });
    const conn = new OAuthConnection(TEST_CONFIG, { fetch: mockFetch as unknown as typeof globalThis.fetch });

    await conn.setTokens({
      accessToken: "old-access",
      tokenType: "Bearer",
      refreshToken: "old-refresh-token",
      expiresAt: Date.now() - 5000, // expired
    });

    await conn.getAuthorizationHeader();

    // The connection should now hold the NEW rotated refresh token
    const tokens = (conn as unknown as { tokens: OAuthTokens }).tokens;
    expect(tokens.refreshToken).toBe("rotated-refresh-token");
    expect(tokens.accessToken).toBe("rotated-access");
  });
});

// ---------------------------------------------------------------------------
// FIX 3: OAuth endpoint scheme validation (https: required; loopback allowed for redirect)
// ---------------------------------------------------------------------------
describe("OAuth endpoint scheme validation (FIX 3)", () => {
  /**
   * OAuth 2.1 mandates HTTPS for all authorization and token endpoints.
   * Allowing http:// would expose authorization codes and tokens to MITM attacks.
   */
  it("rejects an http:// token endpoint in beginAuthorizationFlow", async () => {
    const insecureConfig: OAuthServerConfig = {
      ...TEST_CONFIG,
      tokenEndpoint: "http://auth.example.com/oauth/token",
    };
    await expect(beginAuthorizationFlow(insecureConfig)).rejects.toThrow(/https/i);
  });

  it("rejects an http:// authorization endpoint in beginAuthorizationFlow", async () => {
    const insecureConfig: OAuthServerConfig = {
      ...TEST_CONFIG,
      authorizationEndpoint: "http://auth.example.com/oauth/authorize",
    };
    await expect(beginAuthorizationFlow(insecureConfig)).rejects.toThrow(/https/i);
  });

  it("accepts https:// endpoints in beginAuthorizationFlow", async () => {
    // Must not throw — https:// is valid
    const { authorizationUrl } = await beginAuthorizationFlow(TEST_CONFIG);
    expect(authorizationUrl).toMatch(/^https:\/\//);
  });

  it("rejects http:// redirectUri that is NOT loopback (e.g. http://evil.com/cb)", async () => {
    const insecureConfig: OAuthServerConfig = {
      ...TEST_CONFIG,
      redirectUri: "http://evil.com/callback",
    };
    await expect(beginAuthorizationFlow(insecureConfig)).rejects.toThrow(/https|redirect|loopback/i);
  });

  it("accepts http://localhost redirect URI (loopback is allowed by OAuth 2.1)", async () => {
    const localhostConfig: OAuthServerConfig = {
      ...TEST_CONFIG,
      redirectUri: "http://localhost:1234/callback",
    };
    // Must not throw
    const { authorizationUrl } = await beginAuthorizationFlow(localhostConfig);
    expect(authorizationUrl).toBeTruthy();
  });

  it("accepts http://127.0.0.1 redirect URI (loopback is allowed by OAuth 2.1)", async () => {
    const localhostConfig: OAuthServerConfig = {
      ...TEST_CONFIG,
      redirectUri: "http://127.0.0.1:8080/callback",
    };
    const { authorizationUrl } = await beginAuthorizationFlow(localhostConfig);
    expect(authorizationUrl).toBeTruthy();
  });

  it("rejects an http:// token endpoint in OAuthConnection constructor", () => {
    const insecureConfig: OAuthServerConfig = {
      ...TEST_CONFIG,
      tokenEndpoint: "http://auth.example.com/oauth/token",
    };
    expect(() => new OAuthConnection(insecureConfig)).toThrow(/https/i);
  });

  it("accepts an https:// token endpoint in OAuthConnection constructor", () => {
    // Must not throw
    expect(() => new OAuthConnection(TEST_CONFIG)).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// timingSafeEqual — digest-then-compare (M12)
// ---------------------------------------------------------------------------
describe("timingSafeEqual (digest-then-compare)", () => {
  it("returns true for identical strings", async () => {
    expect(await timingSafeEqual("hello", "hello")).toBe(true);
  });

  it("returns false for different strings of the same length", async () => {
    // Classic length-leak scenario: equal-length strings that differ only in content.
    expect(await timingSafeEqual("abc", "abd")).toBe(false);
  });

  it("returns false for strings of different lengths (no length leak via digest)", async () => {
    // Previously the hand-rolled version short-circuited on length mismatch;
    // the new implementation always hashes both sides first.
    expect(await timingSafeEqual("short", "much-longer-string")).toBe(false);
  });

  it("returns false for empty vs non-empty", async () => {
    expect(await timingSafeEqual("", "x")).toBe(false);
  });

  it("returns true for two empty strings", async () => {
    expect(await timingSafeEqual("", "")).toBe(true);
  });

  it("is not confused by strings that differ only in one byte", async () => {
    const a = "state-token-aaaaaa";
    const b = "state-token-aaaaab";
    expect(await timingSafeEqual(a, b)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Error classes
// ---------------------------------------------------------------------------
describe("OAuthStateError / OAuthTokenError", () => {
  it("OAuthStateError is an instance of Error", () => {
    const e = new OAuthStateError("oops");
    expect(e).toBeInstanceOf(Error);
    expect(e.name).toBe("OAuthStateError");
    expect(e.message).toBe("oops");
  });

  it("OAuthTokenError is an instance of Error", () => {
    const e = new OAuthTokenError("fail");
    expect(e).toBeInstanceOf(Error);
    expect(e.name).toBe("OAuthTokenError");
    expect(e.message).toBe("fail");
  });
});

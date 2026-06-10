/**
 * OAuth 2.1 + PKCE client for connecting to protected MCP servers.
 *
 * Implements the MCP authorization spec subset:
 *   - PKCE code_verifier / code_challenge (S256)
 *   - Authorization URL construction
 *   - Authorization-code ↔ token exchange
 *   - Refresh-token renewal
 *   - In-memory bearer token storage with an optional persist/inject hook
 *
 * Security invariants:
 *   - Tokens and verifiers are NEVER logged.
 *   - `state` is validated on callback (CSRF protection).
 *   - Only PKCE authorization-code flow — no implicit flow.
 *   - `crypto.subtle` (Web Crypto) used for SHA-256; `crypto.getRandomValues` for entropy.
 *     Both are available on Node 18+, Bun, Deno, and Cloudflare Workers with zero config.
 */

// ---------------------------------------------------------------------------
// PKCE primitives
// ---------------------------------------------------------------------------

/**
 * Generate a cryptographically-random PKCE `code_verifier`.
 * RFC 7636 §4.1: 43–128 characters from unreserved alphabet [A-Za-z0-9\-._~].
 * We generate 48 random bytes → 64-char base64url (well within range).
 */
export function generateCodeVerifier(): string {
  const bytes = new Uint8Array(48);
  globalThis.crypto.getRandomValues(bytes);
  return base64urlEncode(bytes);
}

/**
 * Derive `code_challenge = BASE64URL(SHA256(ASCII(code_verifier)))` (S256 method).
 * RFC 7636 §4.2.
 */
export async function deriveCodeChallenge(verifier: string): Promise<string> {
  const encoded = new TextEncoder().encode(verifier);
  const hashBuffer = await globalThis.crypto.subtle.digest("SHA-256", encoded);
  return base64urlEncode(new Uint8Array(hashBuffer));
}

/**
 * Encode a Uint8Array as base64url (RFC 4648 §5) — no padding, URL-safe alphabet.
 */
export function base64urlEncode(bytes: Uint8Array): string {
  // Use built-in btoa over a binary string, then convert to base64url.
  let binary = "";
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i]!);
  }
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

// ---------------------------------------------------------------------------
// State generation (CSRF protection)
// ---------------------------------------------------------------------------

/**
 * Generate a cryptographically-random `state` string for CSRF protection.
 * 32 bytes → 43-char base64url.
 */
export function generateState(): string {
  const bytes = new Uint8Array(32);
  globalThis.crypto.getRandomValues(bytes);
  return base64urlEncode(bytes);
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Configuration for an OAuth 2.1 authorization server (explicit endpoints — discovery deferred). */
export interface OAuthServerConfig {
  /** Authorization endpoint URL (e.g. `https://auth.example.com/oauth/authorize`). */
  authorizationEndpoint: string;
  /** Token endpoint URL (e.g. `https://auth.example.com/oauth/token`). */
  tokenEndpoint: string;
  /** OAuth 2.1 client_id (public client — no client_secret). */
  clientId: string;
  /** Redirect URI registered with the authorization server. */
  redirectUri: string;
  /** Space-separated OAuth scopes to request (optional). */
  scope?: string;
}

/** Tokens returned by the authorization server. */
export interface OAuthTokens {
  accessToken: string;
  /** Token type — almost always "Bearer". */
  tokenType: string;
  /** Access token lifetime in seconds (if returned by the server). */
  expiresIn?: number;
  /** Refresh token for renewing the access token. */
  refreshToken?: string;
  /** Unix ms timestamp when the access token expires (computed from expiresIn). */
  expiresAt?: number;
}

/**
 * Hook that consumers can implement to persist and restore tokens across process restarts.
 * If not provided, tokens live only in-memory on the {@link OAuthConnection} object.
 */
export interface OAuthTokenStore {
  /** Called when fresh tokens are obtained (initial grant or refresh). */
  save(tokens: OAuthTokens): Promise<void> | void;
  /** Called on construction — return previously persisted tokens (or null). */
  load(): Promise<OAuthTokens | null> | OAuthTokens | null;
}

/** The parameter bag returned by {@link beginAuthorizationFlow}. */
export interface AuthorizationFlowParams {
  /** The full authorization URL the user must be redirected to (or opened in a browser). */
  authorizationUrl: string;
  /**
   * The opaque state value that must be validated against the `state` query-param in the
   * callback before calling {@link completeAuthorizationFlow}. Store this securely between
   * the start and finish of the flow.
   */
  state: string;
  /**
   * The PKCE code verifier — must be kept secret and passed to
   * {@link completeAuthorizationFlow}. Never log this value.
   */
  codeVerifier: string;
}

// ---------------------------------------------------------------------------
// Authorization URL construction
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Endpoint validation helpers (FIX 3)
// ---------------------------------------------------------------------------

/**
 * Assert that an OAuth endpoint URL uses `https:` (OAuth 2.1 mandate).
 * Throws a descriptive error on failure.
 */
function assertHttpsEndpoint(rawUrl: string, label: string): void {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    throw new Error(`OAuth: invalid ${label} URL`);
  }
  if (parsed.protocol !== "https:") {
    throw new Error(
      `OAuth: ${label} must use https: (got ${parsed.protocol}) — OAuth 2.1 requires HTTPS endpoints`,
    );
  }
}

/**
 * Assert that a redirect URI is acceptable for OAuth 2.1:
 * - `https:` — always allowed.
 * - `http:` — only allowed when the host is a loopback address (`localhost`,
 *   `127.0.0.1`, or `[::1]`), which is the OAuth 2.1 native-app loopback exception.
 *
 * Throws a descriptive error on any other scheme or host.
 */
function assertValidRedirectUri(rawUrl: string): void {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    throw new Error(`OAuth: invalid redirectUri`);
  }
  if (parsed.protocol === "https:") return; // always allowed
  if (parsed.protocol === "http:") {
    const h = parsed.hostname.toLowerCase().replace(/^\[|\]$/g, "");
    if (h === "localhost" || h === "127.0.0.1" || h === "::1") return; // loopback exception
    throw new Error(
      `OAuth: redirectUri uses http: with a non-loopback host (${parsed.hostname}) — ` +
      `only https: or http://localhost/127.0.0.1 are permitted (OAuth 2.1 §4.1.2)`,
    );
  }
  throw new Error(
    `OAuth: redirectUri must use https: or http: loopback (got ${parsed.protocol})`,
  );
}

/**
 * Begin an OAuth 2.1 authorization-code + PKCE flow.
 *
 * Returns the {@link AuthorizationFlowParams} bag containing:
 *   - `authorizationUrl` — redirect the user here.
 *   - `state` — validate this against the callback's `state` param.
 *   - `codeVerifier` — keep secret; pass to {@link completeAuthorizationFlow}.
 *
 * @throws if `authorizationEndpoint` or `tokenEndpoint` are not `https:`, or if
 *   `redirectUri` is not `https:` and not a loopback `http:` address.
 */
export async function beginAuthorizationFlow(
  config: OAuthServerConfig,
): Promise<AuthorizationFlowParams> {
  // FIX 3: Validate that endpoints use https: and redirectUri is https: or loopback http:.
  assertHttpsEndpoint(config.authorizationEndpoint, "authorizationEndpoint");
  assertHttpsEndpoint(config.tokenEndpoint, "tokenEndpoint");
  assertValidRedirectUri(config.redirectUri);

  const codeVerifier = generateCodeVerifier();
  const codeChallenge = await deriveCodeChallenge(codeVerifier);
  const state = generateState();

  const url = new URL(config.authorizationEndpoint);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("client_id", config.clientId);
  url.searchParams.set("redirect_uri", config.redirectUri);
  url.searchParams.set("code_challenge", codeChallenge);
  url.searchParams.set("code_challenge_method", "S256");
  url.searchParams.set("state", state);
  if (config.scope) {
    url.searchParams.set("scope", config.scope);
  }

  return { authorizationUrl: url.toString(), state, codeVerifier };
}

// ---------------------------------------------------------------------------
// Token exchange
// ---------------------------------------------------------------------------

/**
 * Complete the authorization-code flow: validate `state`, then exchange the `code`
 * for tokens at the token endpoint.
 *
 * @param config - The OAuth server configuration (same as passed to {@link beginAuthorizationFlow}).
 * @param code - The `code` parameter received in the authorization callback.
 * @param codeVerifier - The PKCE verifier from {@link beginAuthorizationFlow}.
 * @param returnedState - The `state` parameter received in the callback.
 * @param expectedState - The `state` value from {@link beginAuthorizationFlow}; must match `returnedState`.
 * @param fetchFn - Optional fetch implementation (defaults to `globalThis.fetch`). Used for testing.
 */
export async function completeAuthorizationFlow(
  config: OAuthServerConfig,
  code: string,
  codeVerifier: string,
  returnedState: string,
  expectedState: string,
  fetchFn: typeof fetch = globalThis.fetch,
): Promise<OAuthTokens> {
  // CSRF guard: reject mismatched state.
  if (!await timingSafeEqual(returnedState, expectedState)) {
    throw new OAuthStateError(
      "OAuth state mismatch — possible CSRF attack. Rejecting authorization callback.",
    );
  }

  return exchangeCodeForTokens(config, code, codeVerifier, fetchFn);
}

/** Exchange an authorization code + PKCE verifier for tokens (internal). */
async function exchangeCodeForTokens(
  config: OAuthServerConfig,
  code: string,
  codeVerifier: string,
  fetchFn: typeof fetch,
): Promise<OAuthTokens> {
  const body = new URLSearchParams({
    grant_type: "authorization_code",
    code,
    redirect_uri: config.redirectUri,
    client_id: config.clientId,
    code_verifier: codeVerifier,
  });

  const response = await fetchFn(config.tokenEndpoint, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
    body: body.toString(),
  });

  return parseTokenResponse(response);
}

// ---------------------------------------------------------------------------
// Token refresh
// ---------------------------------------------------------------------------

/**
 * Refresh an access token using the provided refresh token.
 * RFC 6749 §6, OAuth 2.1 profile.
 *
 * @param config - The OAuth server configuration.
 * @param refreshToken - The refresh token to use.
 * @param fetchFn - Optional fetch implementation (defaults to `globalThis.fetch`). Used for testing.
 */
export async function refreshAccessToken(
  config: OAuthServerConfig,
  refreshToken: string,
  fetchFn: typeof fetch = globalThis.fetch,
): Promise<OAuthTokens> {
  const body = new URLSearchParams({
    grant_type: "refresh_token",
    refresh_token: refreshToken,
    client_id: config.clientId,
  });

  const response = await fetchFn(config.tokenEndpoint, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
    body: body.toString(),
  });

  return parseTokenResponse(response);
}

// ---------------------------------------------------------------------------
// Response parsing
// ---------------------------------------------------------------------------

async function parseTokenResponse(response: Response): Promise<OAuthTokens> {
  let body: unknown;
  const contentType = response.headers.get("content-type") ?? "";

  try {
    if (contentType.includes("application/json")) {
      body = await response.json();
    } else {
      // Some servers return form-encoded tokens (non-standard but seen in the wild).
      const text = await response.text();
      const params = new URLSearchParams(text);
      body = Object.fromEntries(params.entries());
    }
  } catch {
    throw new OAuthTokenError(`Failed to parse token response (HTTP ${response.status}).`);
  }

  if (!response.ok) {
    const err = body as Record<string, unknown>;
    const desc = typeof err?.error_description === "string" ? err.error_description : "";
    const code = typeof err?.error === "string" ? err.error : String(response.status);
    throw new OAuthTokenError(`Token request failed: ${code}${desc ? " — " + desc : ""}`);
  }

  const data = body as Record<string, unknown>;
  if (typeof data?.access_token !== "string") {
    throw new OAuthTokenError("Token response missing access_token.");
  }

  const tokens: OAuthTokens = {
    accessToken: data.access_token,
    tokenType: typeof data.token_type === "string" ? data.token_type : "Bearer",
    expiresIn: typeof data.expires_in === "number" ? data.expires_in : undefined,
    refreshToken: typeof data.refresh_token === "string" ? data.refresh_token : undefined,
  };

  if (tokens.expiresIn !== undefined) {
    tokens.expiresAt = Date.now() + tokens.expiresIn * 1000;
  }

  return tokens;
}

// ---------------------------------------------------------------------------
// OAuthConnection — manages bearer tokens on a connection object
// ---------------------------------------------------------------------------

/**
 * Manages OAuth tokens for a single MCP HTTP connection.
 *
 * Stores tokens in-memory and exposes a `getAuthorizationHeader()` method that
 * returns the current `Authorization: Bearer …` header value, automatically
 * refreshing the access token when it has expired.
 *
 * If a {@link OAuthTokenStore} is provided, tokens are persisted/restored across
 * process restarts via the `save`/`load` hooks.
 *
 * **Security:** tokens are never logged. Pass this object to
 * {@link streamableHttpClient} via `opts.oauth` (see index.ts).
 */
export class OAuthConnection {
  private tokens: OAuthTokens | null = null;
  private readonly config: OAuthServerConfig;
  private readonly store: OAuthTokenStore | undefined;
  private readonly fetchFn: typeof fetch;

  constructor(
    config: OAuthServerConfig,
    opts?: {
      /** Optional persist/restore hook for tokens. */
      tokenStore?: OAuthTokenStore;
      /** Optional fetch implementation (defaults to `globalThis.fetch`). */
      fetch?: typeof fetch;
    },
  ) {
    // FIX 3: Validate endpoints at construction time so misconfiguration is caught early,
    // even before any flow is started.
    assertHttpsEndpoint(config.tokenEndpoint, "tokenEndpoint");
    assertValidRedirectUri(config.redirectUri);

    this.config = config;
    this.store = opts?.tokenStore;
    this.fetchFn = opts?.fetch ?? globalThis.fetch;
  }

  /**
   * Load tokens from the token store (if provided). Call this once on startup to
   * restore a previously persisted session.
   */
  async loadFromStore(): Promise<void> {
    if (this.store) {
      const stored = await this.store.load();
      if (stored) {
        this.tokens = stored;
      }
    }
  }

  /**
   * Inject tokens directly — used after completing the authorization flow
   * (call this with the result of {@link completeAuthorizationFlow}).
   */
  async setTokens(tokens: OAuthTokens): Promise<void> {
    this.tokens = tokens;
    await this.store?.save(tokens);
  }

  /**
   * Returns `true` if the connection has tokens (may still be expired — use
   * `getAuthorizationHeader()` which handles refresh automatically).
   */
  hasTokens(): boolean {
    return this.tokens !== null;
  }

  /**
   * Returns the value of the `Authorization` header for the current access token.
   * If the token is expired (and a refresh token is available), it is automatically
   * renewed. Throws {@link OAuthTokenError} if no tokens are available or refresh fails.
   *
   * **Never log the returned string** — it contains a bearer token.
   */
  async getAuthorizationHeader(): Promise<string> {
    if (!this.tokens) {
      throw new OAuthTokenError("No OAuth tokens available — complete the authorization flow first.");
    }

    // Refresh if the access token has expired (with a 30-second buffer).
    if (this.isExpired(this.tokens) && this.tokens.refreshToken) {
      const fresh = await refreshAccessToken(this.config, this.tokens.refreshToken, this.fetchFn);
      // FIX 2: Preserve the existing refresh token when the server's refresh response omits it.
      // RFC 6749 §6 states the server MAY issue a new refresh token; if it doesn't, the prior
      // refresh token MUST remain valid. Without this, the user is silently logged out on the
      // next refresh cycle after the server issues a no-refresh-token response.
      this.tokens = { ...fresh, refreshToken: fresh.refreshToken ?? this.tokens.refreshToken };
      await this.store?.save(this.tokens);
    }

    const tokenType =
      this.tokens.tokenType.toLowerCase() === "bearer" ? "Bearer" : this.tokens.tokenType;
    return `${tokenType} ${this.tokens.accessToken}`;
  }

  /** Returns `true` if the token has expired (with a 30-second clock-skew buffer). */
  private isExpired(tokens: OAuthTokens): boolean {
    if (tokens.expiresAt === undefined) return false;
    return Date.now() >= tokens.expiresAt - 30_000;
  }
}

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

/** Thrown when an OAuth `state` parameter mismatch is detected (CSRF guard). */
export class OAuthStateError extends Error {
  override name = "OAuthStateError";
}

/** Thrown on token exchange or refresh failures. */
export class OAuthTokenError extends Error {
  override name = "OAuthTokenError";
}

// ---------------------------------------------------------------------------
// Utilities
// ---------------------------------------------------------------------------

/**
 * Constant-time string comparison via SHA-256 digest-then-compare.
 *
 * Both inputs are hashed with SHA-256 before comparison, so the comparison
 * always operates on equal-length (32-byte) digests — removing the length
 * leak present in the old XOR approach.  Node's `crypto.timingSafeEqual`
 * provides the actual constant-time comparison over the two digests.
 *
 * This function is async because `crypto.subtle.digest` is async; all call
 * sites already `await` it.
 */
export async function timingSafeEqual(a: string, b: string): Promise<boolean> {
  const enc = new TextEncoder();
  const [da, db] = await Promise.all([
    globalThis.crypto.subtle.digest("SHA-256", enc.encode(a)),
    globalThis.crypto.subtle.digest("SHA-256", enc.encode(b)),
  ]);
  // Node 15+ exposes timingSafeEqual on the webcrypto ArrayBuffer result.
  // Use it when available; otherwise fall back to a byte-by-byte OR-accumulate
  // (same algorithm, but without the JIT constant-time guarantee).
  try {
    const { timingSafeEqual: nodeTSE } = await import("node:crypto");
    return nodeTSE(Buffer.from(da), Buffer.from(db));
  } catch {
    // Non-Node environment — byte-by-byte OR accumulate over equal-length digests.
    const va = new Uint8Array(da);
    const vb = new Uint8Array(db);
    let diff = 0;
    for (let i = 0; i < va.length; i++) diff |= va[i]! ^ vb[i]!;
    return diff === 0;
  }
}

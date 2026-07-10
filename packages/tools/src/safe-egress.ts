import { isIP } from "node:net";
import { discardResponseBody, resilientFetch, readResponseText } from "./http.js";
import type { EgressBoundaryPolicy, SafeEgressPort } from "@eidentic/types";

const DEFAULT_MAX_REDIRECTS = 5;
const DEFAULT_MAX_RESPONSE_BYTES = 512 * 1024;

export interface SafeEgressPolicy {
  /** Exact hosts or parent domains that may be contacted. Omitted/empty denies every host. */
  allowlist?: readonly string[];
  /** @deprecated Unsafe compatibility mode permitting every globally routed host. */
  unsafeAllowAnyPublicHost?: boolean;
  /** Resolve and validate every address before each attempt. Default: true. */
  resolveHosts?: boolean;
  /** Resolver override for deterministic runtimes/tests. It must return every usable A/AAAA address. */
  resolveHost?: (hostname: string) => Promise<string[]>;
  /** Reject cleartext HTTP. Default: true. Set false only behind an equivalent secure transport. */
  requireHttps?: boolean;
}

export interface SafeFetchOptions extends SafeEgressPolicy {
  fetchImpl?: typeof fetch;
  signal?: AbortSignal;
  timeoutMs?: number;
  /** Retry count. Retries are supported only for idempotent GET and HEAD requests. */
  retries?: number;
  maxRedirects?: number;
}

export interface SafeFetchTextOptions extends SafeFetchOptions {
  maxResponseBytes?: number;
  bodyTimeoutMs?: number;
  /** Return a bounded prefix rather than rejecting an oversized body. Default: false. */
  truncate?: boolean;
  /** Exact media types or prefixes ending in `/`, e.g. `text/`. */
  allowedContentTypes?: readonly string[];
}

export interface SafeFetchResult {
  response: Response;
  url: URL;
  redirects: number;
}

export interface SafeFetchTextResult {
  url: string;
  status: number;
  content: string;
  truncated: boolean;
  contentType?: string;
  redirects: number;
}

/** Exact + dot-boundary subdomain matching. */
export function hostAllowed(host: string, allowlist: readonly string[]): boolean {
  const normalizedHost = normalizeHostname(host);
  return allowlist.some((entry) => {
    const normalizedEntry = normalizeHostname(entry);
    return normalizedEntry.length > 0 &&
      (normalizedHost === normalizedEntry || normalizedHost.endsWith(`.${normalizedEntry}`));
  });
}

function normalizeHostname(host: string): string {
  const unwrapped = host.startsWith("[") && host.endsWith("]") ? host.slice(1, -1) : host;
  return unwrapped.replace(/\.$/, "").toLowerCase();
}

function parseIPv4(address: string): number | undefined {
  const parts = address.split(".");
  if (parts.length !== 4) return undefined;
  const octets = parts.map((part) => Number(part));
  if (octets.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) return undefined;
  return ((((octets[0]! << 24) >>> 0) | (octets[1]! << 16) | (octets[2]! << 8) | octets[3]!) >>> 0);
}

function isGlobalIPv4(address: string): boolean {
  const value = parseIPv4(address);
  if (value === undefined) return false;
  const a = value >>> 24;
  const b = (value >>> 16) & 0xff;
  const c = (value >>> 8) & 0xff;

  if (a === 0 || a === 10 || a === 127) return false;
  if (a === 100 && b >= 64 && b <= 127) return false; // shared address space
  if (a === 169 && b === 254) return false;
  if (a === 172 && b >= 16 && b <= 31) return false;
  if (a === 192 && b === 0 && c === 0) return false;
  if (a === 192 && b === 0 && c === 2) return false; // TEST-NET-1
  if (a === 192 && b === 88 && c === 99) return false; // deprecated 6to4 relay anycast
  if (a === 192 && b === 168) return false;
  if (a === 198 && (b === 18 || b === 19)) return false; // benchmark
  if (a === 198 && b === 51 && c === 100) return false; // TEST-NET-2
  if (a === 203 && b === 0 && c === 113) return false; // TEST-NET-3
  if (a >= 224) return false; // multicast, reserved and limited broadcast
  return true;
}

function ipv6Bytes(raw: string): Uint8Array | undefined {
  let address = normalizeHostname(raw);
  const zone = address.indexOf("%");
  if (zone !== -1) address = address.slice(0, zone);

  const dottedIndex = address.lastIndexOf(":");
  if (address.includes(".") && dottedIndex !== -1) {
    const ipv4 = parseIPv4(address.slice(dottedIndex + 1));
    if (ipv4 === undefined) return undefined;
    address = `${address.slice(0, dottedIndex)}:${((ipv4 >>> 16) & 0xffff).toString(16)}:${(ipv4 & 0xffff).toString(16)}`;
  }

  const halves = address.split("::");
  if (halves.length > 2) return undefined;
  const head = halves[0] ? halves[0].split(":") : [];
  const tail = halves.length === 2 && halves[1] ? halves[1]!.split(":") : [];
  if (halves.length === 1 && head.length !== 8) return undefined;
  const missing = 8 - head.length - tail.length;
  if (missing < 0 || (halves.length === 2 && missing < 1)) return undefined;
  const groups = [...head, ...Array.from({ length: missing }, () => "0"), ...tail];
  if (groups.length !== 8) return undefined;

  const bytes = new Uint8Array(16);
  for (let i = 0; i < groups.length; i++) {
    if (!/^[0-9a-f]{1,4}$/i.test(groups[i]!)) return undefined;
    const value = Number.parseInt(groups[i]!, 16);
    bytes[i * 2] = value >>> 8;
    bytes[i * 2 + 1] = value & 0xff;
  }
  return bytes;
}

function hasPrefix(bytes: Uint8Array, prefix: readonly number[], bits: number): boolean {
  const fullBytes = Math.floor(bits / 8);
  for (let i = 0; i < fullBytes; i++) {
    if (bytes[i] !== prefix[i]) return false;
  }
  const remaining = bits % 8;
  if (remaining === 0) return true;
  const mask = 0xff << (8 - remaining);
  return (bytes[fullBytes]! & mask) === ((prefix[fullBytes] ?? 0) & mask);
}

function embeddedIPv4(bytes: Uint8Array): string {
  return `${bytes[12]}.${bytes[13]}.${bytes[14]}.${bytes[15]}`;
}

function isGlobalIPv6(address: string): boolean {
  const bytes = ipv6Bytes(address);
  if (!bytes) return false;

  const firstTwelveZero = bytes.subarray(0, 12).every((byte) => byte === 0);
  const mapped = bytes.subarray(0, 10).every((byte) => byte === 0) && bytes[10] === 0xff && bytes[11] === 0xff;
  if (firstTwelveZero || mapped) return isGlobalIPv4(embeddedIPv4(bytes));

  // NAT64 well-known prefix: validate the embedded IPv4 address too.
  if (hasPrefix(bytes, [0x00, 0x64, 0xff, 0x9b], 96)) {
    return isGlobalIPv4(embeddedIPv4(bytes));
  }

  if (hasPrefix(bytes, [0x00], 8)) return false; // unspecified/special low space
  if (hasPrefix(bytes, [0x01, 0x00], 64)) return false; // discard-only
  if (hasPrefix(bytes, [0x00, 0x64, 0xff, 0x9b, 0x00, 0x01], 48)) return false; // local-use NAT64
  if (hasPrefix(bytes, [0x20, 0x01, 0x00], 23)) return false; // IETF protocol assignments
  if (hasPrefix(bytes, [0x20, 0x01, 0x0d, 0xb8], 32)) return false; // documentation
  if (hasPrefix(bytes, [0x20, 0x02], 16)) return false; // deprecated 6to4
  if (hasPrefix(bytes, [0x3f, 0xff], 20)) return false; // documentation
  if (hasPrefix(bytes, [0x5f, 0x00], 16)) return false; // segment-routing special-use
  if (hasPrefix(bytes, [0xfc], 7)) return false; // unique-local
  if (hasPrefix(bytes, [0xfe, 0x80], 10)) return false; // link-local
  if (hasPrefix(bytes, [0xfe, 0xc0], 10)) return false; // deprecated site-local
  if (hasPrefix(bytes, [0xff], 8)) return false; // multicast
  return hasPrefix(bytes, [0x20], 3); // currently allocated global-unicast space (2000::/3)
}

/** True for IP literals and special names that are not globally routable. */
export function isBlockedHost(host: string): boolean {
  const normalized = normalizeHostname(host);
  if (normalized === "localhost" || normalized.endsWith(".localhost")) return true;

  // URL parsing canonicalizes decimal/hex/octal IPv4 forms, but callers may use this helper
  // directly, so normalize those representations here too.
  if (/^0x[0-9a-f]+$/i.test(normalized) || /^\d+$/.test(normalized) || /^0[0-7]+$/.test(normalized)) {
    const radix = normalized.startsWith("0x") ? 16 : normalized.startsWith("0") && normalized.length > 1 ? 8 : 10;
    const value = Number.parseInt(normalized, radix);
    if (Number.isSafeInteger(value) && value >= 0 && value <= 0xffffffff) {
      return !isGlobalIPv4(`${value >>> 24}.${(value >>> 16) & 0xff}.${(value >>> 8) & 0xff}.${value & 0xff}`);
    }
  }

  const version = isIP(normalized);
  if (version === 4) return !isGlobalIPv4(normalized);
  if (version === 6) return !isGlobalIPv6(normalized);
  return false;
}

/** URL text safe for logs/model output: credentials, query and fragment are omitted. */
export function safeUrlForError(raw: URL | string): string {
  try {
    const url = typeof raw === "string" ? new URL(raw) : raw;
    return `${url.protocol}//${url.host}${url.pathname}`;
  } catch {
    return "[invalid URL]";
  }
}

/** Synchronous syntax/IP/allowlist validation. DNS validation requires {@link assertSafeEgressUrl}. */
export function parseSafeEgressUrl(raw: string | URL, policy: SafeEgressPolicy = {}): URL {
  let url: URL;
  try {
    url = raw instanceof URL ? new URL(raw.href) : new URL(raw);
  } catch {
    throw new Error("safe egress: invalid URL");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error(`safe egress: only http(s) URLs are allowed (got ${url.protocol})`);
  }
  if (url.username !== "" || url.password !== "") {
    throw new Error("safe egress: URL credentials are not allowed");
  }
  if (isBlockedHost(url.hostname)) {
    throw new Error(`safe egress: host is a blocked private/loopback/non-global address: ${url.hostname}`);
  }
  if (policy.allowlist !== undefined && !hostAllowed(url.hostname, policy.allowlist)) {
    throw new Error(`safe egress: host not on allowlist: ${url.hostname}`);
  }
  if (policy.allowlist === undefined && policy.unsafeAllowAnyPublicHost !== true) {
    throw new Error(`safe egress: host not on allowlist: ${url.hostname}`);
  }
  if ((policy.requireHttps ?? true) && url.protocol !== "https:") {
    throw new Error("safe egress: HTTPS is required");
  }
  return url;
}

async function defaultResolveHost(hostname: string): Promise<string[]> {
  const { lookup } = await import("node:dns/promises");
  const records = await lookup(hostname, { all: true, verbatim: true });
  return records.map((record) => record.address);
}

/** Validate URL syntax and every address returned by the active A/AAAA resolver. */
export async function assertSafeEgressUrl(
  raw: string | URL,
  policy: SafeEgressPolicy = {},
): Promise<URL> {
  const url = parseSafeEgressUrl(raw, policy);
  if (policy.resolveHosts === false || isIP(normalizeHostname(url.hostname)) !== 0) return url;

  const resolver = policy.resolveHost ?? defaultResolveHost;
  let addresses: string[];
  try {
    addresses = [...new Set(await resolver(url.hostname))];
  } catch {
    throw new Error(`safe egress: DNS resolution failed for ${url.hostname}`);
  }
  if (addresses.length === 0) {
    throw new Error(`safe egress: DNS returned no addresses for ${url.hostname}`);
  }
  for (const address of addresses) {
    if (isIP(normalizeHostname(address)) === 0 || isBlockedHost(address)) {
      throw new Error(`safe egress: resolved host maps to blocked non-global address: ${url.hostname}`);
    }
  }
  return url;
}

/**
 * Fetch with fail-closed per-attempt DNS validation and manual, per-hop redirect validation.
 * Cross-origin redirects discard caller headers, cookies and referrer information rather than
 * forwarding credentials to a host the caller did not name.
 */
export async function safeFetch(
  raw: string | URL,
  init: RequestInit = {},
  options: SafeFetchOptions = {},
): Promise<SafeFetchResult> {
  let current = parseSafeEgressUrl(raw, options);
  current.hash = ""; // fragments are client-side only and are never part of an HTTP request
  const maxRedirects = options.maxRedirects ?? DEFAULT_MAX_REDIRECTS;
  if (!Number.isSafeInteger(maxRedirects) || maxRedirects < 0) {
    throw new Error("safe egress: maxRedirects must be a non-negative safe integer");
  }
  let redirects = 0;
  let requestInit: RequestInit = { ...init, redirect: "manual" };
  const method = (requestInit.method ?? "GET").toUpperCase();
  const retries = options.retries ?? (method === "GET" || method === "HEAD" ? 1 : 0);
  if (!Number.isSafeInteger(retries) || retries < 0) {
    throw new Error("safe egress: retries must be a non-negative safe integer");
  }
  if (method !== "GET" && method !== "HEAD" && retries > 0) {
    throw new Error("safe egress: retries are only allowed for GET and HEAD requests");
  }

  while (true) {
    const response = await resilientFetch(current.href, requestInit, {
      fetchImpl: options.fetchImpl,
      timeoutMs: options.timeoutMs,
      retries,
      signal: options.signal,
      beforeAttempt: async () => {
        await assertSafeEgressUrl(current, options);
      },
    });

    const responseUrl = response.url;
    let responseUrlChanged = false;
    if (responseUrl !== "") {
      try {
        responseUrlChanged = new URL(responseUrl).href !== current.href;
      } catch {
        responseUrlChanged = true;
      }
    }
    if (response.redirected || responseUrlChanged) {
      discardResponseBody(response);
      throw new Error(
        "safe egress: fetch implementation auto-followed a redirect; redirect:\"manual\" is required",
      );
    }

    const isRedirect = response.status === 301 || response.status === 302 ||
      response.status === 303 || response.status === 307 || response.status === 308;
    if (!isRedirect) {
      return { response, url: current, redirects };
    }

    const location = response.headers.get("location");
    if (!location) {
      discardResponseBody(response);
      throw new Error(`safe egress: redirect from ${safeUrlForError(current)} has no Location header`);
    }
    if (redirects >= maxRedirects) {
      discardResponseBody(response);
      throw new Error(`safe egress: redirect limit (${maxRedirects}) exceeded`);
    }
    if (method !== "GET" && method !== "HEAD") {
      discardResponseBody(response);
      throw new Error("safe egress: redirects for non-idempotent requests are rejected");
    }

    let next: URL;
    try {
      next = new URL(location, current);
    } catch {
      discardResponseBody(response);
      throw new Error("safe egress: invalid redirect target");
    }
    try {
      next = parseSafeEgressUrl(next, options);
    } catch (error) {
      discardResponseBody(response);
      const message = error instanceof Error ? error.message : "redirect rejected";
      if (message.includes("not on allowlist")) {
        throw new Error(`safe egress: redirect off egress allowlist rejected: ${next.hostname}`);
      }
      throw error;
    }
    next.hash = "";
    discardResponseBody(response);
    if (current.origin !== next.origin) {
      // Fetch implementations and cookie jars differ in how they interpret `credentials`.
      // Remove every caller header as well as ambient cookie/referrer authority so a redirect
      // cannot turn an authenticated request into a credential exfiltration primitive.
      requestInit = { ...requestInit };
      delete requestInit.headers;
      delete requestInit.referrer;
      requestInit.credentials = "omit";
      requestInit.referrerPolicy = "no-referrer";
    }
    current = next;
    redirects++;
    requestInit = { ...requestInit, redirect: "manual" };
  }
}

/** Safe fetch plus bounded, timed, textual response consumption. */
export async function safeFetchText(
  raw: string | URL,
  init: RequestInit = {},
  options: SafeFetchTextOptions = {},
): Promise<SafeFetchTextResult> {
  const result = await safeFetch(raw, init, options);
  const rawContentType = result.response.headers.get("content-type");
  const contentType = rawContentType?.split(";", 1)[0]?.trim().toLowerCase();
  if (contentType && options.allowedContentTypes && !options.allowedContentTypes.some((allowed) => {
    const normalized = allowed.toLowerCase();
    return normalized.endsWith("/") ? contentType.startsWith(normalized) : contentType === normalized;
  })) {
    discardResponseBody(result.response);
    throw new Error(`safe egress: response content type is not allowed (${contentType})`);
  }

  const body = await readResponseText(result.response, {
    maxBytes: options.maxResponseBytes ?? DEFAULT_MAX_RESPONSE_BYTES,
    timeoutMs: options.bodyTimeoutMs ?? options.timeoutMs ?? 10_000,
    signal: options.signal,
    truncate: options.truncate,
  });
  return {
    url: safeUrlForError(result.url),
    status: result.response.status,
    content: body.text,
    truncated: body.truncated,
    ...(contentType ? { contentType } : {}),
    redirects: result.redirects,
  };
}

/** Build the framework-level SafeEgressPort on top of this package's hardened fetch path. */
export function createSafeEgressPort(defaults: SafeFetchOptions = {}): SafeEgressPort {
  const optionsFor = (policy: EgressBoundaryPolicy): SafeFetchOptions => ({
    ...defaults,
    allowlist: policy.allowedHosts,
    requireHttps: policy.requireHttps,
    resolveHosts: defaults.resolveHosts ?? true,
  });
  return {
    async validate(url, policy) {
      await assertSafeEgressUrl(url, optionsFor(policy));
    },
    async request(request) {
      const result = await safeFetch(request.url, {
        method: request.method,
        ...(request.headers ? { headers: request.headers } : {}),
        ...(request.body !== undefined ? { body: request.body } : {}),
        ...(request.signal ? { signal: request.signal } : {}),
        credentials: "omit",
        referrerPolicy: "no-referrer",
      }, {
        ...optionsFor(request.policy),
        ...(request.signal ? { signal: request.signal } : {}),
        ...(request.timeoutMs !== undefined ? { timeoutMs: request.timeoutMs } : {}),
        maxRedirects: request.maxRedirects ?? 0,
        retries: 0,
      });
      discardResponseBody(result.response);
      return { status: result.response.status, safeUrl: safeUrlForError(result.url) };
    },
  };
}

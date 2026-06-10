import type { LogLevel, LogFields, LoggerPort } from "@eidentic/types";

export type { LogLevel, LogFields, LoggerPort };

// --- secret redaction ---

const KEY_SECRET_RE = /key|token|secret|password|authorization|bearer|api[_-]?key|credential/i;

/**
 * Matches obvious secret patterns embedded anywhere in a string value (best-effort).
 *
 * Covered patterns:
 *  - Anthropic/OpenAI-style API keys:  `sk-` + 8+ alphanum chars
 *  - Bearer tokens (any scheme)
 *  - JWTs:                             `eyJ` + 8+ base64url chars (header prefix)
 *  - AWS access key IDs:               `AKIA` + exactly 16 uppercase alphanum chars
 *  - Slack tokens:                     `xox[baprs]-` + alphanum/hyphen
 *  - GitHub personal/OAuth tokens:     `ghp_` or `gho_` + 20+ alphanum chars
 */
const VALUE_SECRET_RE =
  /sk-[A-Za-z0-9_\-]{8,}|Bearer\s+\S+|eyJ[A-Za-z0-9_\-]{8,}|AKIA[A-Z0-9]{16}|xox[baprs]-[A-Za-z0-9\-]+|gh[po]_[A-Za-z0-9]{20,}/;

/** Maximum recursion depth for redactValue (cycle/bomb guard). */
const REDACT_MAX_DEPTH = 20;

/**
 * Redact a single log field value recursively. Handles strings (key-name match + value-pattern
 * match), nested objects, and arrays. Primitives other than string are returned as-is.
 *
 * Uses a WeakSet cycle guard to prevent infinite recursion on cyclic object references,
 * plus a depth cap as a secondary defence against deeply nested structures.
 *
 * @param key   - The parent key name (used for KEY_SECRET_RE matching). Pass undefined for
 *                array elements, where the key isn't meaningful.
 * @param value - The value to redact.
 * @param seen  - WeakSet tracking already-visited objects (cycle guard).
 * @param depth - Current recursion depth (depth cap guard).
 */
function redactValue(
  key: string | undefined,
  value: LogFields[string],
  seen: WeakSet<object> = new WeakSet(),
  depth = 0,
): LogFields[string] {
  // Key-name redaction wins immediately for any value type.
  if (key !== undefined && KEY_SECRET_RE.test(key)) return "***";

  if (typeof value === "string") {
    // Value-pattern redaction: contains a known secret pattern anywhere in the string.
    if (VALUE_SECRET_RE.test(value)) return "***";
    return value;
  }

  if (Array.isArray(value)) {
    if (depth >= REDACT_MAX_DEPTH || seen.has(value)) return "[...]";
    seen.add(value);
    return (value as LogFields[string][]).map((el) => redactValue(undefined, el, seen, depth + 1));
  }

  if (value !== null && typeof value === "object") {
    if (depth >= REDACT_MAX_DEPTH || seen.has(value)) return "{...}";
    seen.add(value);
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = redactValue(k, v as LogFields[string], seen, depth + 1);
    }
    return out as LogFields[string];
  }

  // number, boolean, null, undefined — pass through unchanged.
  return value;
}

/**
 * Redact field values whose KEY looks like a secret, or whose string VALUE matches a known
 * secret pattern. Recurses into nested objects and arrays. Returns a new object; the original
 * is never mutated.
 *
 * Cycle-safe: a shared WeakSet tracks visited objects so circular references do not cause
 * unbounded recursion. Capped at depth 20 as a secondary guard.
 */
export function redactFields(fields: LogFields): LogFields {
  const seen = new WeakSet<object>();
  seen.add(fields);
  const out: LogFields = {};
  for (const [k, v] of Object.entries(fields)) {
    out[k] = redactValue(k, v, seen, 0);
  }
  return out;
}

// --- NoopLogger ---

/**
 * Silent default — all methods are no-ops, `enabled()` always returns false.
 * Use as the default when neither a user-injected logger nor `DEBUG` is set.
 */
export const NoopLogger: LoggerPort = {
  log(_level: LogLevel, _ns: string, _msg: string, _fields?: LogFields): void {
    // intentionally empty
  },
  enabled(_level: LogLevel, _ns: string): boolean {
    return false;
  },
};

// --- DEBUG namespace parsing (debug-npm compatible) ---

/** Turn a DEBUG glob token into a RegExp. Only trailing `*` wildcards are supported. */
function globToRe(pattern: string): RegExp {
  // Escape special regex chars except * (which we convert to .*).
  const escaped = pattern.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*");
  return new RegExp(`^${escaped}$`);
}

function parseDebugEnv(raw: string): RegExp[] {
  return raw
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
    .map(globToRe);
}

/** Format a LogFields object as `key=value key2=value2 ...` for single-line stderr output. */
function formatFields(fields: LogFields): string {
  return Object.entries(fields)
    .map(([k, v]) => `${k}=${typeof v === "string" ? v : JSON.stringify(v)}`)
    .join(" ");
}

/**
 * Environment-gated logger. Reads `process.env.DEBUG` ONCE at construction.
 *
 * - debug/info: emitted only when the namespace is DEBUG-enabled (zero cost when `DEBUG` is unset).
 * - warn/error: ALWAYS emitted to stderr regardless of DEBUG (these are real problems).
 * - All fields are redacted before printing.
 */
export function envLogger(): LoggerPort {
  // Guard for edge runtimes without `process`.
  const debugRaw: string =
    typeof process !== "undefined" ? (process.env["DEBUG"] ?? "") : "";

  const patterns = parseDebugEnv(debugRaw);
  // Cache: namespace → whether any debug/info pattern matches it.
  const nsCache = new Map<string, boolean>();

  function nsEnabled(ns: string): boolean {
    const cached = nsCache.get(ns);
    if (cached !== undefined) return cached;
    const matched = patterns.some((re) => re.test(ns));
    nsCache.set(ns, matched);
    return matched;
  }

  function emit(level: LogLevel, ns: string, msg: string, fields?: LogFields): void {
    const redacted = fields ? redactFields(fields) : undefined;
    const suffix = redacted && Object.keys(redacted).length > 0 ? " " + formatFields(redacted) : "";
    // Use console.error (stderr) so this never pollutes stdout data streams.
    // eslint-disable-next-line no-console
    console.error(`[${level}] ${ns} ${msg}${suffix}`);
  }

  return {
    log(level: LogLevel, ns: string, msg: string, fields?: LogFields): void {
      if (level === "warn" || level === "error") {
        emit(level, ns, msg, fields);
        return;
      }
      // debug / info: only when namespace is enabled
      if (nsEnabled(ns)) {
        emit(level, ns, msg, fields);
      }
    },
    enabled(level: LogLevel, ns: string): boolean {
      if (level === "warn" || level === "error") return true;
      return nsEnabled(ns);
    },
  };
}

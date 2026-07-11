const SECRET_SHAPE = /\b(?:sk|rk|pk)-[A-Za-z0-9_-]{16,}\b/g;
const BEARER = /\bBearer\s+[^\s,;]+/gi;
const SECRET_ASSIGNMENT = /\b(api[_-]?key|access[_-]?token|refresh[_-]?token|password|secret)=([^\s&#]+)/gi;
const EMBEDDED_HTTP_URL = /https?:\/\/[^\s"'<>]+/gi;

function isSensitiveKey(key: string): boolean {
  const normalized = key.replace(/[^a-z0-9]/gi, "").toLowerCase();
  return normalized.startsWith("apikey") || normalized.endsWith("apikey") ||
    normalized.startsWith("authorization") || normalized.endsWith("authorization") ||
    normalized.startsWith("cookie") || normalized.endsWith("cookie") ||
    normalized.startsWith("credential") || normalized.endsWith("credential") ||
    normalized.startsWith("password") || normalized.endsWith("password") ||
    normalized.startsWith("secret") || normalized.endsWith("secret") ||
    normalized === "token" || normalized.endsWith("token");
}

export function sanitizeBoundaryText(value: string, maxChars = 64 * 1024): string {
  const safe = value
    .replace(SECRET_SHAPE, "[REDACTED_CREDENTIAL]")
    .replace(BEARER, "Bearer [REDACTED]")
    .replace(SECRET_ASSIGNMENT, (_match, key: string) => `${key}=[REDACTED]`)
    .replace(EMBEDDED_HTTP_URL, (candidate) => {
      try {
        const url = new URL(candidate);
        if (!url.username && !url.password && !url.search && !url.hash) return candidate;
        url.username = "";
        url.password = "";
        url.search = "";
        url.hash = "";
        return url.href;
      } catch {
        return "[REDACTED_URL]";
      }
    });
  return safe.length > maxChars ? safe.slice(0, maxChars) + "…(truncated)" : safe;
}

/** Recursive client/model/persistence boundary sanitizer for untrusted provider and tool values. */
export function sanitizeBoundaryValue(value: unknown, maxDepth = 12): unknown {
  const seen = new WeakSet<object>();
  const walk = (current: unknown, depth: number): unknown => {
    if (typeof current === "string") return sanitizeBoundaryText(current);
    if (current === null || typeof current === "number" || typeof current === "boolean" || current === undefined) return current;
    if (typeof current === "bigint") return current.toString();
    if (typeof current !== "object") return `[${typeof current}]`;
    if (depth >= maxDepth) return "[TRUNCATED_DEPTH]";
    if (seen.has(current)) return "[CIRCULAR]";
    seen.add(current);
    if (Array.isArray(current)) return current.slice(0, 10_000).map((item) => walk(item, depth + 1));
    const out: Record<string, unknown> = {};
    for (const [key, child] of Object.entries(current).slice(0, 10_000)) {
      out[key] = isSensitiveKey(key) ? "***" : walk(child, depth + 1);
    }
    return out;
  };
  return walk(value, 0);
}

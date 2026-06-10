import type { PermissionDecision, PermissionPolicy } from "@eidentic/types";
import type { SideEffect, Tool } from "./tool.js";

/**
 * Minimal glob match: `*` matches any run of characters (including empty).
 * The match is anchored (whole string must match the pattern).
 */
export function globMatch(pattern: string, id: string): boolean {
  if (!pattern.includes("*")) return pattern === id;
  // Split on `*` and require each segment to appear in order, with the
  // first anchored at the start and the last anchored at the end.
  const parts = pattern.split("*");
  let pos = 0;
  for (let i = 0; i < parts.length; i++) {
    const part = parts[i]!;
    if (i === 0) {
      // Must match at the start
      if (!id.startsWith(part)) return false;
      pos = part.length;
    } else if (i === parts.length - 1) {
      // Must match at the end
      if (!id.endsWith(part)) return false;
      // Also ensure the tail doesn't overlap with where we already consumed
      if (id.length - part.length < pos) return false;
    } else {
      // Mid segment: find the next occurrence at or after `pos`
      const idx = id.indexOf(part, pos);
      if (idx === -1) return false;
      pos = idx + part.length;
    }
  }
  return true;
}

/**
 * Parse a deny/allow entry that may contain an argument glob: `name(argGlob)`.
 * A bare entry (no parentheses) returns `{ nameGlob: entry, argGlob: undefined }`.
 * An arg-scoped entry returns `{ nameGlob, argGlob }`.
 *
 * Arg-scoped deny entries (those with parens) must NOT remove the tool from the schema —
 * the deny is conditional on the arguments and is evaluated at dispatch time.
 * Only bare-name deny entries produce schema removal + unconditional dispatch denial.
 */
export function parseDenyEntry(entry: string): { nameGlob: string; argGlob: string | undefined } {
  const paren = entry.indexOf("(");
  if (paren === -1) return { nameGlob: entry, argGlob: undefined };
  const nameGlob = entry.slice(0, paren);
  const argGlob = entry.slice(paren + 1, entry.endsWith(")") ? entry.length - 1 : entry.length);
  return { nameGlob, argGlob };
}

/**
 * Check whether any BARE deny entry (no arg-scoping) matches this tool id.
 * Used for schema-layer removal.
 */
function bareNameDenies(policy: PermissionPolicy, toolId: string): boolean {
  return policy.deny?.some((entry) => {
    const { nameGlob, argGlob } = parseDenyEntry(entry);
    return argGlob === undefined && globMatch(nameGlob, toolId);
  }) ?? false;
}

/**
 * Check whether any ARG-SCOPED deny entry (those with parens: `name(argGlob)`) matches this
 * tool id AND the given serialized input.
 *
 * This function only tests entries that have an explicit argument glob — bare-name deny entries
 * (no parens) are handled separately by `evaluatePermission` / `bareNameDenies`.
 *
 * NOTE: arg-scoped denies fire EVEN under mode:"bypass" — deny is evaluated before mode (§10.4).
 */
export function argScopedDenies(
  policy: PermissionPolicy,
  toolId: string,
  serializedInput: string,
): boolean {
  return policy.deny?.some((entry) => {
    const { nameGlob, argGlob } = parseDenyEntry(entry);
    if (argGlob === undefined) return false; // bare-name: handled by evaluatePermission
    if (!globMatch(nameGlob, toolId)) return false;
    // Fail-safe: an empty argGlob (from malformed patterns like `name(` or `name()`) is treated
    // as `*` (match-all) so that a typo of `name(*)` denies rather than silently grants.
    const effectiveGlob = argGlob === "" ? "*" : argGlob;
    return globMatch(effectiveGlob, serializedInput);
  }) ?? false;
}

/**
 * Evaluate the permission for a single tool invocation.
 *
 * Order (design §10.4):
 * 1. No policy → allow (back-compat).
 * 2. BARE deny glob matches → deny. (Arg-scoped denies require input, evaluated at dispatch.)
 * 3. plan mode + non-read-only → deny.
 * 4. allow glob matches → allow.
 * 5. ask mode → ask.
 * 6. Default fall-through → allow.
 */
export function evaluatePermission(
  policy: PermissionPolicy | undefined,
  tool: { id: string; sideEffect: SideEffect },
): PermissionDecision {
  if (!policy) return "allow";

  // 2. Bare deny globs win over everything else.
  //    Arg-scoped denies are NOT evaluated here (no input available) — handled at dispatch.
  if (bareNameDenies(policy, tool.id)) return "deny";

  // 3. Plan mode: deny non-read-only tools.
  if (policy.mode === "plan" && tool.sideEffect !== "read-only") return "deny";

  // 4. Allow globs → allow (skip ask).
  if (policy.allow?.some((glob) => globMatch(glob, tool.id))) return "allow";

  // 5. Ask mode → ask (dynamic resolution at dispatch time).
  if (policy.mode === "ask") return "ask";

  // 6. All other modes (default, bypass, acceptEdits) fall through to allow.
  return "allow";
}

/**
 * Schema-layer filter: remove tools whose static permission decision is "deny".
 * "ask" and "allow" tools stay in the schema (ask is resolved dynamically at dispatch).
 * Arg-scoped deny entries (name(argGlob)) do NOT remove the tool from the schema —
 * the deny is conditional on the arguments seen at dispatch time.
 */
export function filterToolsForSchema(tools: Tool[], policy?: PermissionPolicy): Tool[] {
  if (!policy) return tools;
  return tools.filter((t) => evaluatePermission(policy, t) !== "deny");
}

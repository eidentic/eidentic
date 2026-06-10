/**
 * Render a prompt template by substituting `{{varName}}` placeholders.
 *
 * Rules:
 *   - Placeholders match `{{` + optional whitespace + identifier + optional
 *     whitespace + `}}`.
 *   - Every placeholder in `body` MUST have a corresponding key in `vars`; if
 *     any are missing a `PromptRenderError` is thrown listing all missing names.
 *   - No escaping is applied — `body` is operator-controlled content and is
 *     trusted as-is.
 *   - Values in `vars` are inserted verbatim.
 *
 * @example
 * ```ts
 * const result = renderPrompt(
 *   "You are a {{role}} assistant. Today is {{date}}.",
 *   { role: "helpful", date: "2026-06-10" },
 * );
 * // → "You are a helpful assistant. Today is 2026-06-10."
 * ```
 */
export function renderPrompt(
  body: string,
  vars: Record<string, string>,
): string {
  const PLACEHOLDER = /\{\{\s*([A-Za-z_][A-Za-z0-9_]*)\s*\}\}/g;

  const missing: string[] = [];
  const result = body.replace(PLACEHOLDER, (_match, name: string) => {
    if (!(name in vars)) {
      missing.push(name);
      return _match; // keep placeholder so all missing names can be collected
    }
    return vars[name]!;
  });

  if (missing.length > 0) {
    throw new PromptRenderError(
      `renderPrompt: missing variable(s): ${missing.map((n) => `"${n}"`).join(", ")}`,
      missing,
    );
  }

  return result;
}

/** Thrown by {@link renderPrompt} when one or more template variables are absent. */
export class PromptRenderError extends Error {
  /** Names of the variables that were not supplied. */
  readonly missingVars: readonly string[];

  constructor(message: string, missingVars: string[]) {
    super(message);
    this.name = "PromptRenderError";
    this.missingVars = missingVars;
  }
}

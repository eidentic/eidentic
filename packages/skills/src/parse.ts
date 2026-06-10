import { parse as parseYaml } from "yaml";

/**
 * Parsed SKILL.md manifest. `allowedTools` is the parsed form of frontmatter `allowed-tools`.
 * `metadata` captures all other frontmatter fields for round-trip / export interop (§7.10).
 */
export interface SkillManifest {
  name: string;
  description: string;
  allowedTools?: string[];
  license?: string;
  version?: string;
  /** All other frontmatter fields not explicitly mapped above. */
  metadata?: Record<string, unknown>;
}

const NAME_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
// Matches both `---\n...\n---` and `---\n...\n---\n` (optional trailing newline).
const FRONTMATTER_RE = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/;

/**
 * Real-YAML SKILL.md parser (uses the `yaml` package for full spec compatibility).
 * Handles: block-list `allowed-tools`, quoted scalars, folded `>` descriptions, inline
 * `#` comments, `license`/`version`/`metadata` and any other frontmatter fields (§7.10).
 * Throws a clear error on malformed input.
 */
export function parseSkillMd(
  content: string,
): { manifest: SkillManifest; body: string } {
  content = content.replace(/\r\n/g, "\n");
  const m = FRONTMATTER_RE.exec(content);
  if (!m) throw new Error("parseSkillMd: missing `---` frontmatter fences");
  const fmText = m[1]!;
  const body = m[2]!.trim();

  let fm: unknown;
  try {
    fm = parseYaml(fmText);
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(`parseSkillMd: malformed YAML frontmatter — ${msg}`);
  }

  if (fm === null || typeof fm !== "object" || Array.isArray(fm)) {
    throw new Error("parseSkillMd: frontmatter must be a YAML mapping");
  }

  const fields = fm as Record<string, unknown>;

  // --- name (required) ---
  if (!("name" in fields)) throw new Error("parseSkillMd: missing required `name`");
  const name = fields["name"];
  if (typeof name !== "string") throw new Error("parseSkillMd: `name` must be a string");
  if (!NAME_RE.test(name)) throw new Error(`parseSkillMd: \`name\` must be kebab-case, got "${name}"`);
  if (name.length > 64) throw new Error("parseSkillMd: `name` must be ≤64 chars");

  // --- description (required) ---
  if (!("description" in fields)) throw new Error("parseSkillMd: missing required `description`");
  const description = fields["description"];
  if (typeof description !== "string") throw new Error("parseSkillMd: `description` must be a string");
  // Trim trailing newline that YAML block scalars add, normalise to single trailing newline-free string.
  const descTrimmed = description.trimEnd();
  if (descTrimmed.length > 1024) throw new Error("parseSkillMd: `description` must be ≤1024 chars");

  const manifest: SkillManifest = { name, description: descTrimmed };

  // --- allowed-tools (optional; both inline array and YAML block-list) ---
  if ("allowed-tools" in fields) {
    const at = fields["allowed-tools"];
    if (Array.isArray(at)) {
      const tools = at.map((t) => String(t).trim()).filter(Boolean);
      if (tools.length > 0) manifest.allowedTools = tools;
    } else if (typeof at === "string" && at.trim() !== "") {
      // Fallback: inline flow string like "[bash, read]"
      const tools = at.replace(/^\[/, "").replace(/\]$/, "").split(",").map((s) => s.trim()).filter(Boolean);
      if (tools.length > 0) manifest.allowedTools = tools;
    }
  }

  // --- license / version (optional, surfaced as typed fields) ---
  if ("license" in fields && typeof fields["license"] === "string") {
    manifest.license = fields["license"];
  }
  if ("version" in fields && typeof fields["version"] !== "undefined") {
    manifest.version = String(fields["version"]);
  }

  // --- metadata: all other keys ---
  const knownKeys = new Set(["name", "description", "allowed-tools", "license", "version"]);
  const extra: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(fields)) {
    if (!knownKeys.has(k)) extra[k] = v;
  }
  if (Object.keys(extra).length > 0) manifest.metadata = extra;

  return { manifest, body };
}

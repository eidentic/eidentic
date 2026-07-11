import type { SecretsPort } from "@eidentic/types";

/**
 * SecretsPort backed by an explicit allowlist over `process.env`.
 * Pass `"*"` only as an intentional legacy escape hatch; the secure default exposes nothing.
 */
export class EnvSecrets implements SecretsPort {
  private readonly allowed: ReadonlySet<string> | "*";

  constructor(
    allowedRefs: readonly string[] | "*" = [],
    private readonly env: Record<string, string | undefined> = process.env,
  ) {
    this.allowed = allowedRefs === "*" ? "*" : new Set(allowedRefs);
  }

  async get(ref: string): Promise<string | undefined> {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(ref)) {
      throw new Error(`EnvSecrets: invalid secret ref '${ref}'`);
    }
    if (this.allowed !== "*" && !this.allowed.has(ref)) {
      throw new Error(`EnvSecrets: secret ref '${ref}' is not allowed`);
    }
    return this.env[ref];
  }
}

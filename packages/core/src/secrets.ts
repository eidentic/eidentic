import type { SecretsPort } from "@eidentic/types";

/** SecretsPort backed by `process.env`. The model never sees the values; tools fetch them at call time (§10.3). */
export class EnvSecrets implements SecretsPort {
  async get(ref: string): Promise<string | undefined> {
    return process.env[ref];
  }
}

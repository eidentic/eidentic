/**
 * SHA-256 hex digest of a UTF-8 string.
 *
 * Uses the Node.js `crypto` built-in — no third-party dependency.
 * This module is intentionally kept separate so it can be tree-shaken
 * and stubbed in tests.
 */
import { createHash } from "node:crypto";

export function sha256(input: string): string {
  return createHash("sha256").update(input, "utf8").digest("hex");
}

/**
 * Map a string key deterministically to a value in [0, 1) using the low 32
 * bits of its SHA-256 as a uniform sample.
 *
 * This is used by the canary splitter to assign traffic arms.
 */
export function keyToFraction(key: string): number {
  const hex = sha256(key).slice(0, 8); // 32 bits — enough resolution
  const int = parseInt(hex, 16);
  return int / 0x1_0000_0000; // divide by 2^32 → [0, 1)
}

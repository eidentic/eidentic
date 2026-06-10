/**
 * Shared SHA-256 hex helper using the Web Crypto API (`globalThis.crypto.subtle`).
 *
 * Works zero-config on:
 *   - Node.js 18+ (global crypto available since v18.0, no flag needed)
 *   - Bun (built-in Web Crypto)
 *   - Deno (built-in Web Crypto)
 *   - Cloudflare Workers (native Web Crypto, no nodejs_compat flag required)
 *   - Browsers (native Web Crypto)
 *
 * Output is lowercase hex — byte-identical to the previous node:crypto sha256 hex output,
 * so existing event-replay hashes (checkpoints, idempotency keys) continue to match.
 */
export async function sha256Hex(input: string): Promise<string> {
  const encoded = new TextEncoder().encode(input);
  const hashBuffer = await globalThis.crypto.subtle.digest("SHA-256", encoded);
  const bytes = new Uint8Array(hashBuffer);
  let hex = "";
  for (let i = 0; i < bytes.length; i++) {
    hex += bytes[i]!.toString(16).padStart(2, "0");
  }
  return hex;
}

import {
  generateKeyPairSync,
  sign as cryptoSign,
  verify as cryptoVerify,
  createPublicKey,
  createPrivateKey,
} from "node:crypto";
import { canonicalJson } from "@eidentic/types";
import type { SkillLock } from "./executable.js";

/** An ed25519 keypair serialized as PEM strings (SPKI public, PKCS8 private). */
export interface SkillKeypair {
  publicKey: string;  // SPKI PEM
  privateKey: string; // PKCS8 PEM
}

/** Generate an ed25519 keypair for signing skill locks (§7.6). PEM strings for easy storage/transport. */
export function generateSkillKeypair(): SkillKeypair {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  return {
    publicKey: publicKey.export({ type: "spki", format: "pem" }).toString(),
    privateKey: privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
  };
}

/** The bytes that are signed/verified: the canonical lock MINUS its `signature` field. */
function canonicalLockBytes(lock: SkillLock): Buffer {
  const { signature: _omit, ...rest } = lock;
  return Buffer.from(canonicalJson(rest));
}

/**
 * Sign a lock with an ed25519 private key (PEM). Returns a base64 signature string (§7.6).
 *
 * NOTE: the signature covers ALL mutable lock fields (except `signature` itself), so
 * `approve()` and any other lock mutation MUST happen BEFORE signing. Re-signing is required
 * after any change; under `requireSigned` a stale signature correctly fails `use()`.
 */
export function signLock(lock: SkillLock, privateKeyPem: string): string {
  const key = createPrivateKey(privateKeyPem);
  const sig = cryptoSign(null, canonicalLockBytes(lock), key);
  return sig.toString("base64");
}

/**
 * Verify a lock's `signature` against an ed25519 public key (PEM).
 * Returns false (never throws) on mismatch, missing signature, or malformed key.
 */
export function verifyLock(lock: SkillLock, publicKeyPem: string): boolean {
  if (typeof lock.signature !== "string" || lock.signature.length === 0) return false;
  try {
    const key = createPublicKey(publicKeyPem);
    return cryptoVerify(
      null,
      canonicalLockBytes(lock),
      key,
      Buffer.from(lock.signature, "base64"),
    );
  } catch {
    return false; // malformed key/signature ⇒ treat as unverified
  }
}

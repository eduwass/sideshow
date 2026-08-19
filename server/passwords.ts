// Share-link passwords. Runtime-agnostic: scrypt-js is pure JavaScript, so the
// same code runs on Node and inside a Durable Object (workerd has no
// node:crypto scrypt, and Web Crypto only offers PBKDF2, which is not
// memory-hard).
//
// A share-link password is a low-entropy human secret guarding a capability
// URL, so the hash has to be expensive to attack offline: scrypt with N=2^14,
// r=8, p=1 costs ~16 MB of memory per guess. Plaintext is never stored and
// never logged — only the encoded string below is persisted.

import scryptJs from "scrypt-js";

export const SCRYPT_N = 16384;
export const SCRYPT_R = 8;
export const SCRYPT_P = 1;
export const SCRYPT_KEY_BYTES = 32;
export const SCRYPT_SALT_BYTES = 16;

// A password is a human secret; bound it so a huge body can't be turned into a
// memory-hard denial of service.
export const MAX_PASSWORD_BYTES = 256;

const toBase64 = (bytes: Uint8Array): string => btoa(String.fromCharCode(...bytes));

const fromBase64 = (value: string): Uint8Array => {
  const binary = atob(value);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
  return out;
};

// Length-safe equality that does not short-circuit on the first differing byte.
export function timingSafeEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
  return diff === 0;
}

const encode = (value: string): Uint8Array => new TextEncoder().encode(value);

/**
 * Hash a password into the self-describing `scrypt$N$r$p$salt$key` form, so the
 * parameters can be raised later without invalidating existing hashes.
 */
export async function hashPassword(password: string): Promise<string> {
  const bytes = encode(password);
  if (bytes.length > MAX_PASSWORD_BYTES) throw new Error("password too long");
  const salt = crypto.getRandomValues(new Uint8Array(SCRYPT_SALT_BYTES));
  const key = await scryptJs.scrypt(bytes, salt, SCRYPT_N, SCRYPT_R, SCRYPT_P, SCRYPT_KEY_BYTES);
  return `scrypt$${SCRYPT_N}$${SCRYPT_R}$${SCRYPT_P}$${toBase64(salt)}$${toBase64(
    new Uint8Array(key),
  )}`;
}

/**
 * Verify a candidate against an encoded hash. Returns false — never throws —
 * for a malformed or unknown-scheme hash, so a corrupt row fails closed.
 */
export async function verifyPassword(password: string, encoded: string): Promise<boolean> {
  const bytes = encode(password);
  if (bytes.length > MAX_PASSWORD_BYTES) return false;
  const parts = encoded.split("$");
  if (parts.length !== 6 || parts[0] !== "scrypt") return false;
  const n = Number(parts[1]);
  const r = Number(parts[2]);
  const p = Number(parts[3]);
  // Bound the cost read off the stored hash: a tampered row must not be able to
  // ask for an unbounded allocation.
  if (
    !Number.isInteger(n) ||
    !Number.isInteger(r) ||
    !Number.isInteger(p) ||
    n < 2 ||
    n > 1 << 20 ||
    r < 1 ||
    r > 32 ||
    p < 1 ||
    p > 16
  ) {
    return false;
  }
  let salt: Uint8Array;
  let expected: Uint8Array;
  try {
    salt = fromBase64(parts[4]);
    expected = fromBase64(parts[5]);
  } catch {
    return false;
  }
  if (salt.length === 0 || expected.length === 0) return false;
  const key = await scryptJs.scrypt(bytes, salt, n, r, p, expected.length);
  return timingSafeEqual(new Uint8Array(key), expected);
}

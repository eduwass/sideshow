// Approximate visitor identity for confirmed opens, without retaining anything
// that identifies a person. The stored value is a keyed hash of (IP, user
// agent) under a secret that rotates on a fixed window, so:
//
//   - the raw IP is never persisted, and
//   - the hash stops being linkable to the same visitor once the window turns,
//     which is what keeps "approximate uniques" from becoming a durable
//     cross-publication tracker.
//
// Analytics built on this are likely-recipient activity, never proof of who
// opened a link.

export const VISITOR_WINDOW_DAYS = 7;

// The rotation bucket an instant falls in: whole weeks since the epoch. Coarse
// on purpose — a shorter window would inflate "uniques" for a client who reads
// a publication across several days.
export function visitorWindow(now: number = Date.now()): string {
  const days = Math.floor(now / 86_400_000);
  return `w${Math.floor(days / VISITOR_WINDOW_DAYS)}`;
}

const HEX = "0123456789abcdef";

function toHex(bytes: Uint8Array, chars: number): string {
  let out = "";
  for (let i = 0; i < bytes.length && out.length < chars; i++) {
    out += HEX[bytes[i] >> 4] + HEX[bytes[i] & 15];
  }
  return out.slice(0, chars);
}

/**
 * Keyed hash of a visitor for one share link. `secret` is the deployment's
 * server-side secret; it never leaves the server, so the hash cannot be
 * recomputed from the outside to confirm a guess about who opened a link.
 */
export async function computeVisitorHash(input: {
  secret: string;
  shareLinkId: string;
  ip: string;
  userAgent: string;
  now?: number;
}): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(`${input.secret}:${visitorWindow(input.now)}`),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signature = await crypto.subtle.sign(
    "HMAC",
    key,
    new TextEncoder().encode(`${input.shareLinkId}\n${input.ip}\n${input.userAgent}`),
  );
  return toHex(new Uint8Array(signature), 32);
}

// Coarse device class from a user agent. Deliberately three buckets: enough to
// tell "they opened it on their phone" from "at a desk", not enough to
// fingerprint.
export function deviceClass(userAgent: string): "mobile" | "tablet" | "desktop" {
  const ua = userAgent.toLowerCase();
  if (/\b(ipad|tablet)\b/.test(ua) || (ua.includes("android") && !ua.includes("mobile"))) {
    return "tablet";
  }
  if (/\b(iphone|ipod|mobile|android)\b/.test(ua)) return "mobile";
  return "desktop";
}

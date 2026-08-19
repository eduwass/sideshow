import assert from "node:assert/strict";
import { test } from "node:test";
import {
  hashPassword,
  MAX_PASSWORD_BYTES,
  SCRYPT_N,
  SCRYPT_P,
  SCRYPT_R,
  timingSafeEqual,
  verifyPassword,
} from "../server/passwords.ts";

// scrypt at N=16384 costs ~50-150ms per call, so keep hashing calls few and
// give the hashing tests room.
const SLOW = { timeout: 30_000 };

test("hashPassword round-trips and salts every hash", SLOW, async () => {
  const encoded = await hashPassword("correct horse battery staple");
  assert.ok(encoded.startsWith(`scrypt$${SCRYPT_N}$${SCRYPT_R}$${SCRYPT_P}$`));
  assert.equal(encoded.split("$").length, 6);
  assert.equal(await verifyPassword("correct horse battery staple", encoded), true);
  assert.equal(await verifyPassword("wrong horse battery staple", encoded), false);

  const again = await hashPassword("correct horse battery staple");
  assert.notEqual(again, encoded, "a random salt must make each hash unique");
  assert.equal(await verifyPassword("correct horse battery staple", again), true);
});

test("verifyPassword fails closed on a malformed or hostile hash", SLOW, async () => {
  const bogus: string[] = [
    "",
    "notascheme$1$2$3$4$5",
    "scrypt$16384$8$1$AAAAAAAAAAAAAAAAAAAAAA==", // only 5 parts
    "argon2$16384$8$1$AAAAAAAAAAAAAAAAAAAAAA==$AAAA",
    "scrypt$abc$8$1$AAAA$AAAA", // non-numeric N
    "scrypt$16384.5$8$1$AAAA$AAAA", // non-integer N
    "scrypt$1$8$1$AAAA$AAAA", // N below the floor
    "scrypt$99999999$8$1$AAAA$AAAA", // N above the ceiling
    "scrypt$16384$0$1$AAAA$AAAA", // r below the floor
    "scrypt$16384$64$1$AAAA$AAAA", // r above the ceiling
    "scrypt$16384$8$0$AAAA$AAAA", // p below the floor
    "scrypt$16384$8$99$AAAA$AAAA", // p above the ceiling
    "scrypt$16384$8$1$!!!!$AAAA", // salt is not base64
    "scrypt$16384$8$1$AAAA$!!!!", // key is not base64
    "scrypt$16384$8$1$$AAAA", // empty salt
    "scrypt$16384$8$1$AAAA$", // empty key
  ];
  for (const encoded of bogus) {
    assert.equal(await verifyPassword("hunter2", encoded), false, JSON.stringify(encoded));
  }
});

test("passwords are length-bounded so they cannot be a memory-hard DoS", SLOW, async () => {
  const huge = "a".repeat(MAX_PASSWORD_BYTES + 1);
  await assert.rejects(() => hashPassword(huge), /password too long/);
  // A stored hash is never even consulted for an oversized candidate.
  assert.equal(await verifyPassword(huge, "scrypt$16384$8$1$AAAAAAAAAAAAAAAAAAAAAA==$AAAA"), false);
});

test("timingSafeEqual compares length and content without short-circuiting", () => {
  const a = new Uint8Array([1, 2, 3, 4]);
  assert.equal(timingSafeEqual(a, new Uint8Array([1, 2, 3, 4])), true);
  assert.equal(timingSafeEqual(a, new Uint8Array([1, 2, 3])), false);
  assert.equal(timingSafeEqual(a, new Uint8Array([1, 2, 3, 5])), false);
  assert.equal(timingSafeEqual(a, new Uint8Array([9, 2, 3, 4])), false);
  assert.equal(timingSafeEqual(new Uint8Array(0), new Uint8Array(0)), true);
});

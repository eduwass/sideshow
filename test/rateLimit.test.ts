import assert from "node:assert/strict";
import { test } from "node:test";
import { RateLimiter } from "../server/rateLimit.ts";

test("take allows exactly the limit, per key, then denies", () => {
  const limiter = new RateLimiter(3, 1000);
  assert.equal(limiter.take("a", 0), true);
  assert.equal(limiter.take("a", 10), true);
  assert.equal(limiter.take("a", 20), true);
  assert.equal(limiter.take("a", 30), false);
  assert.equal(limiter.take("a", 40), false);

  // A different key has its own budget.
  assert.equal(limiter.take("b", 40), true);
  assert.equal(limiter.take("b", 41), true);
  assert.equal(limiter.take("b", 42), true);
  assert.equal(limiter.take("b", 43), false);
});

test("the window resets the budget once it passes", () => {
  const limiter = new RateLimiter(2, 1000);
  assert.equal(limiter.take("a", 0), true);
  assert.equal(limiter.take("a", 0), true);
  assert.equal(limiter.take("a", 999), false);
  assert.equal(limiter.take("a", 1000), true, "resetAt <= now reopens the window");
  assert.equal(limiter.take("a", 1001), true);
  assert.equal(limiter.take("a", 1002), false);
});

test("retryAfter is zero for an unused or expired key and at least a second inside a window", () => {
  const limiter = new RateLimiter(1, 5000);
  assert.equal(limiter.retryAfter("unused", 0), 0);
  limiter.take("a", 0);
  assert.equal(limiter.retryAfter("a", 0), 5);
  assert.equal(limiter.retryAfter("a", 4999), 1, "always rounds up to a whole second");
  assert.equal(limiter.retryAfter("a", 5000), 0);
});

test("expired buckets are pruned once the map grows, without changing behaviour", () => {
  const limiter = new RateLimiter(1, 1000);
  for (let i = 0; i < 5000; i++) assert.equal(limiter.take(`k${i}`, 0), true);
  // Every bucket above has expired by now, so the next miss triggers the prune.
  assert.equal(limiter.take("fresh", 2000), true);
  // A pruned key behaves like an unseen one, and the limiter still limits.
  assert.equal(limiter.retryAfter("k0", 2000), 0);
  assert.equal(limiter.take("k0", 2000), true);
  assert.equal(limiter.take("k0", 2001), false);
  assert.equal(limiter.take("fresh", 2001), false);
});

import assert from "node:assert/strict";
import { test } from "node:test";
import { computeVisitorHash, deviceClass, visitorWindow } from "../server/visitorHash.ts";

const DAY = 86_400_000;
const base = { secret: "s3cret", shareLinkId: "link-1", ip: "1.2.3.4", userAgent: "UA/1.0" };

test("visitorWindow is stable inside a 7-day bucket and rotates across it", () => {
  const start = 7 * DAY * 100; // exactly on a bucket boundary
  assert.equal(visitorWindow(start), visitorWindow(start + 6 * DAY));
  assert.equal(visitorWindow(start), visitorWindow(start + 7 * DAY - 1));
  assert.notEqual(visitorWindow(start), visitorWindow(start + 7 * DAY));
  assert.notEqual(visitorWindow(start), visitorWindow(start - 1));
  assert.match(visitorWindow(start), /^w\d+$/);
  assert.equal(typeof visitorWindow(), "string");
});

test("computeVisitorHash is a deterministic 32-hex keyed digest", async () => {
  const now = 7 * DAY * 100;
  const hash = await computeVisitorHash({ ...base, now });
  assert.match(hash, /^[0-9a-f]{32}$/);
  assert.equal(await computeVisitorHash({ ...base, now }), hash);

  // Every input is part of the key or the message.
  const variants = [
    { ...base, ip: "5.6.7.8", now },
    { ...base, userAgent: "UA/2.0", now },
    { ...base, shareLinkId: "link-2", now },
    { ...base, secret: "other", now },
    { ...base, now: now + 7 * DAY },
  ];
  for (const variant of variants) {
    assert.notEqual(await computeVisitorHash(variant), hash, JSON.stringify(variant));
  }
  // Inside the same window the hash is unchanged, which is what makes uniques
  // countable at all.
  assert.equal(await computeVisitorHash({ ...base, now: now + 6 * DAY }), hash);
  // Defaulting the clock still produces a well-formed hash.
  assert.match(await computeVisitorHash(base), /^[0-9a-f]{32}$/);
});

test("deviceClass buckets user agents into mobile/tablet/desktop", () => {
  const cases: [string, string][] = [
    ["Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15", "mobile"],
    ["Mozilla/5.0 (iPod touch; CPU iPhone OS 15_0 like Mac OS X)", "mobile"],
    ["Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 Chrome/120 Mobile", "mobile"],
    ["Mozilla/5.0 (iPad; CPU OS 17_0 like Mac OS X) AppleWebKit/605.1.15", "tablet"],
    ["Mozilla/5.0 (Linux; Android 13; SM-X700) AppleWebKit/537.36 Chrome/120 Safari", "tablet"],
    ["Mozilla/5.0 (Linux; Android 13) Tablet Safari", "tablet"],
    ["Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) Chrome/120.0 Safari/537.36", "desktop"],
    ["Mozilla/5.0 (X11; Linux x86_64; rv:121.0) Gecko/20100101 Firefox/121.0", "desktop"],
    ["", "desktop"],
  ];
  for (const [ua, expected] of cases) assert.equal(deviceClass(ua), expected, ua);
});

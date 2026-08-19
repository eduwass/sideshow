import assert from "node:assert/strict";
import { test } from "node:test";
import {
  DEFAULT_RUNTIME_ROLE,
  isLoopbackHost,
  isPublicRole,
  privateBindingCheck,
  resolveRole,
} from "../server/role.ts";

// The whole point of the role split is that only the exact string "public"
// opens the public runtime; everything else must fail closed.

test("resolveRole opens only for an exact (trimmed, lowercased) 'public'", () => {
  assert.equal(DEFAULT_RUNTIME_ROLE, "private");
  for (const value of ["public", "PUBLIC", " public ", "  Public\n"]) {
    assert.equal(resolveRole(value), "public", value);
    assert.equal(isPublicRole(value), true, value);
  }
  for (const value of [
    "private",
    "",
    "  ",
    "publicish",
    "pub",
    "public-service",
    undefined,
    null,
  ]) {
    assert.equal(resolveRole(value), "private", String(value));
    assert.equal(isPublicRole(value), false, String(value));
  }
});

test("isLoopbackHost recognises the loopback spellings and nothing else", () => {
  for (const host of ["127.0.0.1", "::1", "localhost", "[::1]", " LOCALHOST "]) {
    assert.equal(isLoopbackHost(host), true, host);
  }
  for (const host of ["0.0.0.0", "10.0.0.5", "example.com", "127.0.0.2", "", undefined, null]) {
    assert.equal(isLoopbackHost(host), false, String(host));
  }
});

test("privateBindingCheck warns when exposed and refuses when loopback is required", () => {
  const cases: {
    name: string;
    input: { hostname: string | undefined; token: string | undefined; requireLoopback: boolean };
    ok: boolean;
    message: boolean;
  }[] = [
    {
      name: "loopback + token",
      input: { hostname: "127.0.0.1", token: "t", requireLoopback: false },
      ok: true,
      message: false,
    },
    {
      name: "loopback, no token, not required",
      input: { hostname: "127.0.0.1", token: undefined, requireLoopback: false },
      ok: true,
      message: false,
    },
    {
      name: "exposed, no token",
      input: { hostname: "0.0.0.0", token: undefined, requireLoopback: false },
      ok: true,
      message: true,
    },
    {
      name: "exposed + token",
      input: { hostname: "0.0.0.0", token: "t", requireLoopback: false },
      ok: true,
      message: false,
    },
    {
      name: "required + exposed",
      input: { hostname: "0.0.0.0", token: "t", requireLoopback: true },
      ok: false,
      message: true,
    },
    {
      name: "required + loopback, no token",
      input: { hostname: "127.0.0.1", token: undefined, requireLoopback: true },
      ok: false,
      message: true,
    },
    {
      name: "required + loopback + token",
      input: { hostname: "127.0.0.1", token: "t", requireLoopback: true },
      ok: true,
      message: false,
    },
  ];

  for (const { name, input, ok, message } of cases) {
    const result = privateBindingCheck(input);
    assert.equal(result.ok, ok, name);
    assert.equal(result.message !== undefined, message, name);
  }
});

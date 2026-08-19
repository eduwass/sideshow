import assert from "node:assert/strict";
import { test } from "node:test";
import { DestinationClient, DestinationError, resolveDestination } from "../server/destination.ts";

const TOKEN = "owner-token-do-not-leak";

test("resolveDestination refuses a half-configured or cleartext destination", () => {
  assert.equal(resolveDestination(undefined, TOKEN), null);
  assert.equal(resolveDestination("", TOKEN), null);
  assert.equal(resolveDestination("https://show.example.com", undefined), null);
  assert.equal(resolveDestination("https://show.example.com", ""), null);
  assert.equal(resolveDestination("not a url", TOKEN), null);
  assert.equal(resolveDestination("http://show.example.com", TOKEN), null);
});

test("resolveDestination accepts https and localhost, and keeps only the origin", () => {
  assert.deepEqual(resolveDestination("https://show.example.com", TOKEN), {
    origin: "https://show.example.com",
    token: TOKEN,
  });
  assert.deepEqual(resolveDestination("https://show.example.com/api/owner/x?q=1", TOKEN), {
    origin: "https://show.example.com",
    token: TOKEN,
  });
  assert.deepEqual(resolveDestination("http://localhost:1234/", TOKEN), {
    origin: "http://localhost:1234",
    token: TOKEN,
  });
});

const client = (impl: typeof fetch) =>
  new DestinationClient({ origin: "https://show.example.com", token: TOKEN }, impl);

test("the client exposes the origin it will call, and nothing else", () => {
  assert.equal(
    client((async () => new Response(null)) as unknown as typeof fetch).origin,
    "https://show.example.com",
  );
});

test("request authenticates, defaults the content type, and parses the response", async () => {
  const calls: { url: string; init: RequestInit }[] = [];
  const stub = (async (url: string | URL | Request, init: RequestInit = {}) => {
    calls.push({ url: String(url), init });
    return new Response(JSON.stringify({ ok: true }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }) as unknown as typeof fetch;

  const result = await client(stub).request<{ ok: boolean }>("/api/owner/publications", {
    method: "POST",
    body: JSON.stringify({ kind: "post" }),
  });
  assert.deepEqual(result, { ok: true });
  assert.equal(calls[0].url, "https://show.example.com/api/owner/publications");
  const headers = calls[0].init.headers as Headers;
  assert.equal(headers.get("authorization"), `Bearer ${TOKEN}`);
  assert.equal(headers.get("content-type"), "application/json");
});

test("request leaves a bodiless call and an explicit content type alone", async () => {
  const seen: Headers[] = [];
  const stub = (async (_url: string, init: RequestInit = {}) => {
    seen.push(init.headers as Headers);
    return new Response(null, { status: 204 });
  }) as unknown as typeof fetch;

  const c = client(stub);
  assert.equal(await c.request("/api/owner/health"), undefined, "204 resolves to undefined");
  assert.equal(seen[0].has("content-type"), false);

  await c.request("/a/x", {
    method: "PUT",
    body: "raw",
    headers: { "content-type": "text/plain" },
  });
  assert.equal(seen[1].get("content-type"), "text/plain");
  assert.equal(seen[1].get("authorization"), `Bearer ${TOKEN}`);
});

test("a failing request throws DestinationError without leaking the token", async () => {
  const fail = (body: string | null, status: number, json = true) =>
    client(
      (async () =>
        new Response(body, {
          status,
          ...(json && { headers: { "content-type": "application/json" } }),
        })) as unknown as typeof fetch,
    );

  await assert.rejects(
    () => fail(JSON.stringify({ error: "unauthorized" }), 401).request("/api/owner/publications"),
    (err: unknown) => {
      assert.ok(err instanceof DestinationError);
      assert.equal(err.name, "DestinationError");
      assert.equal(err.status, 401);
      assert.equal(err.message, "unauthorized");
      assert.equal(String(err.stack).includes(TOKEN), false);
      return true;
    },
  );

  await assert.rejects(
    () => fail("<html>gateway</html>", 502, false).request("/api/owner/publications"),
    (err: unknown) => {
      assert.ok(err instanceof DestinationError);
      assert.equal(err.status, 502);
      assert.equal(err.message, "destination returned 502");
      assert.equal(err.message.includes(TOKEN), false);
      return true;
    },
  );
});

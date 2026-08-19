import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp } from "../server/app.ts";
import { createPublicApp } from "../server/publicApp.ts";
import { createSqliteStorage } from "../server/sqliteStorage.ts";
import { SqlStore } from "../server/sqlStore.ts";
import { JsonFileStore } from "../server/storage.ts";

// The two runtimes wired together in process: the private workspace publishes
// over its destination client, and the shim answers those server-to-server
// calls with the real public app instead of the network. Shared by every
// publishing test so the wiring exists in exactly one place.

export const DEST_ORIGIN = "https://pub.test";
export const OWNER_TOKEN = "owner-token-value";
export const IMAGE_BYTES = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]);

export type TestApp = { request: (u: string, i?: RequestInit) => Response | Promise<Response> };

/** Fail one destination call. Return a Response to answer it instead. */
export type Interceptor = (path: string, init: RequestInit) => Response | null;

export function makeStack() {
  const publicStore = new SqlStore(createSqliteStorage());
  const publicApp = createPublicApp({
    store: publicStore,
    ownerToken: OWNER_TOKEN,
    visitorSecret: "visitor-secret",
  });

  const dir = mkdtempSync(join(tmpdir(), "sideshow-publish-"));
  const privateStore = new JsonFileStore(join(dir, "data.json"));

  const calls: { method: string; path: string }[] = [];
  let intercept: Interceptor | null = null;

  const destinationFetch = (async (url: string | URL | Request, init: RequestInit = {}) => {
    const target = String(url);
    assert.ok(target.startsWith(DEST_ORIGIN), `unexpected destination call to ${target}`);
    const path = target.slice(DEST_ORIGIN.length);
    calls.push({ method: init.method ?? "GET", path });
    // The token must actually travel on every server-to-server call.
    assert.equal(
      new Headers(init.headers).get("authorization"),
      `Bearer ${OWNER_TOKEN}`,
      `${path} was called unauthenticated`,
    );
    return intercept?.(path, init) ?? publicApp.request(target, init);
  }) as unknown as typeof fetch;

  const app = createApp({
    store: privateStore,
    viewerHtml: "<html><head></head><body>viewer</body></html>",
    guideMarkdown: "# guide",
    setupText: "# setup",
    destination: { origin: DEST_ORIGIN, token: OWNER_TOKEN },
    destinationFetch,
  });

  return {
    app: app as unknown as TestApp,
    publicApp: publicApp as unknown as TestApp,
    publicStore,
    privateStore,
    calls,
    setIntercept: (fn: Interceptor | null) => {
      intercept = fn;
    },
  };
}

export type Stack = ReturnType<typeof makeStack>;

export const json = (body: unknown) => ({
  method: "POST",
  headers: { "content-type": "application/json", "sec-fetch-site": "same-origin" },
  body: JSON.stringify(body),
});

export const patch = (body: unknown) => ({
  method: "PATCH",
  headers: { "content-type": "application/json", "sec-fetch-site": "same-origin" },
  body: JSON.stringify(body),
});

/** An authenticated read of the public runtime's owner API. */
export const owner = (publicApp: TestApp, path: string) =>
  publicApp.request(`${DEST_ORIGIN}${path}`, {
    headers: { authorization: `Bearer ${OWNER_TOKEN}` },
  });

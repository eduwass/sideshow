import { serve } from "@hono/node-server";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createApp } from "./app.ts";
import { JsonFileStore } from "./storage.ts";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

const [viewerHtml, guideMarkdown, setupText] = await Promise.all([
  readFile(join(root, "viewer", "index.html"), "utf8"),
  readFile(join(root, "guide", "DESIGN_GUIDE.md"), "utf8"),
  readFile(join(root, "guide", "AGENT_SETUP.md"), "utf8"),
]);

const app = createApp({
  store: new JsonFileStore(process.env.SIDESHOW_DATA ?? join(root, "data", "sideshow.json")),
  viewerHtml,
  guideMarkdown,
  setupText,
  authToken: process.env.SIDESHOW_TOKEN,
});

const port = Number(process.env.PORT ?? 4242);

serve({ fetch: app.fetch, port }, (info) => {
  console.log(`sideshow listening on http://localhost:${info.port}`);
});

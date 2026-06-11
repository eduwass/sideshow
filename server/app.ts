import { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import { broadcast, subscribe, type FeedEvent } from "./events.ts";
import { renderSnippetPage } from "./snippetPage.ts";
import type { Snippet, Store } from "./storage.ts";

const MAX_HTML_BYTES = 2 * 1024 * 1024;
const MAX_WAIT_SECONDS = 300;

export interface AppOptions {
  store: Store;
  viewerHtml: string;
  guideMarkdown: string;
  setupText: string;
  // Optional bearer token for mutating routes — unused locally, ready for cloud.
  authToken?: string;
}

const snippetMeta = (s: Snippet) => ({
  id: s.id,
  sessionId: s.sessionId,
  title: s.title,
  createdAt: s.createdAt,
  updatedAt: s.updatedAt,
  version: s.version,
});

export function createApp({ store, viewerHtml, guideMarkdown, setupText, authToken }: AppOptions) {
  const app = new Hono();

  app.use("/api/*", async (c, next) => {
    if (authToken && c.req.method !== "GET") {
      if (c.req.header("authorization") !== `Bearer ${authToken}`) {
        return c.json({ error: "unauthorized" }, 401);
      }
    }
    await next();
  });

  app.get("/", (c) => c.html(viewerHtml));
  app.get("/guide", (c) => c.text(guideMarkdown));
  app.get("/setup", (c) => c.text(setupText));

  // --- sessions ---

  app.get("/api/sessions", async (c) => {
    const [sessions, snippets] = await Promise.all([store.listSessions(), store.listSnippets()]);
    const counts = new Map<string, number>();
    for (const s of snippets) counts.set(s.sessionId, (counts.get(s.sessionId) ?? 0) + 1);
    return c.json(sessions.map((s) => ({ ...s, snippetCount: counts.get(s.id) ?? 0 })));
  });

  app.post("/api/sessions", async (c) => {
    const body = await c.req.json().catch(() => ({}));
    const session = await store.createSession({
      agent: typeof body.agent === "string" ? body.agent : "agent",
      title: typeof body.title === "string" ? body.title : undefined,
      cwd: typeof body.cwd === "string" ? body.cwd : undefined,
    });
    broadcast({ type: "session-created", id: session.id });
    return c.json(session, 201);
  });

  app.patch("/api/sessions/:id", async (c) => {
    const body = await c.req.json().catch(() => null);
    if (!body || typeof body.title !== "string") {
      return c.json({ error: 'body must include "title" string' }, 400);
    }
    const session = await store.renameSession(c.req.param("id"), body.title);
    if (!session) return c.json({ error: "session not found" }, 404);
    broadcast({ type: "session-updated", id: session.id });
    return c.json(session);
  });

  app.delete("/api/sessions/:id", async (c) => {
    const id = c.req.param("id");
    if (!(await store.removeSession(id))) return c.json({ error: "session not found" }, 404);
    broadcast({ type: "session-deleted", id });
    return c.json({ ok: true });
  });

  app.get("/api/sessions/:id/snippets", async (c) => {
    const session = await store.getSession(c.req.param("id"));
    if (!session) return c.json({ error: "session not found" }, 404);
    const snippets = await store.listSnippets(session.id);
    return c.json(snippets.map(snippetMeta));
  });

  // --- snippets ---

  app.get("/api/snippets/:id", async (c) => {
    const snippet = await store.getSnippet(c.req.param("id"));
    if (!snippet) return c.json({ error: "snippet not found" }, 404);
    return c.json(snippet);
  });

  // Accepts either an existing session id, or agent/title fields to
  // auto-create a session — so a bare `curl` one-liner works with no ceremony.
  app.post("/api/snippets", async (c) => {
    const body = await c.req.json().catch(() => null);
    if (!body || typeof body.html !== "string" || !body.html.trim()) {
      return c.json({ error: 'body must include non-empty "html" string' }, 400);
    }
    if (body.html.length > MAX_HTML_BYTES) {
      return c.json({ error: `html exceeds ${MAX_HTML_BYTES} bytes` }, 413);
    }
    let sessionId: string | undefined = typeof body.session === "string" ? body.session : undefined;
    if (sessionId && !(await store.getSession(sessionId))) {
      return c.json({ error: `session "${sessionId}" not found` }, 404);
    }
    if (!sessionId) {
      const session = await store.createSession({
        agent: typeof body.agent === "string" ? body.agent : "agent",
        cwd: typeof body.cwd === "string" ? body.cwd : undefined,
      });
      broadcast({ type: "session-created", id: session.id });
      sessionId = session.id;
    }
    const snippet = await store.createSnippet({
      sessionId,
      html: body.html,
      title: typeof body.title === "string" ? body.title : undefined,
    });
    if (!snippet) return c.json({ error: "session disappeared" }, 500);
    broadcast({ type: "snippet-created", id: snippet.id, sessionId, version: 1 });
    return c.json(snippetMeta(snippet), 201);
  });

  app.put("/api/snippets/:id", async (c) => {
    const body = await c.req.json().catch(() => null);
    if (!body) return c.json({ error: "invalid JSON body" }, 400);
    if (typeof body.html === "string" && body.html.length > MAX_HTML_BYTES) {
      return c.json({ error: `html exceeds ${MAX_HTML_BYTES} bytes` }, 413);
    }
    const snippet = await store.updateSnippet(c.req.param("id"), {
      html: typeof body.html === "string" ? body.html : undefined,
      title: typeof body.title === "string" ? body.title : undefined,
    });
    if (!snippet) return c.json({ error: "snippet not found" }, 404);
    broadcast({
      type: "snippet-updated",
      id: snippet.id,
      sessionId: snippet.sessionId,
      version: snippet.version,
    });
    return c.json(snippetMeta(snippet));
  });

  app.delete("/api/snippets/:id", async (c) => {
    const snippet = await store.getSnippet(c.req.param("id"));
    if (!snippet) return c.json({ error: "snippet not found" }, 404);
    await store.removeSnippet(snippet.id);
    broadcast({ type: "snippet-deleted", id: snippet.id, sessionId: snippet.sessionId });
    return c.json({ ok: true });
  });

  // --- comments ---

  app.post("/api/comments", async (c) => {
    const body = await c.req.json().catch(() => null);
    if (!body || typeof body.text !== "string" || !body.text.trim()) {
      return c.json({ error: 'body must include non-empty "text" string' }, 400);
    }
    let sessionId: string | undefined = typeof body.session === "string" ? body.session : undefined;
    const snippetId: string | undefined =
      typeof body.snippet === "string" ? body.snippet : undefined;
    if (snippetId) {
      const snippet = await store.getSnippet(snippetId);
      if (!snippet) return c.json({ error: "snippet not found" }, 404);
      sessionId = snippet.sessionId;
    }
    if (!sessionId) return c.json({ error: 'provide "snippet" or "session" id' }, 400);
    const comment = await store.createComment({
      sessionId,
      snippetId,
      author: typeof body.author === "string" ? body.author : "user",
      text: body.text.trim(),
    });
    if (!comment) return c.json({ error: "session not found" }, 404);
    broadcast({
      type: "comment-created",
      id: comment.id,
      sessionId: comment.sessionId,
      snippetId: comment.snippetId,
      seq: comment.seq,
    });
    return c.json(comment, 201);
  });

  // Long-poll friendly: ?wait=N holds the request open up to N seconds until
  // a matching comment arrives. This is how terminal agents block on feedback.
  app.get("/api/comments", async (c) => {
    const sessionId = c.req.query("session");
    const snippetId = c.req.query("snippet");
    const author = c.req.query("author");
    const afterSeq = c.req.query("after") ? Number(c.req.query("after")) : undefined;
    const wait = Math.min(Number(c.req.query("wait") ?? 0) || 0, MAX_WAIT_SECONDS);

    const query = { sessionId, snippetId, afterSeq };
    const matches = (list: Awaited<ReturnType<Store["listComments"]>>) =>
      author ? list.filter((cm) => cm.author === author) : list;

    let comments = matches(await store.listComments(query));
    if (comments.length === 0 && wait > 0) {
      await new Promise<void>((resolve) => {
        const timer = setTimeout(done, wait * 1000);
        const unsubscribe = subscribe((event) => {
          if (event.type !== "comment-created") return;
          if (sessionId && event.sessionId !== sessionId) return;
          if (snippetId && event.snippetId !== snippetId) return;
          done();
        });
        function done() {
          clearTimeout(timer);
          unsubscribe();
          resolve();
        }
      });
      comments = matches(await store.listComments(query));
    }
    const lastSeq = comments.length > 0 ? comments[comments.length - 1].seq : (afterSeq ?? 0);
    return c.json({ comments, lastSeq });
  });

  // --- rendering ---

  app.get("/s/:id", async (c) => {
    const snippet = await store.getSnippet(c.req.param("id"));
    if (!snippet) return c.text("Snippet not found", 404);
    const ver = c.req.query("ver");
    let doc = snippet;
    if (ver && Number(ver) !== snippet.version) {
      const old = snippet.history.find((h) => h.version === Number(ver));
      if (!old) return c.text(`Version ${ver} not available`, 404);
      doc = { ...snippet, title: old.title, html: old.html };
    }
    c.header("X-Content-Type-Options", "nosniff");
    return c.html(renderSnippetPage(doc));
  });

  // --- live feed ---

  app.get("/api/events", (c) =>
    streamSSE(c, async (stream) => {
      const queue: FeedEvent[] = [];
      let wake: (() => void) | null = null;
      const unsubscribe = subscribe((event) => {
        queue.push(event);
        wake?.();
      });
      let open = true;
      stream.onAbort(() => {
        open = false;
        unsubscribe();
        wake?.();
      });
      await stream.writeSSE({ event: "hello", data: "{}" });
      while (open) {
        while (queue.length > 0) {
          await stream.writeSSE({ data: JSON.stringify(queue.shift()) });
        }
        await Promise.race([
          new Promise<void>((resolve) => {
            wake = resolve;
          }),
          stream.sleep(15000),
        ]);
        wake = null;
        if (open && queue.length === 0) {
          await stream.writeSSE({ event: "ping", data: "{}" });
        }
      }
    }),
  );

  return app;
}

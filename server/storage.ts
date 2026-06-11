import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

export interface Session {
  id: string;
  agent: string;
  title: string | null;
  cwd: string | null;
  createdAt: string;
  lastActiveAt: string;
}

export interface SnippetVersion {
  version: number;
  title: string;
  html: string;
  at: string;
}

export interface Snippet {
  id: string;
  sessionId: string;
  title: string;
  html: string;
  createdAt: string;
  updatedAt: string;
  version: number;
  history: SnippetVersion[];
}

export interface Comment {
  id: string;
  seq: number;
  sessionId: string;
  snippetId: string | null;
  snippetTitle: string | null;
  author: string;
  text: string;
  createdAt: string;
}

export interface CreateSessionInput {
  agent: string;
  title?: string;
  cwd?: string;
}

export interface CreateSnippetInput {
  sessionId: string;
  title?: string;
  html: string;
}

export interface UpdateSnippetInput {
  title?: string;
  html?: string;
}

export interface CreateCommentInput {
  sessionId: string;
  snippetId?: string;
  author: string;
  text: string;
}

export interface CommentQuery {
  sessionId?: string;
  snippetId?: string;
  afterSeq?: number;
}

// Storage interface — implementations: JsonFileStore (local), D1/KV (cloud, later).
export interface Store {
  listSessions(): Promise<Session[]>;
  getSession(id: string): Promise<Session | null>;
  createSession(input: CreateSessionInput): Promise<Session>;
  renameSession(id: string, title: string): Promise<Session | null>;
  removeSession(id: string): Promise<boolean>;

  listSnippets(sessionId?: string): Promise<Snippet[]>;
  getSnippet(id: string): Promise<Snippet | null>;
  createSnippet(input: CreateSnippetInput): Promise<Snippet | null>;
  updateSnippet(id: string, patch: UpdateSnippetInput): Promise<Snippet | null>;
  removeSnippet(id: string): Promise<boolean>;

  listComments(query: CommentQuery): Promise<Comment[]>;
  createComment(input: CreateCommentInput): Promise<Comment | null>;
}

const HISTORY_LIMIT = 20;

interface FileShape {
  sessions: Session[];
  snippets: Snippet[];
  comments: Comment[];
  lastSeq: number;
}

const newId = () => randomUUID().split("-")[0];

export class JsonFileStore implements Store {
  private sessions = new Map<string, Session>();
  private snippets = new Map<string, Snippet>();
  private comments: Comment[] = [];
  private lastSeq = 0;
  private loaded = false;
  private writeQueue: Promise<void> = Promise.resolve();
  private filePath: string;

  constructor(filePath: string) {
    this.filePath = filePath;
  }

  private async load() {
    if (this.loaded) return;
    this.loaded = true;
    try {
      const raw = await readFile(this.filePath, "utf8");
      const data = JSON.parse(raw) as FileShape;
      for (const s of data.sessions ?? []) this.sessions.set(s.id, s);
      for (const s of data.snippets ?? []) this.snippets.set(s.id, s);
      this.comments = data.comments ?? [];
      this.lastSeq = data.lastSeq ?? 0;
    } catch (err: any) {
      if (err?.code !== "ENOENT") throw err;
    }
  }

  private persist() {
    const data = JSON.stringify(
      {
        sessions: [...this.sessions.values()],
        snippets: [...this.snippets.values()],
        comments: this.comments,
        lastSeq: this.lastSeq,
      } satisfies FileShape,
      null,
      2,
    );
    this.writeQueue = this.writeQueue.then(async () => {
      await mkdir(dirname(this.filePath), { recursive: true });
      const tmp = `${this.filePath}.tmp`;
      await writeFile(tmp, data, "utf8");
      await rename(tmp, this.filePath);
    });
    return this.writeQueue;
  }

  // --- sessions ---

  async listSessions() {
    await this.load();
    return [...this.sessions.values()].sort((a, b) => b.lastActiveAt.localeCompare(a.lastActiveAt));
  }

  async getSession(id: string) {
    await this.load();
    return this.sessions.get(id) ?? null;
  }

  async createSession(input: CreateSessionInput) {
    await this.load();
    const now = new Date().toISOString();
    const session: Session = {
      id: newId(),
      agent: input.agent.trim() || "agent",
      title: input.title?.trim() || null,
      cwd: input.cwd ?? null,
      createdAt: now,
      lastActiveAt: now,
    };
    this.sessions.set(session.id, session);
    await this.persist();
    return session;
  }

  async renameSession(id: string, title: string) {
    await this.load();
    const session = this.sessions.get(id);
    if (!session) return null;
    session.title = title.trim() || null;
    await this.persist();
    return session;
  }

  async removeSession(id: string) {
    await this.load();
    if (!this.sessions.delete(id)) return false;
    for (const [sid, snippet] of this.snippets) {
      if (snippet.sessionId === id) this.snippets.delete(sid);
    }
    this.comments = this.comments.filter((c) => c.sessionId !== id);
    await this.persist();
    return true;
  }

  private touch(sessionId: string) {
    const session = this.sessions.get(sessionId);
    if (session) session.lastActiveAt = new Date().toISOString();
  }

  // --- snippets ---

  async listSnippets(sessionId?: string) {
    await this.load();
    const all = [...this.snippets.values()].filter(
      (s) => sessionId === undefined || s.sessionId === sessionId,
    );
    return all.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  }

  async getSnippet(id: string) {
    await this.load();
    return this.snippets.get(id) ?? null;
  }

  async createSnippet(input: CreateSnippetInput) {
    await this.load();
    if (!this.sessions.has(input.sessionId)) return null;
    const now = new Date().toISOString();
    const snippet: Snippet = {
      id: newId(),
      sessionId: input.sessionId,
      title: input.title?.trim() || "Untitled",
      html: input.html,
      createdAt: now,
      updatedAt: now,
      version: 1,
      history: [],
    };
    this.snippets.set(snippet.id, snippet);
    this.touch(input.sessionId);
    await this.persist();
    return snippet;
  }

  async updateSnippet(id: string, patch: UpdateSnippetInput) {
    await this.load();
    const snippet = this.snippets.get(id);
    if (!snippet) return null;
    snippet.history.push({
      version: snippet.version,
      title: snippet.title,
      html: snippet.html,
      at: snippet.updatedAt,
    });
    if (snippet.history.length > HISTORY_LIMIT) snippet.history.shift();
    if (patch.title !== undefined) snippet.title = patch.title.trim() || snippet.title;
    if (patch.html !== undefined) snippet.html = patch.html;
    snippet.version += 1;
    snippet.updatedAt = new Date().toISOString();
    this.touch(snippet.sessionId);
    await this.persist();
    return snippet;
  }

  async removeSnippet(id: string) {
    await this.load();
    const snippet = this.snippets.get(id);
    if (!snippet) return false;
    this.snippets.delete(id);
    this.comments = this.comments.filter((c) => c.snippetId !== id);
    await this.persist();
    return true;
  }

  // --- comments ---

  async listComments(query: CommentQuery) {
    await this.load();
    return this.comments.filter(
      (c) =>
        (query.sessionId === undefined || c.sessionId === query.sessionId) &&
        (query.snippetId === undefined || c.snippetId === query.snippetId) &&
        (query.afterSeq === undefined || c.seq > query.afterSeq),
    );
  }

  async createComment(input: CreateCommentInput) {
    await this.load();
    if (!this.sessions.has(input.sessionId)) return null;
    const snippet = input.snippetId ? this.snippets.get(input.snippetId) : null;
    const comment: Comment = {
      id: newId(),
      seq: ++this.lastSeq,
      sessionId: input.sessionId,
      snippetId: snippet?.id ?? null,
      snippetTitle: snippet?.title ?? null,
      author: input.author.trim() || "user",
      text: input.text,
      createdAt: new Date().toISOString(),
    };
    this.comments.push(comment);
    this.touch(input.sessionId);
    await this.persist();
    return comment;
  }
}

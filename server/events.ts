export type FeedEvent =
  | { type: "session-created" | "session-updated" | "session-deleted"; id: string }
  | { type: "snippet-created" | "snippet-updated"; id: string; sessionId: string; version: number }
  | { type: "snippet-deleted"; id: string; sessionId: string }
  | {
      type: "comment-created";
      id: string;
      sessionId: string;
      snippetId: string | null;
      seq: number;
    };

type Listener = (event: FeedEvent) => void;

// One bus per app instance. On Cloudflare, each board is a single Durable
// Object running one app, so in-memory listeners are correct there too —
// a module-level singleton would leak events across boards sharing an isolate.
export class EventBus {
  private listeners = new Set<Listener>();

  broadcast(event: FeedEvent) {
    for (const fn of this.listeners) fn(event);
  }

  subscribe(fn: Listener) {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }
}

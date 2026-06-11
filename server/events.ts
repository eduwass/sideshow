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

const listeners = new Set<Listener>();

export function broadcast(event: FeedEvent) {
  for (const fn of listeners) fn(event);
}

export function subscribe(fn: Listener) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

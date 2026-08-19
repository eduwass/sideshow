import type { Post, Session } from "./types.ts";

export interface PostProvenance {
  sessionId: string;
  messageOrdinal: number;
  timestamp: string;
  agent: string;
  model: string | null;
  prompt: string | null;
  url: string;
}

interface SearchMatch {
  session_id: string;
  agent: string;
  ordinal: number;
  timestamp: string;
  role: string;
  tool_name?: string;
}

interface AgentMessage {
  ordinal: number;
  role: string;
  content: string;
  model?: string;
  is_system?: boolean;
}

export async function resolvePostProvenance(
  post: Post,
  session: Session,
  request: typeof fetch = fetch,
): Promise<PostProvenance | null> {
  if (!post.title.trim()) return null;
  try {
    const query = new URLSearchParams({
      pattern: post.title,
      mode: "substring",
      limit: "25",
      context: "0",
    });
    const apiOrigin = process.env.AGENTSVIEW_URL ?? "http://127.0.0.1:18080";
    const search = await request(`${apiOrigin}/api/v1/search/content?${query}`);
    if (!search.ok) return null;
    const matches = ((await search.json()) as { matches?: SearchMatch[] }).matches ?? [];
    const createdAt = Date.parse(post.createdAt);
    const candidates = matches.filter(
      (match) =>
        match.role === "assistant" &&
        Number.isInteger(match.ordinal) &&
        Number.isFinite(Date.parse(match.timestamp)),
    );
    candidates.sort((a, b) => {
      const preferred = (match: SearchMatch) =>
        /sideshow|publish/i.test(match.tool_name ?? "") ? 0 : 1;
      return (
        preferred(a) - preferred(b) ||
        Math.abs(Date.parse(a.timestamp) - createdAt) -
          Math.abs(Date.parse(b.timestamp) - createdAt)
      );
    });
    const match = candidates[0];
    if (!match || Math.abs(Date.parse(match.timestamp) - createdAt) > 5 * 60_000) return null;

    const messagesResponse = await request(
      `${apiOrigin}/api/v1/sessions/${encodeURIComponent(match.session_id)}/messages?around=${match.ordinal}&before=50&after=0`,
    );
    if (!messagesResponse.ok) return null;
    const messages =
      ((await messagesResponse.json()) as { messages?: AgentMessage[] }).messages ?? [];
    const source = messages.find((message) => message.ordinal === match.ordinal);
    const prompt = [...messages]
      .reverse()
      .find(
        (message) =>
          message.ordinal < match.ordinal && message.role === "user" && !message.is_system,
      )?.content;
    const publicOrigin = process.env.AGENTSVIEW_PUBLIC_URL ?? "https://agentsview.eduwass.dev";

    return {
      sessionId: match.session_id,
      messageOrdinal: match.ordinal,
      timestamp: match.timestamp,
      agent: match.agent || session.agent,
      model: source?.model ?? null,
      prompt: prompt?.trim().slice(0, 500) || null,
      url: `${publicOrigin}/sessions/${encodeURIComponent(match.session_id)}?msg=${match.ordinal}`,
    };
  } catch {
    return null;
  }
}

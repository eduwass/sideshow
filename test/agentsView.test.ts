import assert from "node:assert/strict";
import test from "node:test";
import { resolvePostProvenance } from "../server/agentsView.ts";
import type { Post, Session } from "../server/types.ts";

test("resolves a post to the exact AgentsView message and preceding prompt", async () => {
  const post = {
    id: "post-1",
    sessionId: "ss-1",
    title: "Mobile navigation directions",
    createdAt: "2026-08-19T13:29:00.000Z",
  } as Post;
  const session = { agent: "OpenCode" } as Session;
  const request = async (input: string | URL | Request) => {
    const url = String(input);
    if (url.includes("/search/content")) {
      return Response.json({
        matches: [
          {
            session_id: "opencode:session-7",
            agent: "opencode",
            ordinal: 42,
            timestamp: "2026-08-19T13:29:01.000Z",
            role: "assistant",
            tool_name: "sideshow_publish_post",
          },
        ],
      });
    }
    return Response.json({
      messages: [
        { ordinal: 41, role: "user", content: "Mock up the mobile navigation" },
        {
          ordinal: 42,
          role: "assistant",
          content: "",
          model: "gpt-5.6-sol",
        },
      ],
    });
  };

  assert.deepEqual(await resolvePostProvenance(post, session, request as typeof fetch), {
    sessionId: "opencode:session-7",
    messageOrdinal: 42,
    timestamp: "2026-08-19T13:29:01.000Z",
    agent: "opencode",
    model: "gpt-5.6-sol",
    prompt: "Mock up the mobile navigation",
    url: "https://agentsview.eduwass.dev/sessions/opencode%3Asession-7?msg=42",
  });
});

test("returns null rather than guessing when the nearest match is too far away", async () => {
  const post = {
    title: "Repeated title",
    createdAt: "2026-08-19T13:29:00.000Z",
  } as Post;
  const request = async () =>
    Response.json({
      matches: [
        {
          session_id: "opencode:old",
          agent: "opencode",
          ordinal: 1,
          timestamp: "2026-08-19T12:00:00.000Z",
          role: "assistant",
          tool_name: "sideshow_publish_post",
        },
      ],
    });

  assert.equal(
    await resolvePostProvenance(post, { agent: "OpenCode" } as Session, request as typeof fetch),
    null,
  );
});

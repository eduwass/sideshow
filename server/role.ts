// Which of the two deployments this process is. One codebase runs either the
// private control plane (the working workspace, agents, MCP, owner controls) or
// the public publication service (docs/adr/0001) — never both.
//
// The default is deliberately asymmetric: anything other than the exact string
// "public" resolves to "private". A typo, an empty variable or a missing
// variable can therefore only ever produce the *closed* runtime; opening the
// public surface has to be spelled out.

export type RuntimeRole = "private" | "public";

export const DEFAULT_RUNTIME_ROLE: RuntimeRole = "private";

export function resolveRole(value: string | null | undefined): RuntimeRole {
  return typeof value === "string" && value.trim().toLowerCase() === "public"
    ? "public"
    : DEFAULT_RUNTIME_ROLE;
}

export const isPublicRole = (value: string | null | undefined): boolean =>
  resolveRole(value) === "public";

// --- private-service defence in depth ---

const LOOPBACK_HOSTS = new Set(["127.0.0.1", "::1", "localhost", "[::1]"]);

export function isLoopbackHost(hostname: string | undefined | null): boolean {
  return typeof hostname === "string" && LOOPBACK_HOSTS.has(hostname.trim().toLowerCase());
}

export interface BindingCheck {
  ok: boolean;
  /** Set when the binding is questionable, whether or not it is fatal. */
  message?: string;
}

/**
 * The private control plane holds the working workspace and the comment→agent
 * channel, so it should listen on loopback and require a token. Both already
 * exist as options (`SIDESHOW_HOST`, `SIDESHOW_TOKEN`); this keeps them honest
 * without changing the local default:
 *
 *   - reachable beyond loopback with no token → always warns;
 *   - with `requireLoopback` (what a deployed service sets) → refuses to start.
 */
export function privateBindingCheck(input: {
  hostname: string | undefined;
  token: string | undefined;
  requireLoopback: boolean;
}): BindingCheck {
  const loopback = isLoopbackHost(input.hostname);
  const exposed = !loopback;
  const tokenless = !input.token;
  if (input.requireLoopback && (exposed || tokenless)) {
    return {
      ok: false,
      message:
        "SIDESHOW_REQUIRE_LOOPBACK is set, so this private service must bind a loopback address (SIDESHOW_HOST=127.0.0.1) and set SIDESHOW_TOKEN.",
    };
  }
  if (exposed && tokenless) {
    return {
      ok: true,
      message:
        "this private workspace is reachable beyond loopback with no SIDESHOW_TOKEN — set SIDESHOW_HOST=127.0.0.1, a token, or both.",
    };
  }
  return { ok: true };
}

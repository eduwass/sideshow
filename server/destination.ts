// The private control plane's link to the one public publication service.
//
// Publications live only in the public workspace (docs/adr/0001), so every
// owner action against them is a server-to-server call the private service
// makes on the user's behalf. The bearer token lives in this module and in the
// private server's environment — it is never injected into the viewer, never
// returned by an API the browser can call, and never logged.

export interface DestinationConfig {
  /** Origin of the public service, e.g. https://show.example.com — no trailing slash. */
  origin: string;
  token: string;
}

/**
 * Build a destination from environment values. Returns null unless BOTH the URL
 * and the token are present: a half-configured destination would otherwise send
 * unauthenticated writes at a public origin.
 */
export function resolveDestination(
  url: string | undefined,
  token: string | undefined,
): DestinationConfig | null {
  if (!url || !token) return null;
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  if (parsed.protocol !== "https:" && parsed.hostname !== "localhost") return null;
  return { origin: parsed.origin, token };
}

export class DestinationError extends Error {
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.name = "DestinationError";
    this.status = status;
  }
}

// A thin authenticated client. `fetchImpl` is a test seam; production passes the
// runtime's global fetch, which exists on Node ≥18 and on Workers.
export class DestinationClient {
  private readonly config: DestinationConfig;
  private readonly fetchImpl: typeof fetch;

  constructor(config: DestinationConfig, fetchImpl: typeof fetch = fetch) {
    this.config = config;
    this.fetchImpl = fetchImpl;
  }

  get origin(): string {
    return this.config.origin;
  }

  async request<T>(path: string, init: RequestInit = {}): Promise<T> {
    const headers = new Headers(init.headers);
    headers.set("authorization", `Bearer ${this.config.token}`);
    if (init.body !== undefined && !headers.has("content-type")) {
      headers.set("content-type", "application/json");
    }
    const res = await this.fetchImpl(`${this.config.origin}${path}`, { ...init, headers });
    if (!res.ok) {
      const body = (await res.json().catch(() => ({}))) as { error?: string };
      // Never echo the token or the raw upstream body back to a caller. The
      // upstream message is ours and is passed through — unless it contains the
      // credential, which a proxy or WAF echoing our request headers can do.
      const message =
        body.error && !body.error.includes(this.config.token)
          ? body.error
          : `destination returned ${res.status}`;
      throw new DestinationError(res.status, message);
    }
    if (res.status === 204) return undefined as T;
    return (await res.json()) as T;
  }

  /** Same call, for the routes that answer with a document rather than JSON. */
  async requestText(path: string): Promise<string> {
    const res = await this.fetchImpl(`${this.config.origin}${path}`, {
      headers: { authorization: `Bearer ${this.config.token}` },
    });
    if (!res.ok) throw new DestinationError(res.status, `destination returned ${res.status}`);
    return res.text();
  }
}

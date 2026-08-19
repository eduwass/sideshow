import { DurableObject } from "cloudflare:workers";
import { createPublicApp } from "../server/publicApp.ts";
import { SqlStore } from "../server/sqlStore.ts";

// Cloudflare entry for the PUBLIC publication service (docs/adr/0001).
//
// A separate Worker, a separate Durable Object and a separate database from the
// private control plane: nothing here can reach a private workspace, because
// the private workspace is not in this deployment at all. The app it serves is
// `createPublicApp`, which mounts only the publication routes.

interface Env {
  PUBLICATIONS: DurableObjectNamespace<SideshowPublications>;
  SIDESHOW_OWNER_TOKEN?: string;
  SIDESHOW_VISITOR_SECRET?: string;
}

export class SideshowPublications extends DurableObject<Env> {
  private app: ReturnType<typeof createPublicApp>;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.app = createPublicApp({
      store: new SqlStore(ctx.storage.sql),
      ownerToken: env.SIDESHOW_OWNER_TOKEN ?? "",
      visitorSecret: env.SIDESHOW_VISITOR_SECRET ?? "",
    });
  }

  override fetch(request: Request) {
    return this.app.fetch(request);
  }
}

export default {
  async fetch(request: Request, env: Env) {
    // Fail closed rather than serving publications with no owner credential or
    // an unkeyed visitor hash.
    if (!env.SIDESHOW_OWNER_TOKEN || !env.SIDESHOW_VISITOR_SECRET) {
      return new Response(
        "sideshow public service is not configured: set its secrets first —\n\n" +
          "  wrangler secret put SIDESHOW_OWNER_TOKEN --config wrangler.public.jsonc\n" +
          "  wrangler secret put SIDESHOW_VISITOR_SECRET --config wrangler.public.jsonc\n",
        { status: 503 },
      );
    }
    return env.PUBLICATIONS.get(env.PUBLICATIONS.idFromName("default")).fetch(request);
  },
} satisfies ExportedHandler<Env>;

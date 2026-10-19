// The HTTP app: REST API, SSE, health check, and the built client in production. Built separately
// from index.ts so tests can drive it with `app.inject`.

import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import fastifyStatic from "@fastify/static";
import Fastify, { type FastifyServerOptions } from "fastify";
import { registerRoutes } from "./api/routes.ts";
import { registerSse } from "./api/sse.ts";
import type { Catalog } from "./cook/catalog.ts";
import { CommandError, type CookEngine } from "./cook/engine.ts";
import type { Store } from "./db/store.ts";
import type { Clock } from "./device/clock.ts";

export interface AppDeps {
  engine: CookEngine;
  store: Store;
  catalog: Catalog;
  clock: Clock;
  logger?: FastifyServerOptions["logger"];
  /** Serve client/dist when it exists (production). */
  serveClient?: boolean;
}

export async function buildApp(deps: AppDeps) {
  const app = Fastify({ logger: deps.logger ?? false });

  app.setErrorHandler((err, _req, reply) => {
    if (err instanceof CommandError) return reply.code(err.status).send({ error: err.message });
    const status = (err as { statusCode?: number }).statusCode ?? 500;
    if (status >= 500) app.log.error(err);
    return reply.code(status).send({ error: (err as Error).message });
  });

  app.get("/healthz", async () => ({ ok: true }));
  registerRoutes(app, deps);
  registerSse(app, deps.engine);

  // In production the client is built into client/dist and served from here.
  const clientDist = path.resolve(fileURLToPath(import.meta.url), "../../../client/dist");
  if (deps.serveClient !== false && existsSync(clientDist)) {
    await app.register(fastifyStatic, { root: clientDist });
  }
  return app;
}

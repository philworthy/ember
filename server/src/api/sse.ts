// The live-state stream: `state` (the whole LiveState) on connect and after every change, and
// `event` for each domain event. A comment line every 15 s keeps proxies (tailscale serve) from
// closing an idle stream. The engine only builds the state while someone is listening.

import type { ServerResponse } from "node:http";
import type { CookEvent, LiveState } from "@ember/shared";
import type { FastifyInstance } from "fastify";
import type { CookEngine } from "../cook/engine.ts";

function frame(res: ServerResponse, event: string, data: unknown): void {
  res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
}

export function registerSse(
  app: FastifyInstance,
  engine: CookEngine,
  opts: { heartbeatMs?: number } = {},
): void {
  const clients = new Set<ServerResponse>();
  const onState = (s: LiveState) => {
    for (const res of clients) frame(res, "state", s);
  };
  const onEvent = (e: CookEvent) => {
    for (const res of clients) frame(res, "event", e);
  };
  const detach = () => {
    engine.off("state", onState);
    engine.off("event", onEvent);
  };

  const heartbeat = setInterval(() => {
    for (const res of clients) res.write(": ping\n\n");
  }, opts.heartbeatMs ?? 15_000);
  heartbeat.unref();

  app.get("/api/live", (req, reply) => {
    reply.hijack();
    const res = reply.raw;
    res.writeHead(200, {
      "content-type": "text/event-stream",
      "cache-control": "no-cache, no-transform",
      connection: "keep-alive",
      "x-accel-buffering": "no",
    });
    frame(res, "state", engine.live());
    if (clients.size === 0) {
      engine.on("state", onState);
      engine.on("event", onEvent);
    }
    clients.add(res);
    req.raw.on("close", () => {
      clients.delete(res);
      if (clients.size === 0) detach();
    });
  });

  app.addHook("onClose", async () => {
    clearInterval(heartbeat);
    detach();
    for (const res of clients) res.end();
    clients.clear();
  });
}

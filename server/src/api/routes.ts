// REST API (docs/brief.md › Architecture). Everything is °C. Commands answer 202 at once with an
// id; the device's read-back arrives on the SSE stream as a `commandResult` event, so a command
// never waits on an offline device.

import type { CookEdit, Food, ProbeSlot } from "@ember/shared";
import type { FastifyInstance } from "fastify";
import type { Catalog } from "../cook/catalog.ts";
import type { CookEngine } from "../cook/engine.ts";
import { History } from "../cook/history.ts";
import type { Store } from "../db/store.ts";
import type { Clock } from "../device/clock.ts";

const HOUR = 3_600_000;
/** Longest window /api/readings returns at once (a long cook plus margin). */
const MAX_READINGS_SPAN = 48 * HOUR;

const num = { type: "number" } as const;
const nullableNum = { type: ["number", "null"] } as const;
const slotParams = {
  type: "object",
  required: ["slot"],
  properties: { slot: { type: "integer", minimum: 1, maximum: 3 } },
} as const;
const foodSchema = {
  oneOf: [
    { type: "null" },
    {
      type: "object",
      required: ["path"],
      additionalProperties: false,
      properties: { path: { type: "array", minItems: 1, maxItems: 3, items: { type: "string" } } },
    },
    {
      type: "object",
      required: ["custom"],
      additionalProperties: false,
      properties: { custom: { type: "string", minLength: 1, maxLength: 60 } },
    },
  ],
} as const;

const idParams = {
  type: "object",
  required: ["id"],
  properties: { id: { type: "integer" } },
} as const;

const body = (required: string[], properties: Record<string, unknown>) => ({
  body: { type: "object", required, additionalProperties: false, properties },
});

export function registerRoutes(
  app: FastifyInstance,
  deps: { engine: CookEngine; store: Store; catalog: Catalog; clock: Clock },
): void {
  const { engine, store, catalog, clock } = deps;
  const history = new History(store, clock);

  app.get("/api/state", async () => engine.live());

  // ---- Commands ----

  app.post<{ Body: { pitC: number } }>(
    "/api/cook/start",
    { schema: body(["pitC"], { pitC: num }) },
    async (req, reply) => reply.code(202).send(engine.start(req.body.pitC)),
  );
  app.post<{ Body: { pitC: number } }>(
    "/api/cook/target",
    { schema: body(["pitC"], { pitC: num }) },
    async (req, reply) => reply.code(202).send(engine.retarget(req.body.pitC)),
  );
  app.post("/api/cook/stop", async (_req, reply) => reply.code(202).send(engine.stop()));
  app.post("/api/cook/end", async (_req, reply) => reply.code(202).send(engine.end()));
  app.post<{ Body: { minutes: number; thenHoldC: number | null } }>(
    "/api/fire-up",
    { schema: body(["minutes", "thenHoldC"], { minutes: num, thenHoldC: nullableNum }) },
    async (req, reply) => reply.code(202).send(engine.fireUp(req.body.minutes, req.body.thenHoldC)),
  );
  app.post("/api/session/keep-going", async (_req, reply) =>
    reply.code(202).send(engine.keepGoing()),
  );

  app.put<{
    Params: { slot: ProbeSlot };
    Body: { food: Food | null; weightLb?: number | null; targetC?: number };
  }>(
    "/api/probes/:slot",
    {
      schema: {
        params: slotParams,
        ...body(["food"], { food: foodSchema, weightLb: nullableNum, targetC: num }),
      },
    },
    async (req, reply) => reply.code(202).send(engine.assignProbe(req.params.slot, req.body)),
  );
  app.post<{ Params: { slot: ProbeSlot }; Body: { targetC: number } }>(
    "/api/probes/:slot/target",
    { schema: { params: slotParams, ...body(["targetC"], { targetC: num }) } },
    async (req, reply) =>
      reply.code(202).send(engine.setProbeTarget(req.params.slot, req.body.targetC)),
  );
  app.delete<{ Params: { slot: ProbeSlot } }>(
    "/api/probes/:slot",
    { schema: { params: slotParams } },
    async (req, reply) => reply.code(202).send(engine.clearProbe(req.params.slot)),
  );

  // ---- Reads ----

  app.get("/api/catalog", async () => catalog.tree);
  app.get("/api/foods/recent", async () => store.recentFoods());

  app.get<{ Querystring: { limit?: number; before?: number } }>(
    "/api/sessions",
    {
      schema: {
        querystring: {
          type: "object",
          properties: {
            limit: { type: "integer", minimum: 1, maximum: 200 },
            before: { type: "integer" },
          },
        },
      },
    },
    async (req) => history.list(req.query.limit ?? 50, req.query.before),
  );

  app.get<{ Params: { id: number } }>(
    "/api/sessions/:id",
    { schema: { params: idParams } },
    async (req, reply) => {
      const detail = history.detail(req.params.id);
      return detail ?? reply.code(404).send({ error: "No such cook" });
    },
  );

  // ---- History edits ----

  app.patch<{ Params: { id: number }; Body: CookEdit }>(
    "/api/sessions/:id",
    {
      schema: {
        params: idParams,
        ...body([], {
          startedAt: { type: "integer" },
          endedAt: { type: "integer" },
          notes: { type: "string", maxLength: 4000 },
          title: { type: ["string", "null"], maxLength: 80 },
        }),
      },
    },
    async (req) => history.edit(req.params.id, req.body),
  );

  app.post<{ Params: { id: number } }>(
    "/api/sessions/:id/cook-again",
    { schema: { params: idParams } },
    async (req, reply) => reply.code(202).send(engine.prepare(history.cookAgain(req.params.id))),
  );

  app.get<{ Querystring: { from?: number; to?: number } }>(
    "/api/readings",
    {
      schema: {
        querystring: {
          type: "object",
          properties: { from: { type: "integer" }, to: { type: "integer" } },
        },
      },
    },
    async (req, reply) => {
      const to = req.query.to ?? clock.now();
      const from = req.query.from ?? to - 6 * HOUR;
      if (from > to || to - from > MAX_READINGS_SPAN) {
        return reply.code(400).send({ error: "from..to must be ordered and at most 48 h" });
      }
      return store.readings(from, to);
    },
  );
}

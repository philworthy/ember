import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import fastifyStatic from "@fastify/static";
import Fastify from "fastify";

// EMBER_PORT, not PORT: dev tooling (e.g. preview harnesses) exports PORT for the front-end.
const port = Number(process.env.EMBER_PORT ?? 8080);
const app = Fastify({ logger: true });

app.get("/healthz", async () => ({ ok: true }));

// In production the client is built into client/dist and served from here.
const clientDist = path.resolve(fileURLToPath(import.meta.url), "../../../client/dist");
if (existsSync(clientDist)) {
  await app.register(fastifyStatic, { root: clientDist });
}

await app.listen({ port, host: "0.0.0.0" });

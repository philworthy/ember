// The simulator's network face. Firmware 1.0.56's HTTP framing is malformed (two status lines,
// no headers, bare LF, trailing space, close), so node:http can't produce it: a raw TCP server
// does, and SimTransport hands the same bytes to the device client in-process.

import { type AddressInfo, createServer, type Socket } from "node:net";
import { parseQs } from "../device/protocol.ts";
import { type Transport, TransportError } from "../device/transport.ts";
import type { SimDevice, SimOutcome } from "./device.ts";

export interface RecordedRequest {
  method: string;
  path: string;
  /** Lower-cased header names. */
  headers: Record<string, string>;
  body: string;
  fields: Record<string, string>;
}

/** Exactly what firmware 1.0.56 sends: two status lines, no headers, bare LF, trailing space. */
export function deviceResponse(body: string): string {
  return `HTTP/1.0 200 OK\r\nHTTP/1.1 200 OK\r\n\n${body} `;
}

function toBytes(outcome: Extract<SimOutcome, { kind: "response" }>): string {
  return outcome.status === 200
    ? deviceResponse(outcome.body)
    : `HTTP/1.0 ${outcome.status} Not Found\r\n\r\n`;
}

/** Parse a raw request; null until it is complete (headers plus Content-Length of body). */
export function parseRequest(raw: string): RecordedRequest | null {
  const end = raw.indexOf("\r\n\r\n");
  if (end < 0) return null;
  const [requestLine = "", ...headerLines] = raw.slice(0, end).split("\r\n");
  const headers: Record<string, string> = {};
  for (const line of headerLines) {
    const colon = line.indexOf(":");
    if (colon > 0) headers[line.slice(0, colon).toLowerCase()] = line.slice(colon + 1).trim();
  }
  const body = raw.slice(end + 4);
  if (body.length < Number(headers["content-length"] ?? 0)) return null;
  const [method = "", url = ""] = requestLine.split(" ");
  return { method, path: url.replace("/cgi-bin/", ""), headers, body, fields: parseQs(body) };
}

const ERRORS: Record<Exclude<SimOutcome["kind"], "response">, [string, string]> = {
  reset: ["ECONNRESET", "read ECONNRESET"],
  timeout: ["ETIMEDOUT", "timed out"],
  refused: ["ECONNREFUSED", "connect ECONNREFUSED"],
  unreachable: ["EHOSTUNREACH", "connect EHOSTUNREACH"],
};

/**
 * In-process transport: the client's real request bytes in, the device's real response bytes
 * out, socket failures as the same error codes. Resolves on a later macrotask so overlapping
 * requests really overlap and the simulator can catch a client that doesn't serialize.
 */
export class SimTransport implements Transport {
  readonly baseUrl = "http://sim/cgi-bin/";
  readonly hostHeader = "sim";

  constructor(private readonly sim: SimDevice) {}

  async exchange(request: string, _timeoutMs: number): Promise<string> {
    const req = parseRequest(request);
    if (!req) throw new Error("incomplete request");
    const flight = this.sim.begin();
    try {
      await new Promise((resolve) => setImmediate(resolve));
      const outcome = this.sim.handleOverlapping(req, flight.overlapped);
      if (outcome.kind === "response") return toBytes(outcome);
      const [code, message] = ERRORS[outcome.kind];
      throw new TransportError(code, message);
    } finally {
      flight.end();
    }
  }
}

export interface SimServer {
  /** `127.0.0.1:<port>`, ready for `IKAMAND_HOST` or `new DeviceClient(host)`. */
  host: string;
  port: number;
  requests: RecordedRequest[];
  close: () => Promise<void>;
}

/** Serve the simulator over real TCP, e.g. for the CLI or `npm run sim`. */
export async function startSimServer(
  sim: SimDevice,
  opts: { port?: number; host?: string } = {},
): Promise<SimServer> {
  const requests: RecordedRequest[] = [];
  const sockets = new Set<Socket>();
  const server = createServer((socket: Socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
    socket.on("error", () => {});
    let raw = "";
    let flight: ReturnType<SimDevice["begin"]> | null = null;
    socket.on("data", (chunk) => {
      flight ??= sim.begin();
      raw += chunk.toString("latin1");
      const req = parseRequest(raw);
      if (!req) return;
      requests.push(req);
      const outcome = sim.handleOverlapping(req, flight.overlapped);
      flight.end();
      if (outcome.kind === "response") socket.end(toBytes(outcome));
      else if (outcome.kind === "timeout")
        return; // hold the connection open, say nothing
      else socket.resetAndDestroy();
    });
  });
  await new Promise<void>((resolve) =>
    server.listen(opts.port ?? 0, opts.host ?? "127.0.0.1", resolve),
  );
  const { port } = server.address() as AddressInfo;
  return {
    host: `127.0.0.1:${port}`,
    port,
    requests,
    close: () =>
      new Promise((resolve) => {
        for (const s of sockets) s.destroy();
        server.close(() => resolve());
      }),
  };
}

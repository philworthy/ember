// Minimal fake iKamand for CLI tests: records requests and applies cook payloads to its state.
// Not the simulator (milestone 2); it only speaks the wire format, including firmware 1.0.56's
// malformed HTTP framing, so a raw TCP server stands in for node:http.

import { type AddressInfo, createServer, type Socket } from "node:net";
import { parseQs } from "../lib/protocol.ts";

export interface RecordedRequest {
  method: string;
  path: string;
  /** Lower-cased header names. */
  headers: Record<string, string>;
  body: string;
  fields: Record<string, string>;
}

export interface StubOptions {
  /** Ignore `ag=0`, to exercise the CLI's fallback stop. */
  ignoreGrillStop?: boolean;
  /** Reset every POST without applying it, as the real device sometimes does. */
  resetPosts?: boolean;
}

export interface Stub {
  host: string;
  requests: RecordedRequest[];
  posts: () => RecordedRequest[];
  state: Record<string, string>;
  close: () => Promise<void>;
}

/** Exactly what firmware 1.0.56 sends: two status lines, no headers, bare LF, trailing space. */
export function deviceResponse(body: string): string {
  return `HTTP/1.0 200 OK\r\nHTTP/1.1 200 OK\r\n\n${body} `;
}

function parseRequest(raw: string): RecordedRequest | null {
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

export async function startStub(opts: StubOptions = {}): Promise<Stub> {
  const requests: RecordedRequest[] = [];
  // Field order as seen from the real device when idle. It reports no sce, p or tft.
  const state: Record<string, string> = {
    time: "0",
    rm: "0",
    acs: "0",
    csid: "",
    cm: "0",
    ag: "0",
    as: "0",
    pt: "22",
    t1: "400",
    t2: "-400",
    t3: "400",
    dc: "0",
    tpt: "0",
  };

  const respond = (req: RecordedRequest): string | null => {
    if (req.method === "GET" && req.path === "info") {
      return "fw_version=1.0.56&env=v1-001122334455&MAC=001122334455";
    }
    if (req.method === "GET" && req.path === "data") {
      state.time = String(Math.floor(Date.now() / 1000));
      return new URLSearchParams(state).toString();
    }
    if (req.method === "POST" && req.path === "cook") {
      const f = req.fields;
      if (f.acs !== undefined) {
        state.acs = f.acs;
        if (f.tpt !== undefined) state.tpt = f.tpt;
        state.dc = f.acs === "1" ? "100" : "0";
      }
      if (f.ag === "1") {
        state.ag = "1";
        state.dc = "100";
      } else if (f.ag === "0" && !opts.ignoreGrillStop) {
        state.ag = "0";
        state.dc = "0";
      }
      return "";
    }
    return null;
  };

  const server = createServer((socket: Socket) => {
    let raw = "";
    socket.on("data", (chunk) => {
      raw += chunk.toString("latin1");
      const req = parseRequest(raw);
      if (!req) return;
      requests.push(req);
      if (opts.resetPosts && req.method === "POST") {
        socket.resetAndDestroy();
        return;
      }
      const body = respond(req);
      socket.end(body === null ? "HTTP/1.0 404 Not Found\r\n\r\n" : deviceResponse(body));
    });
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return {
    host: `127.0.0.1:${port}`,
    requests,
    posts: () => requests.filter((r) => r.method === "POST"),
    state,
    close: () => new Promise((resolve) => server.close(() => resolve())),
  };
}

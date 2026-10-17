// Minimal fake iKamand for CLI tests: records requests and applies cook payloads to its state.
// Not the simulator (milestone 2); it only speaks the wire format.

import { createServer, type IncomingHttpHeaders, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { parseQs } from "../lib/protocol.ts";

export interface RecordedRequest {
  method: string;
  path: string;
  headers: IncomingHttpHeaders;
  body: string;
  fields: Record<string, string>;
}

export interface StubOptions {
  /** Ignore `ag=0`, to exercise the CLI's fallback stop. */
  ignoreGrillStop?: boolean;
}

export interface Stub {
  host: string;
  requests: RecordedRequest[];
  posts: () => RecordedRequest[];
  state: Record<string, string>;
  close: () => Promise<void>;
}

export async function startStub(opts: StubOptions = {}): Promise<Stub> {
  const requests: RecordedRequest[] = [];
  const state: Record<string, string> = {
    time: "0",
    acs: "0",
    tpt: "0",
    pt: "22",
    t1: "400",
    t2: "-400",
    t3: "400",
    dc: "0",
    sce: "0",
    csid: "",
    p: "0",
    tft: "0",
    ag: "0",
    rm: "0",
    cm: "0",
    as: "0",
  };

  const server: Server = createServer((req, res) => {
    let body = "";
    req.on("data", (chunk) => {
      body += chunk;
    });
    req.on("end", () => {
      const path = (req.url ?? "").replace("/cgi-bin/", "");
      const fields = parseQs(body);
      requests.push({ method: req.method ?? "", path, headers: req.headers, body, fields });

      if (req.method === "GET" && path === "info") {
        res.end("fw_version=1.0.56&MAC=00:11:22:33:44:55&env=prod");
        return;
      }
      if (req.method === "GET" && path === "data") {
        state.time = String(Math.floor(Date.now() / 1000));
        res.end(new URLSearchParams(state).toString());
        return;
      }
      if (req.method === "POST" && path === "cook") {
        if (fields.acs !== undefined) {
          state.acs = fields.acs;
          if (fields.tpt !== undefined) state.tpt = fields.tpt;
          if (fields.sce !== undefined) state.sce = fields.sce;
          state.dc = fields.acs === "1" ? "100" : "0";
        }
        if (fields.ag === "1") {
          state.ag = "1";
          state.dc = "100";
        } else if (fields.ag === "0" && !opts.ignoreGrillStop) {
          state.ag = "0";
          state.dc = "0";
        }
        res.end("");
        return;
      }
      res.statusCode = 404;
      res.end();
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

import { appendFileSync, mkdirSync } from "node:fs";
import { connect } from "node:net";
import path from "node:path";
import { encodeForm, type Payload, parseQs } from "./protocol.ts";

/**
 * Both references send `Content-Type: application/json` with a form-encoded body. That is the
 * default; `form` sends the correct form header instead, for the protocol.md checklist.
 */
export type ContentTypeMode = "json" | "form";

const CONTENT_TYPES: Record<ContentTypeMode, string> = {
  json: "application/json",
  form: "application/x-www-form-urlencoded",
};

export interface DeviceResponse {
  status: number;
  body: string;
  fields: Record<string, string>;
}

export interface DeviceClientOptions {
  timeoutMs?: number;
  /** Append every request and response to this file. */
  transcriptPath?: string;
}

/**
 * Parse the device's HTTP response leniently. Firmware 1.0.56 sends two status lines
 * (`HTTP/1.0 200 OK` then `HTTP/1.1 200 OK`), no headers, a bare `\n` before the body, and no
 * Content-Length, which strict parsers such as Node's fetch reject (see protocol.md › Basics).
 */
export function parseHttpResponse(raw: string): { status: number; body: string } {
  const status = /^HTTP\/\d\.\d (\d{3})/.exec(raw);
  if (!status?.[1]) throw new Error(`not an HTTP response: ${JSON.stringify(raw.slice(0, 40))}`);
  const end = /\r?\n\r?\n/.exec(raw);
  return { status: Number(status[1]), body: end ? raw.slice(end.index + end[0].length) : "" };
}

export class DeviceClient {
  readonly baseUrl: string;
  private readonly host: string;
  private readonly port: number;
  private readonly timeoutMs: number;
  private readonly transcriptPath: string | undefined;

  constructor(host: string, opts: DeviceClientOptions = {}) {
    const [name, port] = host.split(":");
    this.host = name ?? host;
    this.port = port ? Number(port) : 80;
    this.baseUrl = `http://${host}/cgi-bin/`;
    this.timeoutMs = opts.timeoutMs ?? 8000;
    this.transcriptPath = opts.transcriptPath;
    if (this.transcriptPath) mkdirSync(path.dirname(this.transcriptPath), { recursive: true });
  }

  get(endpoint: "info" | "data"): Promise<DeviceResponse> {
    return this.request("GET", endpoint);
  }

  postCook(payload: Payload, contentType: ContentTypeMode = "json"): Promise<DeviceResponse> {
    return this.request("POST", "cook", encodeForm(payload), CONTENT_TYPES[contentType]);
  }

  private async request(
    method: "GET" | "POST",
    endpoint: string,
    body?: string,
    contentType?: string,
  ): Promise<DeviceResponse> {
    this.log(
      `> ${method} ${this.baseUrl}${endpoint}${contentType ? ` [${contentType}]` : ""}${body ? ` ${body}` : ""}`,
    );
    const lines = [
      `${method} /cgi-bin/${endpoint} HTTP/1.1`,
      `Host: ${this.host}`,
      "Accept: application/json",
      "User-Agent: ikamand",
      "Connection: close",
    ];
    if (body !== undefined) {
      if (contentType) lines.push(`Content-Type: ${contentType}`);
      lines.push(`Content-Length: ${Buffer.byteLength(body)}`);
    }
    const request = `${lines.join("\r\n")}\r\n\r\n${body ?? ""}`;

    try {
      const raw = await this.exchange(request);
      const { status, body: text } = parseHttpResponse(raw);
      this.log(`< ${status} ${text.trim()}`);
      return { status, body: text, fields: parseQs(text) };
    } catch (err) {
      this.log(`! ${(err as Error).message}`);
      throw err;
    }
  }

  /** Send the request and read until the device closes the connection. */
  private exchange(request: string): Promise<string> {
    return new Promise((resolve, reject) => {
      const chunks: Buffer[] = [];
      const socket = connect({ host: this.host, port: this.port });
      const timer = setTimeout(() => {
        socket.destroy();
        reject(new Error(`timed out after ${this.timeoutMs} ms`));
      }, this.timeoutMs);
      socket.on("connect", () => socket.write(request));
      socket.on("data", (c: Buffer) => chunks.push(c));
      socket.on("error", (err) => {
        clearTimeout(timer);
        reject(err);
      });
      socket.on("close", (hadError) => {
        clearTimeout(timer);
        if (!hadError) resolve(Buffer.concat(chunks).toString("latin1"));
      });
    });
  }

  private log(line: string): void {
    if (!this.transcriptPath) return;
    appendFileSync(this.transcriptPath, `${new Date().toISOString()} ${line}\n`);
  }
}

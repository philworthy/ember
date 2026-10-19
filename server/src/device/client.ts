import { appendFileSync, mkdirSync } from "node:fs";
import path from "node:path";
import { type DecodedData, decodeData, encodeForm, type Payload, parseQs } from "./protocol.ts";
import { parseHttpResponse, TcpTransport, type Transport } from "./transport.ts";

/**
 * Both references send `Content-Type: application/json` with a form-encoded body. That is the
 * default; `form` sends the correct form header instead (also accepted by 1.0.56).
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
 * The device's HTTP client. Requests go out strictly one at a time, in order: overlapping
 * requests make the device reset connections (protocol.md › Commands), so a poll and a command
 * never share the wire.
 */
export class DeviceClient {
  readonly baseUrl: string;
  private readonly transport: Transport;
  private readonly timeoutMs: number;
  private readonly transcriptPath: string | undefined;
  private queue: Promise<unknown> = Promise.resolve();

  /** `target` is `host[:port]` for the real device, or a Transport (the simulator). */
  constructor(target: string | Transport, opts: DeviceClientOptions = {}) {
    this.transport = typeof target === "string" ? new TcpTransport(target) : target;
    this.baseUrl = this.transport.baseUrl;
    this.timeoutMs = opts.timeoutMs ?? 8000;
    this.transcriptPath = opts.transcriptPath;
    if (this.transcriptPath) mkdirSync(path.dirname(this.transcriptPath), { recursive: true });
  }

  get(endpoint: "info" | "data"): Promise<DeviceResponse> {
    return this.request("GET", endpoint);
  }

  /** GET data, decoded. Throws on a transport error or a non-2xx status. */
  async getData(): Promise<DecodedData> {
    const res = await this.get("data");
    if (res.status >= 300) throw new Error(`data returned HTTP ${res.status}`);
    return decodeData(res.fields);
  }

  postCook(payload: Payload, contentType: ContentTypeMode = "json"): Promise<DeviceResponse> {
    return this.request("POST", "cook", encodeForm(payload), CONTENT_TYPES[contentType]);
  }

  private request(
    method: "GET" | "POST",
    endpoint: string,
    body?: string,
    contentType?: string,
  ): Promise<DeviceResponse> {
    const run = () => this.send(method, endpoint, body, contentType);
    const result = this.queue.then(run, run);
    this.queue = result.catch(() => undefined);
    return result;
  }

  private async send(
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
      `Host: ${this.transport.hostHeader}`,
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
      const raw = await this.transport.exchange(request, this.timeoutMs);
      const { status, body: text } = parseHttpResponse(raw);
      this.log(`< ${status} ${text.trim()}`);
      return { status, body: text, fields: parseQs(text) };
    } catch (err) {
      this.log(`! ${(err as Error).message}`);
      throw err;
    }
  }

  private log(line: string): void {
    if (!this.transcriptPath) return;
    appendFileSync(this.transcriptPath, `${new Date().toISOString()} ${line}\n`);
  }
}

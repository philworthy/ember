import { appendFileSync, mkdirSync } from "node:fs";
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

export class DeviceClient {
  readonly baseUrl: string;
  private readonly timeoutMs: number;
  private readonly transcriptPath: string | undefined;

  constructor(host: string, opts: DeviceClientOptions = {}) {
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
    const headers: Record<string, string> = { Accept: "application/json", "User-Agent": "ikamand" };
    if (contentType) headers["Content-Type"] = contentType;
    const url = this.baseUrl + endpoint;
    this.log(
      `> ${method} ${url}${contentType ? ` [${contentType}]` : ""}${body ? ` ${body}` : ""}`,
    );
    try {
      const res = await fetch(url, {
        method,
        headers,
        body,
        signal: AbortSignal.timeout(this.timeoutMs),
      });
      const text = await res.text();
      this.log(`< ${res.status} ${text.trim()}`);
      return { status: res.status, body: text, fields: parseQs(text) };
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

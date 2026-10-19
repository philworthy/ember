import { connect } from "node:net";

/**
 * Carries one raw HTTP request to the device and returns everything it sent back before closing.
 * TcpTransport talks to a real socket; the simulator's SimTransport answers in-process with the
 * same bytes, so tests exercise the same parser without a network.
 */
export interface Transport {
  /** Shown in logs and transcripts, e.g. `http://10.0.4.98/cgi-bin/`. */
  readonly baseUrl: string;
  /** Value of the request's Host header. */
  readonly hostHeader: string;
  exchange(request: string, timeoutMs: number): Promise<string>;
}

/** An error with a Node-style `code` (ECONNRESET, ETIMEDOUT, ECONNREFUSED, ...). */
export class TransportError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
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

export class TcpTransport implements Transport {
  readonly baseUrl: string;
  readonly hostHeader: string;
  private readonly host: string;
  private readonly port: number;

  /** `host` is `name` or `name:port` (port 80 by default). */
  constructor(host: string) {
    const [name, port] = host.split(":");
    this.host = name ?? host;
    this.port = port ? Number(port) : 80;
    this.hostHeader = this.host;
    this.baseUrl = `http://${host}/cgi-bin/`;
  }

  /** Send the request and read until the device closes the connection. */
  exchange(request: string, timeoutMs: number): Promise<string> {
    return new Promise((resolve, reject) => {
      const chunks: Buffer[] = [];
      const socket = connect({ host: this.host, port: this.port });
      const timer = setTimeout(() => {
        socket.destroy();
        reject(new TransportError("ETIMEDOUT", `timed out after ${timeoutMs} ms`));
      }, timeoutMs);
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
}

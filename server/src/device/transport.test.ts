import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SimDevice } from "../sim/device.ts";
import { type SimServer, startSimServer } from "../sim/wire.ts";
import { T0 } from "../test/harness.ts";
import { DeviceClient } from "./client.ts";
import { ManualClock } from "./clock.ts";
import { stopCook } from "./protocol.ts";
import { parseHttpResponse } from "./transport.ts";

describe("parseHttpResponse", () => {
  it("handles the real 1.0.56 framing: two status lines, bare LF, trailing space", () => {
    const raw =
      "HTTP/1.0 200 OK\r\nHTTP/1.1 200 OK\r\n\ntime=197&rm=0&acs=0&csid=&cm=0&ag=0&as=0&pt=22&t1=21&t2=21&t3=22&dc=0&tpt=0 ";
    const res = parseHttpResponse(raw);
    expect(res.status).toBe(200);
    expect(res.body.startsWith("time=197&")).toBe(true);
  });

  it("handles a conventional response", () => {
    expect(parseHttpResponse("HTTP/1.1 404 Not Found\r\nX: y\r\n\r\nnope")).toEqual({
      status: 404,
      body: "nope",
    });
  });

  it("returns an empty body when the response has none", () => {
    expect(parseHttpResponse("HTTP/1.0 200 OK\r\n").body).toBe("");
  });

  it("rejects something that isn't HTTP", () => {
    expect(() => parseHttpResponse("garbage")).toThrow();
  });
});

describe("DeviceClient over TCP against the simulator", () => {
  let sim: SimDevice;
  let server: SimServer;
  beforeEach(async () => {
    sim = new SimDevice(new ManualClock(T0));
    server = await startSimServer(sim);
  });
  afterEach(() => server.close());

  it("POSTs a form-encoded body under a JSON content type, like the references", async () => {
    await new DeviceClient(server.host).postCook(stopCook(1000));
    const [req] = server.requests;
    expect(req?.path).toBe("cook");
    expect(req?.headers["content-type"]).toBe("application/json");
    expect(req?.headers["user-agent"]).toBe("ikamand");
    expect(req?.body).toBe("acs=0&csid=&tpt=0&sce=0&p=0&tft=0&as=0&ct=1000");
  });

  it("can send the correct form content type instead", async () => {
    await new DeviceClient(server.host).postCook(stopCook(1000), "form");
    expect(server.requests[0]?.headers["content-type"]).toBe("application/x-www-form-urlencoded");
  });

  it("GETs data and parses the malformed response", async () => {
    const d = await new DeviceClient(server.host).getData();
    expect(d).toMatchObject({ valid: true, cookActive: false, pitC: 22, t1C: null });
    expect(d.deviceTime).toBe(T0 / 1000);
  });

  it("surfaces a reset as ECONNRESET", async () => {
    sim.failNext("reset");
    await expect(new DeviceClient(server.host).get("data")).rejects.toMatchObject({
      code: "ECONNRESET",
    });
  });

  it("times out when the device holds the connection open", async () => {
    sim.failNext("timeout");
    const client = new DeviceClient(server.host, { timeoutMs: 50 });
    await expect(client.get("data")).rejects.toMatchObject({ code: "ETIMEDOUT" });
  });

  it("fails when nothing is listening", async () => {
    await server.close();
    await expect(new DeviceClient(server.host, { timeoutMs: 500 }).get("data")).rejects.toThrow();
    server = await startSimServer(sim);
  });
});

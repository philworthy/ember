import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type Stub, startStub } from "../test/stub.ts";
import { DeviceClient } from "./client.ts";
import { stopCook } from "./protocol.ts";

describe("DeviceClient wire shape", () => {
  let stub: Stub;
  beforeEach(async () => {
    stub = await startStub();
  });
  afterEach(() => stub.close());

  it("POSTs a form-encoded body under a JSON content type, like the references", async () => {
    await new DeviceClient(stub.host).postCook(stopCook(1000));
    const [req] = stub.posts();
    expect(req?.path).toBe("cook");
    expect(req?.headers["content-type"]).toBe("application/json");
    expect(req?.headers["user-agent"]).toBe("ikamand");
    expect(req?.body).toBe("acs=0&csid=&tpt=0&sce=0&p=0&tft=0&as=0&ct=1000");
  });

  it("can send the correct form content type instead", async () => {
    await new DeviceClient(stub.host).postCook(stopCook(1000), "form");
    expect(stub.posts()[0]?.headers["content-type"]).toBe("application/x-www-form-urlencoded");
  });

  it("GETs data and parses the query-string response", async () => {
    const res = await new DeviceClient(stub.host).get("data");
    expect(stub.requests[0]?.method).toBe("GET");
    expect(res.fields.t1).toBe("400");
    expect(res.fields.pt).toBe("22");
  });

  it("times out", async () => {
    const client = new DeviceClient("10.255.255.1", { timeoutMs: 50 });
    await expect(client.get("data")).rejects.toThrow();
  });
});

import { describe, expect, it } from "vitest";
import { SimDevice } from "../sim/device.ts";
import { SimTransport } from "../sim/wire.ts";
import { T0 } from "../test/harness.ts";
import { DeviceClient } from "./client.ts";
import { ManualClock } from "./clock.ts";
import { startCook, stopCook } from "./protocol.ts";

function setup(overlapResetRate = 1) {
  const sim = new SimDevice(new ManualClock(T0), { overlapResetRate });
  return { sim, client: new DeviceClient(new SimTransport(sim)) };
}

describe("DeviceClient request queue", () => {
  it("never has two requests in flight, so polls and commands don't collide", async () => {
    const { sim, client } = setup();
    const now = T0 / 1000;
    const results = await Promise.allSettled([
      client.getData(),
      client.postCook(startCook(107, now)),
      client.getData(),
      client.postCook(stopCook(now)),
      client.get("info"),
    ]);
    expect(results.every((r) => r.status === "fulfilled")).toBe(true);
    expect(sim.maxConcurrency).toBe(1);
    expect(sim.log.map((r) => `${r.method} ${r.path}`)).toEqual([
      "GET data",
      "POST cook",
      "GET data",
      "POST cook",
      "GET info",
    ]);
  });

  it("keeps going after a failed request", async () => {
    const { sim, client } = setup();
    sim.failNext("reset");
    const [a, b] = await Promise.allSettled([client.getData(), client.getData()]);
    expect(a.status).toBe("rejected");
    expect(b.status).toBe("fulfilled");
  });

  it("the simulator punishes overlapping requests (so the queue test means something)", async () => {
    const { sim } = setup();
    const raw = "GET /cgi-bin/data HTTP/1.1\r\nHost: sim\r\n\r\n";
    const t = new SimTransport(sim);
    const results = await Promise.allSettled([t.exchange(raw, 100), t.exchange(raw, 100)]);
    expect(sim.maxConcurrency).toBe(2);
    expect(results.some((r) => r.status === "rejected")).toBe(true);
  });
});

import { fToC } from "@ember/shared";
import { describe, expect, it } from "vitest";
import { DeviceClient } from "../device/client.ts";
import { ManualClock } from "../device/clock.ts";
import { grillStartA, startCook, stopCook } from "../device/protocol.ts";
import { HOUR, MIN, SEC, T0 } from "../test/harness.ts";
import { SimDevice, type SimOptions } from "./device.ts";
import { getScenario } from "./scenarios.ts";
import { SimTransport } from "./wire.ts";

function rig(opts: SimOptions = {}) {
  const clock = new ManualClock(T0);
  const sim = new SimDevice(clock, { seed: 3, ...opts });
  const client = new DeviceClient(new SimTransport(sim));
  const now = () => Math.floor(clock.now() / 1000);
  return { clock, sim, client, now };
}

describe("wire format", () => {
  it("answers with firmware 1.0.56's exact malformed framing and field order", async () => {
    const { sim } = rig();
    const raw = await new SimTransport(sim).exchange(
      "GET /cgi-bin/data HTTP/1.1\r\nHost: sim\r\n\r\n",
      1000,
    );
    expect(raw).toMatch(
      /^HTTP\/1\.0 200 OK\r\nHTTP\/1\.1 200 OK\r\n\ntime=\d+&rm=0&acs=0&csid=&cm=0&ag=0&as=0&pt=\d+&t1=400&t2=400&t3=400&dc=0&tpt=0 $/,
    );
  });

  it("never reports sce, p or tft, idle or cooking", async () => {
    const { client, now } = rig();
    await client.postCook(startCook(107, now(), { slot: 1, tftC: 30 }));
    const res = await client.get("data");
    expect(Object.keys(res.fields)).not.toContain("sce");
    expect(Object.keys(res.fields)).not.toContain("p");
    expect(Object.keys(res.fields)).not.toContain("tft");
    expect(res.fields).toMatchObject({ acs: "1", rm: "1", tpt: "107" });
  });

  it("answers info as the real unit does", async () => {
    const res = await rig().client.get("info");
    expect(res.fields.fw_version).toBe("1.0.56");
  });

  it("answers a cook POST with an empty 200", async () => {
    const { client, now } = rig();
    const res = await client.postCook(stopCook(now()));
    expect(res.status).toBe(200);
    expect(res.body.trim()).toBe("");
  });
});

describe("firmware behaviour", () => {
  it("ends the cook itself at sce, leaving tpt set", async () => {
    const { client, clock, now } = rig();
    await client.postCook({ ...startCook(260, now()), sce: now() + 60 });
    clock.advance(59 * SEC);
    expect((await client.getData()).cookActive).toBe(true);
    clock.advance(2 * SEC);
    const d = await client.getData();
    expect(d).toMatchObject({ cookActive: false, fanPct: 0, targetPitC: 260 });
  });

  it("ignores method A (ag=1): accepted, but nothing runs", async () => {
    const { client, clock, now } = rig();
    expect((await client.postCook(grillStartA(2, now()))).status).toBe(200);
    clock.advance(10 * SEC);
    expect(await client.getData()).toMatchObject({ cookActive: false, fanPct: 0, ag: "0" });
  });

  it("a reset POST is not applied", async () => {
    const { client, sim, now } = rig();
    sim.failNext("reset");
    await expect(client.postCook(startCook(107, now()))).rejects.toMatchObject({
      code: "ECONNRESET",
    });
    expect((await client.getData()).cookActive).toBe(false);
  });

  it("an unplugged probe reads 400", async () => {
    const { client, sim } = rig();
    sim.insertProbe(2, { startC: 4, weightLb: 8 });
    expect(Math.abs(Number((await client.get("data")).fields.t2) - 4)).toBeLessThanOrEqual(1);
    sim.unplugProbe(2);
    expect((await client.get("data")).fields.t2).toBe("400");
  });

  it("runs the fan flat out on a cold start and holds the target", async () => {
    const { client, clock, now } = rig();
    await client.postCook(startCook(107, now()));
    clock.advance(10 * SEC);
    expect((await client.getData()).fanPct).toBe(100);
    clock.advance(2 * HOUR);
    const d = await client.getData();
    expect(Math.abs((d.pitC ?? 0) - 107)).toBeLessThanOrEqual(2);
    expect(d.fanPct).toBeLessThan(40);
  });
});

describe("reboot", () => {
  it("loses the cook, answers late with an unset clock and garbage, then settles", async () => {
    const { client, sim, clock, now } = rig({ httpReadyAfterS: 19 });
    await client.postCook(startCook(107, now()));
    clock.advance(1 * HOUR);
    sim.powerCycle(60);

    clock.advance(70 * SEC); // 10 s after power-on: nothing on the network yet
    await expect(client.getData()).rejects.toMatchObject({ code: "EHOSTUNREACH" });

    clock.advance(10 * SEC); // uptime 20
    const early = await client.getData();
    expect(early).toMatchObject({ valid: false, cookActive: false, targetPitC: 0 });
    expect(early.deviceTime).toBe(20);
    expect(early.pitC).toBe(early.t1C); // pit and P1 read the same bogus value
    expect(early.pitC).not.toBeCloseTo(sim.truth.pitC, -1);

    clock.advance(20 * SEC); // uptime 40: real values, clock still unset
    const later = await client.getData();
    expect(later.valid).toBe(false);
    expect(Math.abs((later.pitC ?? 0) - sim.truth.pitC)).toBeLessThanOrEqual(1);

    clock.advance(10 * SEC); // uptime 50: set its own clock
    expect((await client.getData()).valid).toBe(true);
  });

  it("any command's ct sets the clock at once", async () => {
    const { client, sim, clock, now } = rig();
    sim.powerCycle(5);
    clock.advance(5 * SEC + 30 * SEC);
    expect((await client.getData()).valid).toBe(false);
    await client.postCook(stopCook(now()));
    const d = await client.getData();
    expect(d.valid).toBe(true);
    expect(d.deviceTime).toBe(now());
  });

  it("a web-server outage refuses connections but the cook carries on", async () => {
    const { client, sim, clock, now } = rig();
    await client.postCook(startCook(107, now()));
    sim.webOutage(150);
    clock.advance(60 * SEC);
    await expect(client.getData()).rejects.toMatchObject({ code: "ECONNREFUSED" });
    clock.advance(100 * SEC);
    expect((await client.getData()).cookActive).toBe(true);
  });
});

describe("faults", () => {
  it("fails at about the configured rate, in streaks of at most 3", async () => {
    const { client, sim } = rig({ faults: { rate: 0.015, streakMax: 3 } });
    let streak = 0;
    let longest = 0;
    let failed = 0;
    for (let i = 0; i < 3000; i++) {
      try {
        await client.getData();
        streak = 0;
      } catch {
        failed++;
        streak++;
        longest = Math.max(longest, streak);
      }
    }
    expect(longest).toBeLessThanOrEqual(3);
    expect(failed / 3000).toBeGreaterThan(0.01);
    expect(failed / 3000).toBeLessThan(0.06);
    expect(sim.maxConcurrency).toBe(1);
  });
});

describe("physics via scenarios", () => {
  async function cook(name: string, hours: number) {
    const { client, sim, clock, now } = rig();
    getScenario(name).setup(sim, clock.now());
    const s = getScenario(name);
    if ("pitC" in s.cook) await client.postCook(startCook(s.cook.pitC, now()));
    const samples: { h: number; pit: number; p1: number }[] = [];
    for (let t = 0; t <= hours * 60; t += 5) {
      const truth = sim.truth;
      samples.push({ h: t / 60, pit: truth.pitC, p1: truth.probeC[1] });
      clock.advance(5 * MIN);
    }
    return { sim, samples };
  }

  it("brisket: stalls for hours between 155 and 165 °F, reaches 203 °F in 10–14 h", async () => {
    const { samples } = await cook("brisket", 15);
    const inStall = samples.filter((s) => s.p1 >= fToC(156) && s.p1 <= fToC(164));
    expect(inStall.length * 5).toBeGreaterThan(120); // minutes
    // Pulled at 203 °F; 5-minute samples land just short of the exact moment.
    const done = samples.reduce((a, b) => (b.p1 > a.p1 ? b : a));
    expect(done.p1).toBeGreaterThan(fToC(200));
    expect(done.h).toBeGreaterThan(10);
    expect(done.h).toBeLessThan(14);
    // Then it comes off: the probe falls to ambient.
    expect(samples.at(-1)?.p1).toBeLessThan(30);
  });

  it("pizza: reaches 700 °F (371 °C) within 40 min", async () => {
    const { samples } = await cook("pizza", 1);
    const hot = samples.find((s) => s.pit >= 365);
    expect(hot?.h).toBeLessThan(40 / 60);
  });

  it("meat removed: the probe drops more than 15 °F within 2 min of coming off", async () => {
    const { client, sim, clock, now } = rig();
    getScenario("meatRemoved").setup(sim, clock.now());
    await client.postCook(startCook(177, now()));
    let peak = 0;
    for (let i = 0; i < 3 * 720 && sim.truth.probeC[1] >= peak; i++) {
      peak = sim.truth.probeC[1];
      clock.advance(5 * SEC);
    }
    expect(peak).toBeGreaterThan(fToC(164));
    clock.advance(2 * MIN - 5 * SEC);
    expect(peak - sim.truth.probeC[1]).toBeGreaterThan((15 * 5) / 9);
  });
});

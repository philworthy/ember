// End to end: the device link (client queue + state machine + driver) against the simulator,
// on a shared manual clock, polling every 5 s of simulated time.

import { fToC } from "@ember/shared";
import { describe, expect, it } from "vitest";
import { step as realStep } from "./device/machine.ts";
import { MIN_VALID_DEVICE_TIME, startCook } from "./device/protocol.ts";
import { HOUR, harness, MIN, SEC, T0 } from "./test/harness.ts";

const PIT_225 = Math.round(fToC(225));

async function startedCook(scenario: string) {
  const h = harness({ scenario });
  await h.boot();
  const result = h.link.command({ kind: "start", tptC: PIT_225 });
  await h.run(10 * SEC);
  expect(await result).toEqual({ ok: true });
  return h;
}

describe("brisket, start to finish", () => {
  it("logs the whole cook, keeps sce fresh, and never trips the alarms", async () => {
    const h = await startedCook("brisket");
    await h.runUntil(() => h.sim.probeC(1) < 40 && h.clock.now() - T0 > 8 * HOUR, 16 * HOUR);
    const hours = (h.clock.now() - T0) / HOUR;

    expect(h.of("foreignControl")).toEqual([]);
    expect(h.of("selfStopped")).toEqual([]);
    expect(h.of("link").map((e) => e.state)).toEqual(["recovering", "online"]);
    expect(h.sim.truth.acs).toBe(true);

    // sce pushed out every hour, always ≤ 24 h ahead.
    const extend = h.of("sent").filter((e) => e.reason === "extend");
    expect(extend.length).toBeGreaterThanOrEqual(Math.floor(hours) - 1);
    for (const e of h.of("sent")) {
      expect(Number(e.payload.sce) - Number(e.payload.ct)).toBeLessThanOrEqual(86_400);
    }

    // One reading per poll, sentinels mapped to null, and the stall is visible.
    const readings = h.of("reading").map((e) => e.reading);
    expect(readings.length).toBeGreaterThan(hours * 700);
    expect(readings.every((r) => r.t2C === null && r.t3C === null)).toBe(true);
    const stall = readings.filter(
      (r) => r.t1C !== null && r.t1C >= fToC(156) && r.t1C <= fToC(164),
    );
    expect((stall.length * 5) / 60).toBeGreaterThan(120); // minutes in the stall
    const holding = readings.filter((r) => r.ts > T0 + 2 * HOUR);
    expect(holding.every((r) => Math.abs((r.pitC ?? 0) - PIT_225) <= 3)).toBe(true);
  });
});

describe("reboot mid-cook", () => {
  it("drops the garbage, waits for sane readings, then resumes the cook", async () => {
    const h = await startedCook("rebootMidCook");
    await h.run(3 * HOUR);
    const cutAt = T0 + 3 * HOUR;
    await h.run(10 * MIN);

    const after = h
      .of("reading")
      .filter((e) => e.at > cutAt)
      .map((e) => e.reading);
    expect(after.every((r) => Number(r.raw.time) >= MIN_VALID_DEVICE_TIME)).toBe(true);
    expect(after.every((r) => (r.pitC ?? 0) < PIT_225 + 10)).toBe(true); // no 126 °C ghosts

    const [recovery] = h.of("recovery").filter((e) => e.at > cutAt);
    expect(recovery?.action).toBe("resume");
    // Power back at +60 s, HTTP at +89 s; recovery waits for ~30 s of sane readings after that.
    expect((recovery?.at ?? 0) - cutAt).toBeGreaterThan(60 * SEC + 34 * SEC + 30 * SEC);
    expect(h.sim.truth).toMatchObject({ acs: true, tptC: PIT_225, clockSet: true });
    expect(h.of("foreignControl")).toEqual([]);
  });

  it("long outage (25 min): still resumes when the device comes back", async () => {
    const h = await startedCook("longOutage");
    await h.run(3 * HOUR + 40 * MIN);
    expect(h.of("link").map((e) => e.state)).toContain("offline");
    expect(h.of("recovery").at(-1)?.action).toBe("resume");
    expect(h.sim.truth.acs).toBe(true);
  });
});

describe("flaky device", () => {
  it("rides out failure streaks; only the 2½-min outage counts as offline", async () => {
    const h = await startedCook("flaky");
    const retarget = h.link.command({ kind: "start", tptC: PIT_225 + 5 });
    await h.run(1 * MIN);
    expect(await retarget).toEqual({ ok: true });
    await h.run(4 * HOUR);

    expect(h.sim.log.filter((r) => r.outcome === "reset").length).toBeGreaterThan(20);
    const offline = h.of("link").filter((e) => e.state === "offline");
    expect(offline).toHaveLength(1);
    expect(offline[0]?.at).toBeGreaterThan(T0 + 2 * HOUR);
    expect(offline[0]?.at).toBeLessThan(T0 + 2 * HOUR + 3 * MIN);
    expect(h.of("commandFailed")).toEqual([]);
    expect(h.of("foreignControl")).toEqual([]);
    expect(h.sim.truth).toMatchObject({ acs: true, tptC: PIT_225 + 5 });
    expect(h.sim.maxConcurrency).toBe(1);
  });

  it("a reset POST is read back and resent until it lands", async () => {
    const h = harness();
    await h.boot();
    h.sim.failNext("reset");
    const result = h.link.command({ kind: "start", tptC: 107 });
    await h.run(15 * SEC);
    expect(await result).toEqual({ ok: true });
    expect(h.of("sent").map((e) => [e.reason, e.ok])).toEqual([
      ["recovery", true],
      ["command", false],
      ["resend", true],
    ]);
  });
});

describe("another client", () => {
  it("is reported and followed, never fought", async () => {
    const h = await startedCook("foreignClient");
    await h.run(2 * HOUR);
    const foreign = h.of("foreignControl");
    expect(foreign.map((e) => [e.before.acs, e.after.acs])).toEqual([
      [true, false],
      [false, true],
    ]);
    // Between the foreign stop and the foreign restart, Ember sent nothing.
    const [stopSeen, restartSeen] = foreign.map((e) => e.at);
    expect(h.of("sent").filter((e) => e.at > (stopSeen ?? 0) && e.at < (restartSeen ?? 0))).toEqual(
      [],
    );
    expect(h.link.snapshot.intent).toMatchObject({ kind: "cook", origin: "foreign" });
  });
});

describe("server start", () => {
  it("adopts a cook it finds running with nothing saved", async () => {
    const h = harness();
    h.sim.foreignCommand(startCook(135, T0 / 1000));
    await h.boot();
    expect(h.of("adopted")).toEqual([expect.objectContaining({ tptC: 135 })]);
    expect(h.link.snapshot.intent).toEqual({ kind: "cook", tptC: 135, origin: "adopted" });
    expect(h.of("sent")[0]?.payload).toMatchObject({ acs: 1, tpt: 135 });
  });

  it("reconciles a saved cook with the device before sending anything", async () => {
    const h = harness({ restore: { intent: { kind: "cook", tptC: 107, origin: "user" } } });
    h.sim.foreignCommand(startCook(107, T0 / 1000));
    await h.link.tick();
    await h.run(25 * SEC);
    expect(h.of("sent")).toEqual([]);
    await h.run(10 * SEC);
    expect(h.of("recovery")[0]?.action).toBe("resume");
    expect(h.of("adopted")).toEqual([]);
  });
});

describe("Fire it up", () => {
  it("runs flat out, then the server stops it with a full stop", async () => {
    const h = harness({ scenario: "fireUp" });
    await h.boot();
    const sent = h.link.command({ kind: "fireUp", minutes: 10, thenHoldC: null });
    await h.run(10 * SEC);
    expect(await sent).toEqual({ ok: true });
    await h.run(1 * MIN);
    expect(h.sim.truth).toMatchObject({ acs: true, tptC: 260, dc: 100 });
    await h.run(9 * MIN);
    expect(h.of("fireUpEnded")).toHaveLength(1);
    expect(h.sim.truth).toMatchObject({ acs: false, tptC: 0, dc: 0 });
    expect(h.of("foreignControl")).toEqual([]);
  });

  it("if the server dies, the device's own sce still stops it", async () => {
    const h = harness({ scenario: "fireUp" });
    await h.boot();
    const sent = h.link.command({ kind: "fireUp", minutes: 10, thenHoldC: null });
    await h.run(10 * SEC);
    expect(await sent).toEqual({ ok: true });
    h.clock.advance(10 * MIN); // nobody polls
    expect(h.sim.truth).toMatchObject({ acs: false, dc: 0, tptC: 260 });
  });

  it("with 'then hold' it switches to the hold target", async () => {
    const h = harness({ scenario: "fireUp" });
    await h.boot();
    const sent = h.link.command({ kind: "fireUp", minutes: 10, thenHoldC: 121 });
    await h.run(10 * SEC);
    expect(await sent).toEqual({ ok: true });
    await h.run(15 * MIN);
    expect(h.sim.truth).toMatchObject({ acs: true, tptC: 121 });
    expect(h.of("selfStopped")).toEqual([]);
  });
});

describe("probes", () => {
  it("an unplugged probe reads null from then on", async () => {
    const h = await startedCook("probeUnplugged");
    await h.run(3 * HOUR);
    const readings = h.of("reading").map((e) => e.reading);
    expect(readings.filter((r) => r.ts < T0 + 2 * HOUR).every((r) => r.t2C !== null)).toBe(true);
    expect(
      readings.filter((r) => r.ts > T0 + 2 * HOUR + 10 * SEC).every((r) => r.t2C === null),
    ).toBe(true);
  });
});

describe("safety", () => {
  it("stops the fan and halts if the state machine keeps failing", async () => {
    let broken = false;
    const h = harness({
      link: {
        step: (s, input, now) => {
          if (broken) throw new Error("bug");
          return realStep(s, input, now);
        },
      },
    });
    await h.boot();
    const sent = h.link.command({ kind: "start", tptC: 107 });
    await h.run(10 * SEC);
    expect(await sent).toEqual({ ok: true });
    expect(h.sim.truth.acs).toBe(true);
    broken = true;
    await h.run(2 * MIN);
    expect(h.of("fault").length).toBe(12);
    expect(h.of("halted")).toHaveLength(1);
    expect(h.sim.truth).toMatchObject({ acs: false, dc: 0 });
  });

  it("stopping the link leaves the cook running (a redeploy mustn't end a brisket)", async () => {
    const h = await startedCook("brisket");
    await h.link.stop();
    expect(h.sim.truth.acs).toBe(true);
  });
});

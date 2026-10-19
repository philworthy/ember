import { describe, expect, it } from "vitest";
import {
  type Command,
  type DeviceEvent,
  type Effect,
  type Input,
  initialState,
  type MachineState,
  type Restore,
  step,
  TIMING,
} from "./machine.ts";
import { decodeData, parseQs } from "./protocol.ts";

const T0 = 1_792_368_000_000;
const S = 1000;

interface Dev {
  acs?: 0 | 1;
  tpt?: number;
  pt?: number;
  t1?: number;
  /** Device time in s; defaults to the server's clock. */
  time?: number;
}

/** A tiny driver for the pure machine: one input at a time, on a clock we move by hand. */
class Rig {
  s: MachineState;
  now = T0;
  effects: Effect[] = [];
  private ids = 0;

  constructor(restore?: Restore) {
    this.s = initialState(this.now, restore);
  }

  feed(input: Input): Effect[] {
    const r = step(this.s, input, this.now);
    this.s = r.state;
    this.effects.push(...r.effects);
    return r.effects;
  }

  poll(dev: Dev | null, opts: { stale?: boolean } = {}): Effect[] {
    this.now += TIMING.pollMs;
    if (dev === null) return this.feed({ type: "poll", ok: false });
    const time = dev.time ?? Math.floor(this.now / 1000);
    const body = `time=${time}&rm=${dev.acs ?? 0}&acs=${dev.acs ?? 0}&csid=&cm=0&ag=0&as=0&pt=${dev.pt ?? 23}&t1=${dev.t1 ?? 400}&t2=400&t3=400&dc=0&tpt=${dev.tpt ?? 0}`;
    return this.feed({ type: "poll", ok: true, data: decodeData(parseQs(body)), ...opts });
  }

  /** Poll the same device state for `ms`. */
  hold(dev: Dev | null, ms: number): Effect[] {
    const out: Effect[] = [];
    for (let t = 0; t < ms; t += TIMING.pollMs) out.push(...this.poll(dev));
    return out;
  }

  command(command: Command): Effect[] {
    return this.feed({ type: "command", id: String(++this.ids), command });
  }

  /** Bring the link online against an idle or cooking device. */
  online(dev: Dev = {}): this {
    this.hold(dev, TIMING.recoverySaneMs + TIMING.pollMs);
    expect(this.s.link).toBe("online");
    this.effects = [];
    return this;
  }
}

const sends = (fx: Effect[]) =>
  fx.filter((e): e is Extract<Effect, { type: "send" }> => e.type === "send");
const events = <T extends DeviceEvent["type"]>(fx: Effect[], type: T) =>
  fx
    .filter((e): e is Extract<Effect, { type: "emit" }> => e.type === "emit")
    .map((e) => e.event)
    .filter((e): e is Extract<DeviceEvent, { type: T }> => e.type === type);

describe("offline detection", () => {
  it("a streak of 3 failed polls is not offline (seen on a healthy device)", () => {
    const r = new Rig().online();
    r.hold(null, 3 * TIMING.pollMs);
    expect(r.s.link).toBe("online");
    r.poll({});
    expect(r.s.link).toBe("online");
    expect(events(r.effects, "link")).toEqual([]);
  });

  it("goes offline after 30 s without a successful response", () => {
    const r = new Rig().online();
    r.hold(null, 25 * S);
    expect(r.s.link).toBe("online");
    r.poll(null);
    expect(r.s.link).toBe("offline");
  });

  it("goes offline at startup if the device never answers", () => {
    const r = new Rig();
    r.hold(null, 30 * S);
    expect(r.s.link).toBe("offline");
  });

  it("a device answering with an unset clock is recovering, not offline", () => {
    const r = new Rig().online();
    r.hold({ time: 40 }, 60 * S);
    expect(r.s.link).not.toBe("offline");
  });
});

describe("recovery", () => {
  it("runs once per reconnect, after 30 s of sane readings, not on every poll", () => {
    const r = new Rig();
    r.poll({});
    expect(r.s.link).toBe("recovering");
    r.hold({}, 25 * S);
    expect(sends(r.effects)).toHaveLength(0);
    r.hold({}, 10 * S);
    expect(events(r.effects, "recovery")).toHaveLength(1);
    expect(r.s.link).toBe("online");
    r.hold({}, 5 * 60 * S);
    expect(events(r.effects, "recovery")).toHaveLength(1);
  });

  it("withholds readings while recovering", () => {
    const r = new Rig();
    r.hold({}, 30 * S);
    expect(events(r.effects, "reading")).toEqual([]);
    expect(events(r.effects, "dropped").length).toBeGreaterThan(0);
  });

  it("waits out the post-boot garbage: unset clock, then uptime ≥ 35 s, then 30 s sane", () => {
    const r = new Rig({ intent: { kind: "cook", tptC: 107, origin: "user" } }).online({
      acs: 1,
      tpt: 107,
    });
    // Rebooted: clock unset, cook lost, pit and P1 read a climbing bogus value.
    r.poll({ time: 19, pt: 84, t1: 84 });
    r.poll({ time: 24, pt: 108, t1: 108 });
    r.poll({ time: 29, pt: 132, t1: 132 });
    expect(r.s.link).toBe("recovering");
    // Snaps to the real value: a > 50 °C jump, so not sane yet.
    r.poll({ time: 34, pt: 60, t1: 23 });
    for (let up = 39; up < 69; up += 5) r.poll({ time: up, pt: 60, t1: 23 });
    expect(sends(r.effects)).toHaveLength(0);
    r.poll({ time: 69, pt: 60, t1: 23 });
    const [send] = sends(r.effects);
    expect(send?.payload).toMatchObject({ acs: 1, tpt: 107 });
    expect(events(r.effects, "recovery")[0]?.action).toBe("resume");
    expect(events(r.effects, "reading")).toEqual([]);
  });

  it("a jump during the wait restarts it", () => {
    const r = new Rig();
    r.hold({}, 20 * S);
    r.poll({ pt: 100 });
    r.hold({ pt: 100 }, 25 * S);
    expect(sends(r.effects)).toHaveLength(0);
    r.hold({ pt: 100 }, 10 * S);
    expect(sends(r.effects)).toHaveLength(1);
  });

  it("is triggered by clock skew over 60 s", () => {
    const r = new Rig().online();
    r.poll({ time: Math.floor(r.now / 1000) + 90 });
    expect(r.s.link).toBe("recovering");
  });

  it("is triggered by coming back from offline", () => {
    const r = new Rig().online();
    r.hold(null, 35 * S);
    expect(r.s.link).toBe("offline");
    r.poll({});
    expect(r.s.link).toBe("recovering");
  });

  describe("reconcile table", () => {
    const after = (restore: Restore | undefined, dev: Dev, now?: (r: Rig) => void) => {
      const r = new Rig(restore);
      now?.(r);
      r.hold(dev, TIMING.recoverySaneMs + TIMING.pollMs);
      return { r, send: sends(r.effects)[0], action: events(r.effects, "recovery")[0]?.action };
    };
    const cook = { intent: { kind: "cook" as const, tptC: 107, origin: "user" as const } };

    it("cook + device cooking at the target → resend start (sets clock, refreshes sce)", () => {
      const { send, action } = after(cook, { acs: 1, tpt: 107 });
      expect(action).toBe("resume");
      expect(send?.payload).toMatchObject({ acs: 1, tpt: 107 });
    });

    it("cook + device idle (cook lost) → resume at the intent's target", () => {
      const { send, action } = after(cook, { acs: 0, tpt: 0 });
      expect(action).toBe("resume");
      expect(send?.payload).toMatchObject({ acs: 1, tpt: 107 });
    });

    it("cook + device gone for hours → still resume (Phil's call, not HA's 10 min)", () => {
      const { action } = after(
        { ...cook, lastGoodReadingMs: T0 - 5 * 3_600_000 },
        { acs: 0, tpt: 0 },
      );
      expect(action).toBe("resume");
    });

    it("fire it up still running → resend it with the original end as sce", () => {
      const endsAtMs = T0 + 10 * 60 * S;
      const { send, action } = after(
        { intent: { kind: "fireUp", endsAtMs, thenHoldC: null } },
        { acs: 0, tpt: 0 },
      );
      expect(action).toBe("fireUp");
      expect(send?.payload).toMatchObject({ acs: 1, tpt: 260, sce: endsAtMs / 1000 });
    });

    it("fire it up expired → stop, or hold the target if 'then hold'", () => {
      const endsAtMs = T0 + 10 * S;
      const stop = after(
        { intent: { kind: "fireUp", endsAtMs, thenHoldC: null } },
        { acs: 1, tpt: 260 },
      );
      expect(stop.action).toBe("fireUpEnded");
      expect(stop.send?.payload).toMatchObject({ acs: 0, tpt: 0 });
      const hold = after(
        { intent: { kind: "fireUp", endsAtMs, thenHoldC: 121 } },
        { acs: 1, tpt: 260 },
      );
      expect(hold.send?.payload).toMatchObject({ acs: 1, tpt: 121 });
    });

    it("no intent + device cooking → adopt it at the device's target", () => {
      const { r, send, action } = after(undefined, { acs: 1, tpt: 135 });
      expect(action).toBe("adopt");
      expect(events(r.effects, "adopted")).toEqual([{ type: "adopted", tptC: 135 }]);
      expect(r.s.intent).toEqual({ kind: "cook", tptC: 135, origin: "adopted" });
      expect(Number(send?.payload.sce) - Number(send?.payload.ct)).toBe(86_400);
    });

    it("Ember stopped it + device cooking → stop, not adopt", () => {
      const { action, send } = after(
        { intent: { kind: "idle", by: "ember" } },
        { acs: 1, tpt: 135 },
      );
      expect(action).toBe("stop");
      expect(send?.payload).toMatchObject({ acs: 0, tpt: 0 });
    });

    it("idle + device idle → a harmless stop, whose ct sets the clock", () => {
      const { action, send } = after(undefined, { acs: 0, tpt: 0 });
      expect(action).toBe("stop");
      expect(send?.payload.ct).toBeGreaterThan(0);
    });
  });
});

describe("commands", () => {
  it("sends the full payload and resolves on read-back", () => {
    const r = new Rig().online();
    const [send] = sends(r.command({ kind: "start", tptC: 107 }));
    expect(send?.payload).toMatchObject({ acs: 1, csid: "", tpt: 107, p: 0, tft: 0, as: 0 });
    expect(events(r.poll({ acs: 1, tpt: 107 }), "commandApplied")).toEqual([
      { type: "commandApplied", ids: ["1"] },
    ]);
  });

  it("a reset POST isn't applied: read back, resend the full command with a fresh ct", () => {
    const r = new Rig().online();
    const [first] = sends(r.command({ kind: "start", tptC: 121 }));
    const fx = r.poll({ acs: 0, tpt: 0 });
    const [resend] = sends(fx);
    expect(resend?.reason).toBe("resend");
    expect(resend?.payload).toMatchObject({ acs: 1, tpt: 121 });
    expect(Number(resend?.payload.ct)).toBeGreaterThan(Number(first?.payload.ct));
    expect(events(r.poll({ acs: 1, tpt: 121 }), "commandApplied")).toHaveLength(1);
  });

  it("gives up after 3 sends", () => {
    const r = new Rig().online();
    r.command({ kind: "start", tptC: 121 });
    r.hold({}, 3 * TIMING.pollMs);
    expect(sends(r.effects)).toHaveLength(3);
    expect(events(r.effects, "commandFailed")).toEqual([
      { type: "commandFailed", ids: ["1"], reason: "no-readback" },
    ]);
    expect(events(r.effects, "foreignControl")).toEqual([]);
  });

  it("ignores a poll whose data predates the command", () => {
    const r = new Rig().online();
    r.command({ kind: "start", tptC: 121 });
    expect(sends(r.poll({}, { stale: true }))).toEqual([]);
  });

  it("a newer command supersedes one still being read back", () => {
    const r = new Rig().online();
    r.command({ kind: "start", tptC: 121 });
    expect(events(r.command({ kind: "stop" }), "commandFailed")).toEqual([
      { type: "commandFailed", ids: ["1"], reason: "superseded" },
    ]);
  });

  it("stop goes out at once even while recovering; start waits for recovery", () => {
    const r = new Rig();
    r.poll({ acs: 1, tpt: 107 });
    expect(r.s.link).toBe("recovering");
    expect(sends(r.command({ kind: "start", tptC: 121 }))).toEqual([]);
    expect(sends(r.command({ kind: "stop" }))[0]?.payload).toMatchObject({ acs: 0 });
  });

  it("start while recovering goes out with recovery's send and resolves with it", () => {
    const r = new Rig();
    r.poll({});
    r.command({ kind: "start", tptC: 121 });
    r.hold({}, TIMING.recoverySaneMs + TIMING.pollMs);
    expect(sends(r.effects)[0]?.payload).toMatchObject({ acs: 1, tpt: 121 });
    expect(events(r.poll({ acs: 1, tpt: 121 }), "commandApplied")[0]?.ids).toEqual(["1"]);
  });
});

describe("another client controlling the device", () => {
  const cooking = () => {
    const r = new Rig({ intent: { kind: "cook", tptC: 107, origin: "user" } }).online({
      acs: 1,
      tpt: 107,
    });
    r.poll({ acs: 1, tpt: 107 }); // read back recovery's send
    r.effects = [];
    return r;
  };

  it("a stop Ember didn't send is reported and followed, not fought", () => {
    const r = cooking();
    r.poll({ acs: 0, tpt: 0 });
    expect(events(r.effects, "foreignControl")).toEqual([
      {
        type: "foreignControl",
        before: { acs: true, tptC: 107 },
        after: { acs: false, tptC: 0 },
      },
    ]);
    expect(r.s.intent).toEqual({ kind: "idle", by: "device" });
    r.hold({ acs: 0, tpt: 0 }, 60 * S);
    expect(sends(r.effects)).toEqual([]);
  });

  it("a retarget is followed, with a fresh sce at the same target", () => {
    const r = cooking();
    const fx = r.poll({ acs: 1, tpt: 121 });
    expect(events(fx, "foreignControl")).toHaveLength(1);
    expect(sends(fx)[0]?.payload).toMatchObject({ acs: 1, tpt: 121 });
  });

  it("a start while idle is adopted", () => {
    const r = new Rig({ intent: { kind: "idle", by: "ember" } }).online();
    r.poll({}); // read back recovery's stop
    r.poll({ acs: 1, tpt: 107 });
    expect(events(r.effects, "foreignControl")).toHaveLength(1);
    expect(r.s.intent).toMatchObject({ kind: "cook", tptC: 107, origin: "foreign" });
  });

  it("the device's own stop at sce is not foreign: acs 1 → 0, tpt kept", () => {
    const r = cooking();
    r.now = (r.s.sceSentS ?? 0) * 1000;
    r.poll({ acs: 0, tpt: 107 });
    expect(events(r.effects, "selfStopped")).toEqual([{ type: "selfStopped", tptC: 107 }]);
    expect(events(r.effects, "foreignControl")).toEqual([]);
  });

  it("the same change long before sce is foreign", () => {
    const r = cooking();
    r.poll({ acs: 0, tpt: 107 });
    expect(events(r.effects, "foreignControl")).toHaveLength(1);
  });
});

describe("timers", () => {
  it("pushes sce out to now + 24 h every hour during a cook", () => {
    const r = new Rig({ intent: { kind: "cook", tptC: 107, origin: "user" } }).online({
      acs: 1,
      tpt: 107,
    });
    r.hold({ acs: 1, tpt: 107 }, 3 * 3_600_000 + TIMING.pollMs);
    const extends_ = sends(r.effects).filter((s) => s.reason === "extend");
    expect(extends_).toHaveLength(3);
    for (const e of extends_) {
      expect(Number(e.payload.sce) - Number(e.payload.ct)).toBe(86_400);
      expect(e.payload).toMatchObject({ acs: 1, tpt: 107 });
    }
  });

  it("Fire it up: device sce at the end, then the server sends a full stop", () => {
    const r = new Rig().online();
    const [start] = sends(r.command({ kind: "fireUp", minutes: 10, thenHoldC: null }));
    expect(start?.payload).toMatchObject({ acs: 1, tpt: 260 });
    expect(Number(start?.payload.sce) - Number(start?.payload.ct)).toBe(600);
    r.hold({ acs: 1, tpt: 260 }, 10 * 60 * S);
    expect(events(r.effects, "fireUpEnded")).toEqual([{ type: "fireUpEnded", next: "stop" }]);
    expect(sends(r.effects).at(-1)?.payload).toMatchObject({ acs: 0, tpt: 0, sce: 0 });
  });

  it("Fire it up with 'then hold': sce has 2 min of grace, then it holds the target", () => {
    const r = new Rig().online();
    const [start] = sends(r.command({ kind: "fireUp", minutes: 10, thenHoldC: 107 }));
    expect(Number(start?.payload.sce) - Number(start?.payload.ct)).toBe(600 + 120);
    r.hold({ acs: 1, tpt: 260 }, 10 * 60 * S);
    expect(sends(r.effects).at(-1)?.payload).toMatchObject({ acs: 1, tpt: 107 });
    expect(r.s.intent).toEqual({ kind: "cook", tptC: 107, origin: "user" });
  });

  it("Fire it up stopped by the device first is not foreign, and the server still stops it", () => {
    const r = new Rig().online();
    r.command({ kind: "fireUp", minutes: 1, thenHoldC: null });
    r.hold({ acs: 1, tpt: 260 }, 55 * S);
    r.poll({ acs: 0, tpt: 260 });
    expect(events(r.effects, "selfStopped")).toHaveLength(1);
    expect(events(r.effects, "foreignControl")).toEqual([]);
    expect(sends(r.effects).at(-1)?.payload).toMatchObject({ acs: 0, tpt: 0 });
  });
});

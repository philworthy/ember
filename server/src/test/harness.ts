// Test harness: the device link driving the simulator in-process on a shared ManualClock.
// Ticks every 5 s of simulated time, so a 14-hour cook runs in a second or two.

import { DeviceClient } from "../device/client.ts";
import { ManualClock } from "../device/clock.ts";
import { type DeviceEvents, DeviceLink, type DeviceLinkOptions } from "../device/device.ts";
import type { Restore } from "../device/machine.ts";
import { SimDevice, type SimOptions } from "../sim/device.ts";
import { getScenario } from "../sim/scenarios.ts";
import { SimTransport } from "../sim/wire.ts";

/** 2026-10-18T00:00:00Z-ish: a plausible "now" with a set clock. */
export const T0 = 1_792_368_000_000;
export const SEC = 1000;
export const MIN = 60 * SEC;
export const HOUR = 60 * MIN;

type Logged = {
  [K in keyof DeviceEvents]: { type: K; at: number } & DeviceEvents[K][0];
}[keyof DeviceEvents];

export interface Harness {
  clock: ManualClock;
  sim: SimDevice;
  link: DeviceLink;
  events: Logged[];
  of<K extends keyof DeviceEvents>(type: K): ({ type: K; at: number } & DeviceEvents[K][0])[];
  /** Tick every 5 s until `ms` of simulated time has passed. */
  run(ms: number): Promise<void>;
  /** Tick until `pred` holds, failing after `maxMs`. */
  runUntil(pred: () => boolean, maxMs: number): Promise<void>;
  /** Start the link: tick until it is online after its startup recovery. */
  boot(): Promise<void>;
}

export function harness(
  opts: {
    scenario?: string;
    sim?: SimOptions;
    restore?: Restore;
    t0?: number;
    link?: Omit<DeviceLinkOptions, "clock" | "restore">;
  } = {},
): Harness {
  const clock = new ManualClock(opts.t0 ?? T0);
  const sim = new SimDevice(clock, { seed: 7, ...opts.sim });
  if (opts.scenario) getScenario(opts.scenario).setup(sim, clock.now());
  const client = new DeviceClient(new SimTransport(sim));
  const link = new DeviceLink(client, { ...opts.link, clock, restore: opts.restore });
  const events: Logged[] = [];
  const types: (keyof DeviceEvents)[] = [
    "reading",
    "link",
    "recovery",
    "adopted",
    "foreignControl",
    "selfStopped",
    "fireUpEnded",
    "commandApplied",
    "commandFailed",
    "dropped",
    "sent",
    "fault",
    "halted",
  ];
  for (const type of types) {
    link.on(type, (e: object) => events.push({ type, at: clock.now(), ...e } as Logged));
  }

  const h: Harness = {
    clock,
    sim,
    link,
    events,
    of: (type) => events.filter((e) => e.type === type) as never,
    async run(ms) {
      const end = clock.now() + ms;
      while (clock.now() < end) {
        clock.advance(5 * SEC);
        await link.tick();
      }
    },
    async runUntil(pred, maxMs) {
      const end = clock.now() + maxMs;
      while (!pred()) {
        if (clock.now() >= end) throw new Error(`condition not met within ${maxMs / 1000} s`);
        clock.advance(5 * SEC);
        await link.tick();
      }
    },
    async boot() {
      await link.tick();
      await h.runUntil(() => link.snapshot.link === "online", 2 * MIN);
    },
  };
  return h;
}

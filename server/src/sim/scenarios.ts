// Scripted scenarios: food on probes plus a timeline of things that happen to the device. The
// cook itself is started by whoever drives the device (Ember, a test, or `npm run sim --start`),
// using `cook` as the suggested target.

import { fToC } from "@ember/shared";
import type { SimDevice } from "./device.ts";
import type { FoodModel } from "./physics.ts";

export interface Scenario {
  name: string;
  description: string;
  /** Suggested cook: a pit target, or Fire it up for some minutes. */
  cook: { pitC: number } | { fireUpMin: number };
  /** Rough length of the interesting part, for playback and tests. */
  durationS: number;
  /** Apply to a fresh simulator. `t0` is the clock time the scenario starts (Unix ms). */
  setup: (sim: SimDevice, t0: number) => void;
}

const H = 3_600_000;

/** 14 lb packer brisket from the fridge, with a 3 h stall from about 155 °F to 165 °F. */
export const BRISKET: FoodModel = {
  startC: 4,
  weightLb: 14,
  stall: { startC: fToC(155), endC: fToC(165), durS: 3 * 3600 },
};

const PORK_BUTT: FoodModel = {
  startC: 4,
  weightLb: 8,
  stall: { startC: fToC(158), endC: fToC(166), durS: 2 * 3600 },
};

const CHICKEN: FoodModel = { startC: 4, weightLb: 4 };

const LOW_AND_SLOW = { pitC: Math.round(fToC(225)) };

/** The brisket comes off (probe out of the meat) when it reaches 203 °F. */
function brisketOnP1(sim: SimDevice): void {
  sim.insertProbe(1, BRISKET);
  sim.schedule({ when: (s) => s.probeC(1) >= fToC(203), label: "brisket off at 203 °F" }, (s) =>
    s.removeFromMeat(1),
  );
}

export const scenarios: Record<string, Scenario> = {
  brisket: {
    name: "brisket",
    description: "14 lb brisket at 225 °F; stalls ~155–165 °F for 3 h; pulled at 203 °F",
    cook: LOW_AND_SLOW,
    durationS: 14 * 3600,
    setup: (sim) => brisketOnP1(sim),
  },
  pizza: {
    name: "pizza",
    description: "No food probes; pit to 700 °F",
    cook: { pitC: Math.round(fToC(700)) },
    durationS: 3600,
    setup: () => {},
  },
  probeUnplugged: {
    name: "probeUnplugged",
    description: "Brisket on P1 and a pork butt on P2; P2 is unplugged at 2 h",
    cook: LOW_AND_SLOW,
    durationS: 4 * 3600,
    setup: (sim, t0) => {
      brisketOnP1(sim);
      sim.insertProbe(2, PORK_BUTT);
      sim.schedule({ atMs: t0 + 2 * H, label: "P2 unplugged" }, (s) => s.unplugProbe(2));
    },
  },
  meatRemoved: {
    name: "meatRemoved",
    description: "Whole chicken on P1 at 350 °F; taken off at 165 °F, probe still in",
    cook: { pitC: Math.round(fToC(350)) },
    durationS: 3 * 3600,
    setup: (sim) => {
      sim.insertProbe(1, CHICKEN);
      sim.schedule({ when: (s) => s.probeC(1) >= fToC(165), label: "chicken off at 165 °F" }, (s) =>
        s.removeFromMeat(1),
      );
    },
  },
  rebootMidCook: {
    name: "rebootMidCook",
    description: "Brisket; the controller loses power for 60 s at 3 h",
    cook: LOW_AND_SLOW,
    durationS: 4 * 3600,
    setup: (sim, t0) => {
      brisketOnP1(sim);
      sim.schedule({ atMs: t0 + 3 * H, label: "power cut 60 s" }, (s) => s.powerCycle(60));
    },
  },
  longOutage: {
    name: "longOutage",
    description: "Brisket; the controller is off for 25 min at 3 h",
    cook: LOW_AND_SLOW,
    durationS: 4 * 3600,
    setup: (sim, t0) => {
      brisketOnP1(sim);
      sim.schedule({ atMs: t0 + 3 * H, label: "power off 25 min" }, (s) => s.powerCycle(25 * 60));
    },
  },
  flaky: {
    name: "flaky",
    description:
      "Brisket; ~1.5 % of requests fail in streaks of up to 3; web server down 2½ min at 2 h",
    cook: LOW_AND_SLOW,
    durationS: 4 * 3600,
    setup: (sim, t0) => {
      brisketOnP1(sim);
      sim.setFaults({ rate: 0.015, streakMax: 3 });
      sim.schedule({ atMs: t0 + 2 * H, label: "web server down 150 s" }, (s) => s.webOutage(150));
    },
  },
  foreignClient: {
    name: "foreignClient",
    description: "Brisket; at 1 h another client stops the cook, then restarts it 15 s later",
    cook: LOW_AND_SLOW,
    durationS: 2 * 3600,
    setup: (sim, t0) => {
      brisketOnP1(sim);
      const now = () => Math.floor(sim.clock.now() / 1000);
      sim.schedule({ atMs: t0 + H, label: "foreign stop" }, (s) =>
        s.foreignCommand({ acs: 0, csid: "", tpt: 0, sce: 0, p: 0, tft: 0, as: 0, ct: now() }),
      );
      sim.schedule({ atMs: t0 + H + 15_000, label: "foreign restart" }, (s) =>
        s.foreignCommand({
          acs: 1,
          csid: "",
          tpt: LOW_AND_SLOW.pitC,
          sce: now() + 86_400,
          p: 0,
          tft: 0,
          as: 0,
          ct: now(),
        }),
      );
    },
  },
  fireUp: {
    name: "fireUp",
    description: "Cold grill, no probes; Fire it up for 10 min",
    cook: { fireUpMin: 10 },
    durationS: 20 * 60,
    setup: () => {},
  },
};

export type ScenarioName = keyof typeof scenarios;

export function getScenario(name: string): Scenario {
  const s = scenarios[name];
  if (!s) throw new Error(`unknown scenario "${name}"; try: ${Object.keys(scenarios).join(", ")}`);
  return s;
}

// Every cook threshold in one place (docs/brief.md › Behaviour), plus the server's environment.
// Thresholds are written in °F, as the brief states them, and converted to °C once here.
// Device timing (offline, recovery, sce) lives with the state machine in device/machine.ts.

import path from "node:path";
import { type AlertPrefs, fDeltaToC, fToC, fToDeviceC } from "@ember/shared";

const SEC = 1000;
const MIN = 60 * SEC;

export const COOK = {
  /** An item ends when its probe reads null for this long (re-detect can take ~45 s, M1). */
  unpluggedAfterMs: 30 * SEC,
  /** Removed from the meat: a drop of `dropC` within `windowMs`, once it has passed `armAboveC`. */
  cameOff: { armAboveC: fToC(140), dropC: fDeltaToC(15), windowMs: 2 * MIN },
  looksDone: {
    /** The pit counts as falling when it dropped this much over this long, without rising. */
    pitFallingMs: 15 * MIN,
    pitFallingMinDropC: fDeltaToC(10),
    /** Any rise above the window's first reading beyond this means it isn't falling. */
    pitRiseToleranceC: fDeltaToC(3),
    /** No response to the prompt: end the cook this long after it went up. */
    autoEndAfterMs: 60 * MIN,
  },
  /** Pit within this of the target is "Holding"; below is "Heating", above "Cooling". */
  holdingBandC: fDeltaToC(10),
  stall: {
    minTempC: fToC(140),
    /** Rising slower than this (or falling) counts as stalled. */
    maxRateCPerH: fDeltaToC(5),
    /** The rate is measured across a centred window this wide. */
    slopeWindowMs: 30 * MIN,
    minDurationMs: 45 * MIN,
  },
  estimate: {
    /** v1: rate of rise over this window... */
    windowMs: 25 * MIN,
    /** ...which must hold at least this much data... */
    minSpanMs: 20 * MIN,
    /** ...and rise faster than this, or it shows "Stalled". */
    flatBelowCPerH: fDeltaToC(5),
  },
  limits: {
    pitC: { min: fToDeviceC(150), max: fToDeviceC(700) },
    probeC: { min: fToC(100), max: fToC(220) },
    fireUpMin: { min: 1, max: 60 },
    weightLb: { min: 0, max: 100 },
  },
  /** Pit target used by Start when nothing has been chosen yet (225 °F). */
  defaultPitC: fToDeviceC(225),
};

/** History (docs/brief.md › History editing). */
export const HISTORY = {
  /** Adjust start & end can widen a cook by up to this much, over readings that exist. */
  boundsMarginMs: 3 * 60 * MIN,
  /** The shortest a trimmed cook can be. */
  minWindowMs: 15 * MIN,
  /** Points per series in a History card's small graph. */
  sparkPoints: 80,
};

/** Alert defaults (docs/brief.md › Alerts) and the limits Settings may set them to. */
export const ALERTS = {
  defaults: {
    itemAtTarget: true,
    itemCameOff: true,
    pitOffTarget: { on: true, bandC: fDeltaToC(25), forMin: 10 },
    deviceOffline: { on: true, forMin: 2 },
    fireUpFinished: true,
    looksDone: true,
  } satisfies AlertPrefs,
  limits: {
    bandC: { min: fDeltaToC(10), max: fDeltaToC(100) },
    forMin: { min: 1, max: 60 },
  },
  /** How long a push waits at the push service for a phone that's off (then it's dropped). */
  ttlS: 3600,
  /** Settings' test notification gives up after this long. */
  testTimeoutMs: 10_000,
};

export interface Env {
  port: number;
  dataDir: string;
  useSimulator: boolean;
  simSpeed: number;
  simScenario: string | null;
  ikamandHost: string | null;
  /** VAPID keys from the environment; otherwise they're generated into DATA_DIR/vapid.json. */
  vapid: { publicKey: string; privateKey: string } | null;
  vapidSubject: string;
}

/** `root` resolves a relative DATA_DIR (the repo root in dev; DATA_DIR=/data in Docker). */
export function loadEnv(env: NodeJS.ProcessEnv, root: string): Env {
  const useSimulator = env.USE_SIMULATOR === "true" || env.USE_SIMULATOR === "1";
  const host = env.IKAMAND_HOST?.trim() || null;
  if (!useSimulator && !host) {
    throw new Error("IKAMAND_HOST is not set (or set USE_SIMULATOR=true for the simulator)");
  }
  const simSpeed = Number(env.SIM_SPEED ?? 1);
  if (!(simSpeed > 0)) throw new Error("SIM_SPEED must be a number > 0");
  return {
    // EMBER_PORT, not PORT: dev tooling (e.g. preview harnesses) exports PORT for the front-end.
    port: Number(env.EMBER_PORT ?? 8080),
    dataDir: path.resolve(root, env.DATA_DIR ?? "./data"),
    useSimulator,
    simSpeed,
    simScenario: env.SIM_SCENARIO?.trim() || null,
    ikamandHost: host,
    vapid:
      env.VAPID_PUBLIC_KEY?.trim() && env.VAPID_PRIVATE_KEY?.trim()
        ? { publicKey: env.VAPID_PUBLIC_KEY.trim(), privateKey: env.VAPID_PRIVATE_KEY.trim() }
        : null,
    // Apple rejects a mailto: at localhost; a real URL keeps a personal address out of it.
    vapidSubject: env.VAPID_SUBJECT?.trim() || "https://github.com/philworthy/ember",
  };
}

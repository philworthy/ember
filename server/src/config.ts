// Every cook threshold in one place (docs/brief.md › Behaviour), plus the server's environment.
// Thresholds are written in °F, as the brief states them, and converted to °C once here.
// Device timing (offline, recovery, sce) lives with the state machine in device/machine.ts.

import path from "node:path";
import { fDeltaToC, fToC, fToDeviceC } from "@ember/shared";

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

export interface Env {
  port: number;
  dataDir: string;
  useSimulator: boolean;
  simSpeed: number;
  simScenario: string | null;
  ikamandHost: string | null;
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
  };
}

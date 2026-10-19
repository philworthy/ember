// The two alert rules that need time to pass rather than a cook event (docs/brief.md › Alerts):
// the pit drifting off target, and the grill offline during a session. Pure and clock-free: the
// alert service feeds them the live state once a tick.

import { COOK } from "../config.ts";

export interface PitDriftInput {
  now: number;
  /** A fresh pit reading, or null (no probe, or the link isn't online). */
  pitC: number | null;
  /** The target being held; null while not holding (idle, Fire it up). */
  holdC: number | null;
  /** No session, or Looks done is up. */
  quiet: boolean;
}

export interface PitDriftAlert {
  pitC: number;
  targetC: number;
  sinceMs: number;
}

/**
 * Pit off target by more than `bandC` for `forMin`, once the pit has first reached the target.
 * Arming needs the pit inside the holding band of the current target, so raising the target (or
 * Fire it up handing over to a hold) never alerts while the pit climbs. One alert per excursion:
 * it re-arms once the pit is back inside the holding band.
 */
export class PitDrift {
  private targetC: number | null = null;
  private armed = false;
  private outSince: number | null = null;
  private fired = false;

  update(i: PitDriftInput, prefs: { bandC: number; forMin: number }): PitDriftAlert | null {
    if (i.holdC === null || i.quiet) {
      this.reset(null);
      return null;
    }
    if (i.holdC !== this.targetC) this.reset(i.holdC);
    if (i.pitC === null) return null;
    const off = Math.abs(i.pitC - i.holdC);
    if (!this.armed) {
      this.armed = off <= COOK.holdingBandC;
      return null;
    }
    if (off <= COOK.holdingBandC) this.fired = false;
    if (off <= prefs.bandC) {
      this.outSince = null;
      return null;
    }
    this.outSince ??= i.now;
    if (this.fired || i.now - this.outSince < prefs.forMin * 60_000) return null;
    this.fired = true;
    return { pitC: i.pitC, targetC: i.holdC, sinceMs: this.outSince };
  }

  private reset(targetC: number | null): void {
    this.targetC = targetC;
    this.armed = false;
    this.outSince = null;
    this.fired = false;
  }
}

export interface OfflineInput {
  now: number;
  sessionOpen: boolean;
  /** The link has given up waiting for answers (30 s without one). */
  offline: boolean;
  /** Back to normal readings (not just reconnecting). */
  online: boolean;
  lastSeenMs: number | null;
}

/**
 * The grill offline for `forMin` during a session, counted from its last good reading. Once per
 * outage: it resets when the link is online again.
 */
export class OfflineWatch {
  private fired = false;

  update(i: OfflineInput, prefs: { forMin: number }): { lastSeenMs: number } | null {
    if (i.online) this.fired = false;
    if (this.fired || !i.offline || !i.sessionOpen || i.lastSeenMs === null) return null;
    if (i.now - i.lastSeenMs < prefs.forMin * 60_000) return null;
    this.fired = true;
    return { lastSeenMs: i.lastSeenMs };
  }
}

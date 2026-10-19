// Reading sanity (protocol.md › Quirks 2). Pure.

import type { DecodedData } from "./protocol.ts";

/** A reading whose temperature jumps more than this... */
export const MAX_JUMP_C = 50;
/** ...within this long of the previous one is dropped. */
export const JUMP_WINDOW_MS = 10_000;

export interface TempSnapshot {
  atMs: number;
  temps: (number | null)[];
}

export function snapshot(d: DecodedData, atMs: number): TempSnapshot {
  return { atMs, temps: [d.pitC, d.t1C, d.t2C, d.t3C] };
}

/** True when any channel moved more than MAX_JUMP_C since a snapshot under 10 s old. */
export function isJump(prev: TempSnapshot | null, next: TempSnapshot): boolean {
  if (!prev || next.atMs - prev.atMs > JUMP_WINDOW_MS) return false;
  return next.temps.some((t, i) => {
    const p = prev.temps[i];
    return t !== null && p !== null && p !== undefined && Math.abs(t - p) > MAX_JUMP_C;
  });
}

export type Verdict = { ok: true } | { ok: false; reason: "clock-unset" | "jump" };

/**
 * Should this reading be kept? Drops readings while the clock is unset (the device just rebooted
 * and its temperatures are garbage for ~30 s) and readings that jump more than 50 °C within 10 s
 * (a command's `ct` can set the clock inside that garbage window).
 */
export function checkReading(d: DecodedData, atMs: number, prev: TempSnapshot | null): Verdict {
  if (!d.valid) return { ok: false, reason: "clock-unset" };
  if (isJump(prev, snapshot(d, atMs))) return { ok: false, reason: "jump" };
  return { ok: true };
}

// Display formatting. Temperatures arrive in °C and show in °F, through shared/src/units.ts only.

import { cToDisplayF } from "@ember/shared";

/** °C → "250" (whole °F), or "—" when there's no reading. */
export function f(c: number | null | undefined): string {
  return c === null || c === undefined ? "—" : String(cToDisplayF(c));
}

/** °C → "250°". */
export function deg(c: number | null | undefined): string {
  return c === null || c === undefined ? "—" : `${cToDisplayF(c)}°`;
}

const MIN = 60_000;
const HOUR = 60 * MIN;

export { duration } from "@ember/shared";

/** "4:05" (rounded up, so it reads 0:00 only at the end). */
export function countdown(ms: number): string {
  const s = Math.max(0, Math.ceil(ms / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

/** "just now", "2 min ago", "3 h ago". */
export function ago(ms: number): string {
  if (ms < MIN) return "just now";
  if (ms < HOUR) return `${Math.floor(ms / MIN)} min ago`;
  if (ms < 48 * HOUR) return `${Math.floor(ms / HOUR)} h ago`;
  return `${Math.floor(ms / (24 * HOUR))} days ago`;
}

/** Pit presets from the brief, in °F. */
export const PIT_PRESETS: [string, number][] = [
  ["Low & slow", 225],
  ["Smoke", 250],
  ["Hot & fast", 300],
  ["Roast", 350],
  ["Sear", 500],
  ["Pizza", 700],
];

export function presetName(fahrenheit: number): string | null {
  return PIT_PRESETS.find(([, t]) => t === fahrenheit)?.[0] ?? null;
}

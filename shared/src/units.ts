// The device speaks °C integers; the UI shows °F. All conversion happens here (CLAUDE.md rule).

export function cToF(c: number): number {
  return (c * 9) / 5 + 32;
}

export function fToC(f: number): number {
  return ((f - 32) * 5) / 9;
}

/** °F → integer °C for the wire (the device only takes whole degrees C). */
export function fToDeviceC(f: number): number {
  return Math.round(fToC(f));
}

/** Raw device °C → whole °F for display. */
export function cToDisplayF(c: number): number {
  return Math.round(cToF(c));
}

/** A temperature difference in °F → °C (no 32 offset), e.g. "a 15 °F drop". */
export function fDeltaToC(f: number): number {
  return (f * 5) / 9;
}

/** A temperature difference in °C → °F. */
export function cDeltaToF(c: number): number {
  return (c * 9) / 5;
}

export type ProbeSlot = 1 | 2 | 3;

/**
 * One stored reading. Raw device values in °C; null means no probe / invalid
 * (the device's 400 / -400 sentinels, mapped before storage).
 */
export interface Reading {
  /** Server receive time, Unix ms. */
  ts: number;
  pitC: number | null;
  t1C: number | null;
  t2C: number | null;
  t3C: number | null;
  fanPct: number;
  cookActive: boolean;
  targetPitC: number;
  /** Unparsed fields (rm, cm, as, ag, ...) kept verbatim for later study. */
  raw: Record<string, string>;
}

/**
 * The server's link to the device. `recovering` is a reconnect (server start, back from offline,
 * or a reboot) waiting for ~30 s of sane readings before it reconciles the cook.
 */
export type DeviceLinkState = "starting" | "online" | "recovering" | "offline";

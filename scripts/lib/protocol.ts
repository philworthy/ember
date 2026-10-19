// iKamand wire format, as described in docs/protocol.md. Pure functions only.

export type Payload = Record<string, string | number>;

/** Fields we decode by name. Anything else in a `data` response ends up in `other`. */
const KNOWN_DATA_FIELDS = [
  "time",
  "acs",
  "tpt",
  "pt",
  "t1",
  "t2",
  "t3",
  "dc",
  "sce",
  "csid",
  "p",
  "tft",
  "ag",
  "rm",
  "cm",
  "as",
] as const;

const SENTINELS = new Set(["400", "-400"]);

/**
 * Until its clock is set, the device reports seconds since boot (seen: 197, then 259 a minute
 * later), so any `time` before 2020-09-13 means the clock is unset and the reading is dropped.
 */
export const MIN_VALID_DEVICE_TIME = 1_600_000_000;

/** Responses are URL-encoded query strings. Every value is a string; first value wins. */
export function parseQs(raw: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of new URLSearchParams(raw.trim())) {
    if (!(k in out)) out[k] = v;
  }
  return out;
}

export function encodeForm(payload: Payload): string {
  return new URLSearchParams(Object.entries(payload).map(([k, v]) => [k, String(v)])).toString();
}

function int(v: string | undefined): number | null {
  if (v === undefined || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

/** Temperature field → °C, or null for missing / sentinel (no probe). */
function temp(v: string | undefined): number | null {
  if (v === undefined || SENTINELS.has(v)) return null;
  return int(v);
}

export interface DecodedData {
  /** False when the device clock is unset (just rebooted); the reading must be dropped. */
  valid: boolean;
  deviceTime: number | null;
  cookActive: boolean;
  targetPitC: number | null;
  pitC: number | null;
  t1C: number | null;
  t2C: number | null;
  t3C: number | null;
  fanPct: number | null;
  sce: number | null;
  csid: string | undefined;
  p: number | null;
  tftC: number | null;
  ag: string | undefined;
  rm: string | undefined;
  cm: string | undefined;
  as: string | undefined;
  /** Fields not in the known list, verbatim. */
  other: Record<string, string>;
  fields: Record<string, string>;
}

export function decodeData(fields: Record<string, string>): DecodedData {
  const deviceTime = int(fields.time);
  const other: Record<string, string> = {};
  for (const [k, v] of Object.entries(fields)) {
    if (!(KNOWN_DATA_FIELDS as readonly string[]).includes(k)) other[k] = v;
  }
  return {
    valid: deviceTime !== null && deviceTime >= MIN_VALID_DEVICE_TIME,
    deviceTime,
    cookActive: fields.acs === "1",
    targetPitC: int(fields.tpt),
    pitC: temp(fields.pt),
    t1C: temp(fields.t1),
    t2C: temp(fields.t2),
    t3C: temp(fields.t3),
    fanPct: int(fields.dc),
    sce: int(fields.sce),
    csid: fields.csid,
    p: int(fields.p),
    tftC: temp(fields.tft),
    ag: fields.ag,
    rm: fields.rm,
    cm: fields.cm,
    as: fields.as,
    other,
    fields,
  };
}

// ---- Commands (POST cook). `now` is Unix seconds. ----

/** The device stops itself at `sce`; never schedule more than this far ahead (protocol.md › Safety). */
export const MAX_SCE_AHEAD_S = 86_400;

/**
 * Start or retarget a cook. Ember always sends `p=0 tft=0`; `foodProbe` exists only so the CLI
 * can test the device's own food-probe target (UNVERIFIED in protocol.md).
 */
export function startCook(
  tptC: number,
  now: number,
  foodProbe?: { slot: 1 | 2 | 3; tftC: number },
): Payload {
  return {
    acs: 1,
    csid: "",
    tpt: Math.round(tptC),
    sce: now + MAX_SCE_AHEAD_S,
    p: foodProbe?.slot ?? 0,
    tft: foodProbe ? Math.round(foodProbe.tftC) : 0,
    as: 0,
    ct: now,
  };
}

export function stopCook(now: number): Payload {
  return { acs: 0, csid: "", tpt: 0, sce: 0, p: 0, tft: 0, as: 0, ct: now };
}

/** Fire it up, method A: native grill mode. Partial payload, as the original library sends it. */
export function grillStartA(minutes: number, now: number): Payload {
  return { ag: 1, sge: now + Math.round(minutes * 60), ct: now };
}

export function grillStopA(now: number): Payload {
  return { ag: 0, sge: 0, ct: now };
}

/** Fire it up, method B: a cook at 260 °C that the device ends at `sce` (and the caller also stops). */
export const GRILL_B_TPT_C = 260;

export function grillStartB(minutes: number, now: number): Payload {
  return { ...startCook(GRILL_B_TPT_C, now), sce: now + Math.round(minutes * 60) };
}

export function grillStop(method: "a" | "b", now: number): Payload {
  return method === "a" ? grillStopA(now) : stopCook(now);
}

/** Parse `k=v` CLI args into a payload, adding `ct=now` unless given. Order is preserved. */
export function parseRawPairs(pairs: string[], now: number): Payload {
  const payload: Payload = {};
  for (const pair of pairs) {
    const eq = pair.indexOf("=");
    if (eq <= 0) throw new Error(`expected k=v, got "${pair}"`);
    payload[pair.slice(0, eq)] = pair.slice(eq + 1);
  }
  if (!("ct" in payload)) payload.ct = now;
  return payload;
}

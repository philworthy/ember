import type { DecodedData, Payload } from "@ember/server/device";
import { cToDisplayF } from "@ember/shared";

export function fmtTemp(c: number | null): string {
  return c === null ? "—" : `${cToDisplayF(c)}°F (${c}°C)`;
}

export function fmtDuration(seconds: number): string {
  const sign = seconds < 0 ? "-" : "+";
  let s = Math.abs(Math.round(seconds));
  const h = Math.floor(s / 3600);
  s -= h * 3600;
  const m = Math.floor(s / 60);
  s -= m * 60;
  if (h) return `${sign}${h}h ${String(m).padStart(2, "0")}m`;
  if (m) return `${sign}${m}m ${String(s).padStart(2, "0")}s`;
  return `${sign}${s}s`;
}

function fmtEpoch(v: number | null, now: number): string {
  if (v === null) return "—";
  if (v === 0) return "0";
  return `${v}  (${fmtDuration(v - now)} from now)`;
}

function probe(c: number | null, raw: string | undefined): string {
  return c === null ? `—  (raw ${raw ?? "missing"}: no probe)` : fmtTemp(c);
}

export function describeData(d: DecodedData, now: number): string {
  const skew = d.deviceTime === null ? "" : `  (clock skew ${fmtDuration(d.deviceTime - now)})`;
  const rows: [string, string][] = [
    ["valid", d.valid ? "yes" : "NO: device clock unset (just rebooted)"],
    ["device time", `${d.deviceTime ?? "—"}${skew}`],
    ["cook active", `acs=${d.fields.acs ?? "—"}`],
    ["pit", probe(d.pitC, d.fields.pt)],
    ["target pit", d.targetPitC === 0 ? "none (tpt=0)" : fmtTemp(d.targetPitC)],
    ["probe 1", probe(d.t1C, d.fields.t1)],
    ["probe 2", probe(d.t2C, d.fields.t2)],
    ["probe 3", probe(d.t3C, d.fields.t3)],
    ["fan", d.fanPct === null ? "—" : `${d.fanPct}%`],
    ["sce", fmtEpoch(d.sce, now)],
    ["p / tft", `${d.fields.p ?? "—"} / ${d.fields.tft ?? "—"}`],
    ["csid", JSON.stringify(d.csid ?? null)],
    ["ag", d.ag ?? "—"],
    ["rm / cm / as", `${d.rm ?? "—"} / ${d.cm ?? "—"} / ${d.as ?? "—"}`],
  ];
  if (Object.keys(d.other).length) rows.push(["other", JSON.stringify(d.other)]);
  return rows.map(([k, v]) => `  ${k.padEnd(13)} ${v}`).join("\n");
}

/** One-line live status for `watch` and `grill`. */
export function statusLine(d: DecodedData): string {
  const t = (c: number | null) => (c === null ? "—" : `${cToDisplayF(c)}°`);
  return [
    `pit ${t(d.pitC)}`,
    `tgt ${d.targetPitC === 0 ? "—" : t(d.targetPitC)}`,
    `fan ${d.fanPct ?? "—"}%`,
    `t1 ${t(d.t1C)} t2 ${t(d.t2C)} t3 ${t(d.t3C)}`,
    `acs=${d.fields.acs ?? "—"} ag=${d.ag ?? "—"}`,
    d.valid ? "" : "[clock unset]",
  ]
    .filter(Boolean)
    .join("  ");
}

const TIME_KEYS = new Set(["sce", "sge", "ct"]);

/** Annotate a payload for the confirmation prompt, e.g. `tpt=121 (250°F)`. */
export function describePayload(payload: Payload, now: number): string {
  return Object.entries(payload)
    .map(([k, v]) => {
      const n = Number(v);
      let note = "";
      if (k === "tpt" && n > 0) note = `${cToDisplayF(n)}°F`;
      else if (k === "tft" && n > 0) note = `${cToDisplayF(n)}°F`;
      else if (TIME_KEYS.has(k) && n > 0) note = k === "ct" ? "now" : `now ${fmtDuration(n - now)}`;
      else if (k === "acs") note = n === 1 ? "start cook" : "stop cook";
      else if (k === "ag") note = n === 1 ? "grill mode on" : "grill mode off";
      return `  ${k}=${v === "" ? '""' : v}${note ? `  (${note})` : ""}`;
    })
    .join("\n");
}

export const CSV_COLUMNS = [
  "iso",
  "server_unix",
  "device_time",
  "skew_s",
  "valid",
  "acs",
  "tpt_c",
  "pt_c",
  "t1_c",
  "t2_c",
  "t3_c",
  "dc",
  "sce",
  "p",
  "tft",
  "ag",
  "rm",
  "cm",
  "as",
  "other",
  "error",
  "raw",
] as const;

function csvCell(v: string | number | null | undefined): string {
  if (v === null || v === undefined) return "";
  const s = String(v);
  return /[",\n]/.test(s) ? `"${s.replaceAll('"', '""')}"` : s;
}

export function csvRow(
  now: number,
  d: DecodedData | null,
  raw: string | null,
  error: string | null,
): string {
  const f = d?.fields ?? {};
  const row: Record<(typeof CSV_COLUMNS)[number], string | number | null | undefined> = {
    iso: new Date(now * 1000).toISOString(),
    server_unix: now,
    device_time: d?.deviceTime,
    skew_s: d?.deviceTime == null ? null : d.deviceTime - now,
    valid: d ? (d.valid ? 1 : 0) : null,
    acs: f.acs,
    // Sentinels already mapped to empty; the raw column keeps the original value.
    tpt_c: d?.targetPitC,
    pt_c: d?.pitC,
    t1_c: d?.t1C,
    t2_c: d?.t2C,
    t3_c: d?.t3C,
    dc: d?.fanPct,
    sce: d?.sce,
    p: f.p,
    tft: f.tft,
    ag: d?.ag,
    rm: d?.rm,
    cm: d?.cm,
    as: d?.as,
    other: d && Object.keys(d.other).length ? JSON.stringify(d.other) : null,
    error,
    raw: raw?.trim(),
  };
  return CSV_COLUMNS.map((c) => csvCell(row[c])).join(",");
}

/** Fields whose value changed between two `data` snapshots. */
export function diffFields(
  before: Record<string, string>,
  after: Record<string, string>,
): string[] {
  const keys = [...new Set([...Object.keys(before), ...Object.keys(after)])];
  return keys
    .filter((k) => k !== "time" && before[k] !== after[k])
    .map((k) => `  ${k}: ${before[k] ?? "(absent)"} → ${after[k] ?? "(absent)"}`);
}

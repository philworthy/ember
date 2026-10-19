// Text formatting the server (push notifications) and the client share.

const MIN = 60_000;

/** "6h 40m", "45m", "<1m". */
export function duration(ms: number): string {
  const totalMin = Math.floor(Math.max(0, ms) / MIN);
  if (totalMin < 1) return "<1m";
  const h = Math.floor(totalMin / 60);
  const m = totalMin - h * 60;
  if (!h) return `${m}m`;
  return `${h}h ${String(m).padStart(2, "0")}m`;
}

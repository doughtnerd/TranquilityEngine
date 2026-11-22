// The replay slot's words (ADR 0334): take time as a clock, "m:ss.s" (one decimal: the slot is small, the Take screen's
// ruler has the detail). Pure.

/** Seconds as "m:ss.s" (negative reads as 0). */
export function formatClock(t: number): string {
  const s = Math.max(0, Number.isFinite(t) ? t : 0);
  let m = Math.floor(s / 60);
  let rest = Math.round((s - m * 60) * 10) / 10;
  if (rest >= 60) {
    m++;
    rest -= 60;
  }
  return `${m}:${rest < 10 ? "0" : ""}${rest.toFixed(1)}`;
}

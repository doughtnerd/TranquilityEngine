// A position as a clock (spec §3.14: positions as timecode, two-digit minutes and milliseconds): the replay and game
// session clocks, the status bar's playhead and session time, the Take screen's transport. Pure.

/** Seconds as "mm:ss.mmm" ("00:20.480", "61:05.250"); negative or not a number reads as 0. */
export function formatClock(t: number): string {
  const ms = Math.round(Math.max(0, Number.isFinite(t) ? t : 0) * 1000);
  const m = Math.floor(ms / 60000);
  const s = Math.floor((ms % 60000) / 1000);
  return `${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}.${String(ms % 1000).padStart(3, "0")}`;
}

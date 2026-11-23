// The Take and Profiler rulers' marks (the prototype's playhead ruler: second labels "0, 4 s, 8 s … 32 s" spread over
// the whole recording, and a strip of small ticks between them). Pure.

/** Label steps the ruler picks from, seconds. */
const STEPS = [0.5, 1, 2, 4, 5, 10, 15, 20, 30, 60, 120, 300, 600];

/** A label's text: "0", "4 s", "1:30" past a minute. */
export function secondsLabel(t: number): string {
  if (t === 0) return "0";
  if (t < 60) return `${Number.isInteger(t) ? t : t.toFixed(1)} s`;
  const whole = Math.round(t);
  return `${Math.floor(whole / 60)}:${String(whole % 60).padStart(2, "0")}`;
}

export interface RulerMarks {
  /** Labelled times, from 0. */
  readonly labels: readonly { readonly t: number; readonly text: string }[];
  /** The minor tick spacing, seconds (four to a label step). */
  readonly tick: number;
}

/** The labels for `duration` seconds over `width` px: about one per 80 px, on a round step. */
export function rulerMarks(duration: number, width: number): RulerMarks {
  const d = Math.max(0.001, duration);
  const want = Math.max(2, Math.floor(Math.max(1, width) / 80));
  const step = STEPS.find((s) => d / s <= want) ?? STEPS[STEPS.length - 1]!;
  const labels: { t: number; text: string }[] = [];
  for (let t = 0; t <= d + 1e-9; t += step) labels.push({ t: Math.round(t * 1000) / 1000, text: secondsLabel(Math.round(t * 1000) / 1000) });
  return { labels, tick: step / 4 };
}

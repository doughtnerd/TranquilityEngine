// The Take and Profiler rulers' marks (the prototype's playhead ruler: second labels "0, 4 s, 8 s … 32 s" spread over
// the whole recording, and a strip of small ticks between them). Pure.

/** Label steps the ruler picks from, seconds. */
const STEPS = [0.5, 1, 2, 4, 5, 10, 15, 20, 30, 60, 120, 300, 600];

/** Steps under half a second, for a zoomed view (a view under a second). */
const FINE_STEPS = [0.01, 0.02, 0.05, 0.1, 0.2];

/** A label's text: "0", "4 s", "1:30" past a minute. */
export function secondsLabel(t: number): string {
  if (t === 0) return "0";
  const decimals = Number.isInteger(t) ? 0 : Math.abs(t * 10 - Math.round(t * 10)) < 1e-6 ? 1 : 2;
  if (t < 60) return `${t.toFixed(decimals)} s`;
  if (decimals === 0) {
    const whole = Math.round(t);
    return `${Math.floor(whole / 60)}:${String(whole % 60).padStart(2, "0")}`;
  }
  const m = Math.floor(t / 60);
  return `${m}:${(t - m * 60).toFixed(decimals).padStart(decimals + 3, "0")}`;
}

export interface RulerMarks {
  /** Labelled times, from 0. */
  readonly labels: readonly { readonly t: number; readonly text: string }[];
  /** The minor tick spacing, seconds (four to a label step). */
  readonly tick: number;
}

/**
 * The labels for `span` seconds shown from `start` over `width` px: about one per 80 px, on a round step, at multiples of
 * the step (the whole recording from 0 by default; a zoomed timeline passes the view's start and span).
 */
export function rulerMarks(span: number, width: number, start = 0): RulerMarks {
  const d = Math.max(0.001, span);
  const want = Math.max(2, Math.floor(Math.max(1, width) / 80));
  const steps = d < 1 ? [...FINE_STEPS, ...STEPS] : STEPS;
  const step = steps.find((s) => d / s <= want) ?? steps[steps.length - 1]!;
  const labels: { t: number; text: string }[] = [];
  for (let t = Math.max(0, Math.ceil(start / step - 1e-9) * step); t <= start + d + 1e-9; t += step) labels.push({ t: Math.round(t * 1000) / 1000, text: secondsLabel(Math.round(t * 1000) / 1000) });
  return { labels, tick: step / 4 };
}

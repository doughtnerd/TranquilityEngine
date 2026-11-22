// The playhead's model (ADR 0335 `Playhead`): where an audition is, in source seconds, from the audio clock. A run
// starts at clock time `startedAt` from source time `from`, plays forward to `to` and, with a loop, cycles
// `[loop.start, loop.end)` for `loop.count` passes (0: endless) before running on to `to`. A pre-roll is silent clock
// time before `from`. Pure: no DOM, no audio.

export interface PlayRun {
  /** Audio-clock seconds when the run started (pre-roll included). */
  readonly startedAt: number;
  /** Source seconds it plays from. */
  readonly from: number;
  /** Source seconds it stops at. */
  readonly to: number;
  /** Silent seconds before `from` (a count-in). */
  readonly preRoll?: number;
  readonly loop?: { readonly start: number; readonly end: number; readonly count: number } | null;
}

export interface PlayheadState {
  /** Source seconds (during the pre-roll: `from`). */
  readonly t: number;
  /** The run reached `to`. */
  readonly done: boolean;
  /** In the pre-roll. */
  readonly counting: boolean;
  /** The loop pass it is in (0 before the loop or without one). */
  readonly pass: number;
}

/** Where `run` is at clock time `now`. */
export function playheadAt(run: PlayRun, now: number): PlayheadState {
  const elapsed = now - run.startedAt - (run.preRoll ?? 0);
  if (elapsed < 0) return { t: run.from, done: false, counting: true, pass: 0 };
  const loop = run.loop;
  const len = loop ? loop.end - loop.start : 0;
  if (!loop || len <= 0 || run.from >= loop.end) {
    const t = run.from + elapsed;
    return t >= run.to ? { t: run.to, done: true, counting: false, pass: 0 } : { t, done: false, counting: false, pass: 0 };
  }
  // Reach the loop's end once, then cycle.
  const toLoopEnd = loop.end - run.from;
  if (elapsed < toLoopEnd) return { t: run.from + elapsed, done: false, counting: false, pass: run.from >= loop.start ? 1 : 0 };
  const after = elapsed - toLoopEnd;
  const passes = Math.floor(after / len); // whole extra passes done
  if (loop.count === 0 || passes + 1 < loop.count) return { t: loop.start + (after - passes * len), done: false, counting: false, pass: passes + 2 };
  // The last pass ended at the loop's end: on to `to`.
  const t = loop.end + (after - (loop.count - 1) * len);
  return t >= run.to ? { t: run.to, done: true, counting: false, pass: loop.count } : { t, done: false, counting: false, pass: loop.count };
}

/** How long a run lasts on the clock (Infinity with an endless loop). */
export function runSeconds(run: PlayRun): number {
  const pre = run.preRoll ?? 0;
  const loop = run.loop;
  if (!loop || loop.end <= loop.start || run.from >= loop.end) return pre + Math.max(0, run.to - run.from);
  if (loop.count === 0) return Infinity;
  return pre + (loop.end - run.from) + (loop.count - 1) * (loop.end - loop.start) + Math.max(0, run.to - loop.end);
}

// A strip of pictures on a time axis (ADR 0334's picture lane; the Take screen and the Profiler's Picture track): which
// thumbnails to draw so none overlap, and the picture on screen at a time. Pure.

/** The pictures to draw on a lane: by time, each at least `gap` pixels after the last drawn, so thumbnails don't overlap. */
export function visibleFrames(frames: readonly { readonly t: number }[], toX: (t: number) => number, gap: number): number[] {
  const out: number[] = [];
  let last = -Infinity;
  frames.forEach((f, i) => {
    const x = toX(f.t);
    if (x - last >= gap) {
      out.push(i);
      last = x;
    }
  });
  return out;
}

/** The picture on screen at `t`: the index of the last taken at or before it (the first, before any); -1 without pictures. */
export function frameIndexAt(frames: readonly { readonly t: number }[], t: number): number {
  if (frames.length === 0) return -1;
  let lo = 0;
  let hi = frames.length - 1;
  if (t < frames[0]!.t) return 0;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (frames[mid]!.t <= t) lo = mid;
    else hi = mid - 1;
  }
  return lo;
}

/** The picture lane's thumbnails: spaced so none overlap, the one on screen at the playhead (`current`) always among them. */
export function pictureStrip(frames: readonly { readonly t: number }[], toX: (t: number) => number, thumb: number, t: number): { shown: number[]; current: number } {
  const current = frameIndexAt(frames, t);
  const shown = visibleFrames(frames, toX, thumb);
  if (current < 0 || shown.includes(current)) return { shown, current };
  const x = toX(frames[current]!.t);
  const kept = shown.filter((i) => Math.abs(toX(frames[i]!.t) - x) >= thumb);
  return { shown: [...kept, current].sort((a, b) => a - b), current };
}

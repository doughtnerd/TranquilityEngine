// Frame rate over a sliding window of recent frames: the current, lowest and average frame rate
// from the frame times reported in the last `windowMs`. Play mode's Stats reads it (playStats.ts).

/** Frame rate figures over a window of recent frames. */
export interface FrameSummary {
  /** Frames per second from the latest frame. */
  readonly fps: number;
  /** The lowest frame rate in the window (its longest frame). */
  readonly minFps: number;
  /** Frames in the window over the window's total time. */
  readonly avgFps: number;
  /** The latest frame's time, ms. */
  readonly frameMs: number;
  /** How many frames the window holds. */
  readonly frames: number;
}

/** The frame times of the last `windowMs` milliseconds (by when each frame was reported). */
export class FrameWindow {
  private readonly at: number[] = [];
  private readonly dt: number[] = [];

  constructor(readonly windowMs = 1000) {}

  /** A frame of `dtMs` milliseconds, reported at time `now` (ms). Non-positive frame times are ignored. */
  push(dtMs: number, now: number): void {
    if (!(dtMs > 0)) return;
    this.at.push(now);
    this.dt.push(dtMs);
    this.trim(now);
  }

  /** The window as of `now`, or null when no frame came in it (paused, or not started). */
  summary(now: number): FrameSummary | null {
    this.trim(now);
    const n = this.dt.length;
    if (n === 0) return null;
    let sum = 0, max = 0;
    for (const d of this.dt) {
      sum += d;
      if (d > max) max = d;
    }
    const last = this.dt[n - 1];
    return { fps: 1000 / last, minFps: 1000 / max, avgFps: (1000 * n) / sum, frameMs: last, frames: n };
  }

  clear(): void {
    this.at.length = 0;
    this.dt.length = 0;
  }

  private trim(now: number): void {
    let drop = 0;
    while (drop < this.at.length && this.at[drop] <= now - this.windowMs) drop++;
    if (drop) {
      this.at.splice(0, drop);
      this.dt.splice(0, drop);
    }
  }
}

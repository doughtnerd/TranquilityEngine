// Play mode's Stats (like Unity's Game view Stats): frame rate over the last second, the Engine's
// per-World phase timings, render counters, node and navigation agent counts, and the JS heap.
// The collector is the Engine's timing hook (`setEngineTiming`) only while the panel shows, so a
// hidden panel costs nothing.
import type { Engine } from "../engine";
import { type EngineTiming, engineWorld, navAgentCount, nodeCount, renderDiagnostics, type RenderStats } from "../engine/editor";

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

/** One World's phase times (ms), averaged over the frames since the last read. */
export interface PhaseTimes {
  readonly fixedMs: number;
  readonly updateMs: number;
  readonly renderMs: number;
}

/** The Engine timing hook behind the Stats panel: frame times into a window, World phase times averaged per read. */
export class StatsCollector implements EngineTiming {
  readonly frames: FrameWindow;
  private stepSum = 0;
  private stepCount = 0;
  private readonly sums = new Map<string, { fixed: number; update: number; render: number; n: number }>();

  constructor(private readonly clock: () => number = () => performance.now(), windowMs = 1000) {
    this.frames = new FrameWindow(windowMs);
  }

  /** The collector's clock, ms. */
  now(): number {
    return this.clock();
  }

  frame(dtMs: number, stepMs: number): void {
    this.frames.push(dtMs, this.clock());
    this.stepSum += stepMs;
    this.stepCount++;
  }

  world(name: string, fixedMs: number, updateMs: number, renderMs: number): void {
    let s = this.sums.get(name);
    if (!s) this.sums.set(name, (s = { fixed: 0, update: 0, render: 0, n: 0 }));
    s.fixed += fixedMs;
    s.update += updateMs;
    s.render += renderMs;
    s.n++;
  }

  /** Each World's average phase times since the last call, and the Engine step's (null: no frame since). Starts the next period. */
  takePhases(): { step: number | null; worlds: Map<string, PhaseTimes> } {
    const worlds = new Map<string, PhaseTimes>();
    for (const [name, s] of this.sums) worlds.set(name, { fixedMs: s.fixed / s.n, updateMs: s.update / s.n, renderMs: s.render / s.n });
    const step = this.stepCount ? this.stepSum / this.stepCount : null;
    this.sums.clear();
    this.stepSum = 0;
    this.stepCount = 0;
    return { step, worlds };
  }
}

export interface WorldStats {
  readonly name: string;
  readonly paused: boolean;
  /** Phase times since the last snapshot; null when the World didn't step meanwhile. */
  readonly phases: PhaseTimes | null;
  /** Null when the World doesn't render (headless, a server). */
  readonly render: RenderStats | null;
  readonly nodes: number;
  /** Null when the World has no navigation. */
  readonly agents: number | null;
}

export interface StatsSnapshot {
  readonly frame: FrameSummary | null;
  /** The whole Engine step's average time, ms (every World); null when no frame ran. */
  readonly stepMs: number | null;
  /** JS heap used and limit, bytes; null where the browser doesn't say (WebKit, Firefox). */
  readonly heap: { used: number; limit: number } | null;
  readonly worlds: readonly WorldStats[];
}

/** The JS heap from `performance.memory` (Chromium only). */
export function jsHeap(): { used: number; limit: number } | null {
  const m = (globalThis.performance as Performance & { memory?: { usedJSHeapSize: number; jsHeapSizeLimit: number } } | undefined)?.memory;
  return m && typeof m.usedJSHeapSize === "number" ? { used: m.usedJSHeapSize, limit: m.jsHeapSizeLimit } : null;
}

/** Read everything the panel shows, now. */
export function takeSnapshot(engine: Engine, collector: StatsCollector): StatsSnapshot {
  const { step, worlds: phases } = collector.takePhases();
  const worlds: WorldStats[] = [];
  for (const h of engine.worlds()) {
    const world = engineWorld(engine, h.name);
    if (!world) continue;
    worlds.push({ name: h.name, paused: h.paused, phases: phases.get(h.name) ?? null, render: renderDiagnostics(world)?.stats ?? null, nodes: nodeCount(world), agents: navAgentCount(world) });
  }
  return { frame: collector.frames.summary(collector.now()), stepMs: step, heap: jsHeap(), worlds };
}

/** Bytes as MB with one decimal. */
export const megabytes = (bytes: number) => `${(bytes / (1024 * 1024)).toFixed(1)} MB`;

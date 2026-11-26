// The animation frame meter (T34, ADR 0370 budgets, 0373): what the profiler's Animation table reads. Each World's
// namespace owns one (`AnimationWorldCore.meter`); the core's `evaluate` counters (`AnimationCore.evaluateCounts`) and
// the three stage times land in it as the frame runs, and the profiler takes the averages since its last read.
//
// Per-Animator cost: the core reports counts per evaluate, not per instance (one `evaluate` call runs every due
// instance, and timing inside wasm would need a clock import), so there are no per-Animator rows; the table shows the
// World's totals. Skinning is not separable either: bone matrices are written inside `evaluate` (counted as
// `skinned`), and `apply` holds the upload to the ECS.

/** @internal The core's counters for one `evaluate` call (the World's instances of one pass). */
export interface EvaluateCounts {
  /** Instances of the World in the pass. */
  readonly instances: number;
  /** Of those, frozen by culling (no pose; root motion may still run). */
  readonly culled: number;
  /** Skipped by their LOD rate (the shown pose is interpolated). */
  readonly lodSkipped: number;
  /** Poses evaluated. */
  readonly evaluated: number;
  /** Bones in the poses evaluated. */
  readonly bones: number;
  /** Instances whose bone matrices were rewritten. */
  readonly skinned: number;
}

/** @internal The averages per frame since the last {@link FrameMeter.take}, and the memory now. */
export interface AnimationFrameStats {
  /** Frames averaged (normal-pass evaluates). */
  readonly frames: number;
  /** ms: the stages. `evaluateMs` is the core's `evaluate` call (commands, graphs, rigs, tweens, timelines, skinning). */
  readonly gatherMs: number;
  readonly evaluateMs: number;
  readonly applyMs: number;
  readonly instances: number;
  readonly active: number;
  readonly culled: number;
  readonly lodSkipped: number;
  readonly evaluated: number;
  readonly bones: number;
  readonly skinned: number;
  /** Third-party node instruction fuel spent per frame (page-wide, all Worlds). */
  readonly nodeFuel: number;
  /** Third-party node faults reported since the last take (a total, not an average). */
  readonly faults: number;
}

/** @internal Which stage a time belongs to. */
export type FrameStage = "gather" | "evaluate" | "apply";

/** @internal Accumulates one World's frame numbers between profiler reads. Never throws; costs a few additions per stage. */
export class FrameMeter {
  private frames = 0;
  private readonly ms = { gather: 0, evaluate: 0, apply: 0 };
  private counts = { instances: 0, culled: 0, lodSkipped: 0, evaluated: 0, bones: 0, skinned: 0 };
  private fuel = 0;
  private faults = 0;

  constructor(private readonly clock: () => number = () => performance.now()) {}

  /**
   * The clock now: a stage's start, for {@link stop}. A stage runs `const t = meter.start(); try { … } finally {
   * meter.stop(stage, t); }` (no closure per frame).
   */
  start(): number {
    return this.clock();
  }

  /** Adds the time since `started` (what {@link start} gave) to `stage`. */
  stop(stage: FrameStage, started: number): void {
    this.ms[stage] += this.clock() - started;
  }

  /** One `evaluate` call's counters; `normal` marks the pass that ends a frame. */
  evaluated(c: EvaluateCounts, fuel: number, faults: number, normal: boolean): void {
    if (normal) this.frames++;
    this.counts.instances += c.instances;
    this.counts.culled += c.culled;
    this.counts.lodSkipped += c.lodSkipped;
    this.counts.evaluated += c.evaluated;
    this.counts.bones += c.bones;
    this.counts.skinned += c.skinned;
    this.fuel += fuel;
    this.faults += faults;
  }

  /** The averages per frame since the last call (null when no frame ran), starting the next period. */
  take(): AnimationFrameStats | null {
    const n = this.frames;
    const out: AnimationFrameStats | null =
      n === 0
        ? null
        : {
            frames: n,
            gatherMs: this.ms.gather / n,
            evaluateMs: this.ms.evaluate / n,
            applyMs: this.ms.apply / n,
            instances: this.counts.instances / n,
            active: (this.counts.instances - this.counts.culled) / n,
            culled: this.counts.culled / n,
            lodSkipped: this.counts.lodSkipped / n,
            evaluated: this.counts.evaluated / n,
            bones: this.counts.bones / n,
            skinned: this.counts.skinned / n,
            nodeFuel: this.fuel / n,
            faults: this.faults,
          };
    this.frames = 0;
    this.ms.gather = this.ms.evaluate = this.ms.apply = 0;
    this.counts = { instances: 0, culled: 0, lodSkipped: 0, evaluated: 0, bones: 0, skinned: 0 };
    this.fuel = 0;
    this.faults = 0;
    return out;
  }
}

/** Third-party node fuel spent since the last {@link takeNodeFuel} (the node host runs inside the core's `evaluate`, one page-wide host). */
let nodeFuelSpent = 0;

/** @internal The node host reports the fuel a successful call spent. */
export function recordNodeFuel(spent: number): void {
  nodeFuelSpent += spent;
}

/** @internal The fuel spent since the last call, starting the next period. */
export function takeNodeFuel(): number {
  const n = nodeFuelSpent;
  nodeFuelSpent = 0;
  return n;
}

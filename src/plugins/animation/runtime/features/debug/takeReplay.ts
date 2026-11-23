// Re-evaluating a take's frames against the project's graph (ADR 0348, 0373; T73), as the live recorder re-evaluates its
// own (`recorder.ts`): the nearest earlier keyframe's snapshot is restored into a scratch instance of the project's graph and
// skeleton, in a World id of its own in the page's core (so the running World's instances don't move), and the recorded rows
// and commands are applied frame by frame with their passes and time steps. The core is deterministic, so with the graph and
// clips as they were recorded the matrices equal the recorded frame's bit for bit; with edited clips they show what the
// project does with the same inputs. Scrubbing on from the last frame continues without restoring.
//
// `show` writes a re-evaluated pose into a live Animator's matrix row (the original saved) and bumps its skinning version,
// so render sync draws it while the session is paused; `show(null)` puts the saved row back. Re-evaluate and show only
// between frames (a UI event), never inside a World's step.
import type { Animator } from "../../components/Animator";
import type { AnimationWorldCore } from "../../core/AnimationWorldCore";
import { MATRIX_FLOATS } from "../../wasm/wire/core";
import { graphInstanceOf } from "../graph/runtime";
import { animatorRuntime, type AnimatorRuntime } from "../instances";
import { replayRows } from "./recorder";
import type { AnimationTakeTarget } from "./takeRead";

export class TakeReplayer {
  private readonly position = new Map<number, number>();
  private readonly keys: number[] = [];
  private scratch: { world: number; instance: number; at: { key: number; position: number } | null } | null = null;
  private shown: { index: number; saved: Float32Array } | null = null;
  private disposed = false;

  constructor(
    readonly target: AnimationTakeTarget,
    readonly animator: Animator,
  ) {
    target.entries.forEach((e, p) => {
      this.position.set(e.frame.index, p);
      if (e.key) this.keys.push(p);
    });
  }

  /** Whether frame `index` holds a keyframe. */
  isKeyframe(index: number): boolean {
    const p = this.position.get(index);
    return p !== undefined && this.target.entries[p]!.key !== null;
  }

  /** The frame `show` shows, or null for the live pose. */
  get showing(): number | null {
    return this.shown?.index ?? null;
  }

  /** The live parts the animator runs on now, or null while its graph or skeleton isn't loaded. */
  private live(): { ns: AnimationWorldCore; rt: AnimatorRuntime; instance: number; graph: number; skeleton: number; bones: number } | null {
    const rt = animatorRuntime(this.animator);
    const gi = graphInstanceOf(this.animator);
    if (!rt?.ns || !gi || !rt.ns.open || !rt.skeleton) return null;
    return { ns: rt.ns, rt, instance: gi.instance, graph: gi.graph, skeleton: rt.skeleton.handle, bones: rt.skeleton.info?.bones ?? 0 };
  }

  /**
   * The pose (model-space skinning matrices, 12 floats per bone) at frame `index`, re-evaluated from the nearest earlier
   * keyframe and the recorded rows; null when the frame isn't in the take, can't be replayed (no keyframe before it, a
   * row the recorder couldn't keep) or the project's graph refuses the recorded state.
   */
  reevaluate(index: number): Float32Array | null {
    const t = this.live();
    const p = this.position.get(index);
    if (!t || p === undefined || this.disposed) return null;
    const entries = this.target.entries;
    let k = -1;
    for (let i = this.keys.length - 1; i >= 0; i--) {
      if (this.keys[i]! <= p) {
        k = this.keys[i]!;
        break;
      }
    }
    if (k < 0) return null;
    const core = t.ns.core;
    const s = this.scratchFor(t);
    if (!s) return null;
    let from = k;
    if (s.at && s.at.key === k && s.at.position <= p) from = s.at.position + 1;
    else if (core.restore(s.instance, entries[k]!.key!) !== 0) return null;
    for (let i = from; i <= p; i++) {
      const e = entries[i]!;
      if (!e.raw?.complete || (i > k && e.before.some((b) => !b.complete))) {
        s.at = null;
        return null;
      }
    }
    for (let i = from; i <= p; i++) {
      const e = entries[i]!;
      if (i > k) for (const b of e.before) replayRows(core, s.world, s.instance, b);
      replayRows(core, s.world, s.instance, e.raw!);
    }
    s.at = { key: k, position: p };
    const at = core.matrixOffset(s.instance);
    return core.views().matrices.slice(at, at + t.bones * MATRIX_FLOATS);
  }

  /** Shows frame `index`'s re-evaluated pose on the live Animator until `show(null)`. False when it can't be re-evaluated (nothing changes then). */
  show(index: number | null): boolean {
    if (index === null) {
      this.unshow();
      return true;
    }
    const t = this.live();
    const pose = this.reevaluate(index);
    if (!t || !pose) return false;
    const core = t.ns.core;
    const at = core.matrixOffset(t.instance);
    const row = core.views().matrices;
    if (!this.shown) this.shown = { index, saved: row.slice(at, at + pose.length) };
    else this.shown.index = index;
    row.set(pose, at);
    t.rt.version++;
    return true;
  }

  /** Puts a shown pose back and frees the scratch instance. */
  dispose(): void {
    if (this.disposed) return;
    this.unshow();
    this.dropScratch();
    this.disposed = true;
  }

  private scratchFor(t: NonNullable<ReturnType<TakeReplayer["live"]>>): NonNullable<TakeReplayer["scratch"]> | null {
    if (this.scratch) return this.scratch;
    const core = t.ns.core;
    const world = core.openWorld();
    const instance = core.createInstance(world, t.skeleton, t.graph);
    if (!instance) {
      core.closeWorld(world);
      return null;
    }
    this.scratch = { world, instance, at: null };
    return this.scratch;
  }

  private unshow(): void {
    const s = this.shown;
    const t = this.live();
    this.shown = null;
    if (!s || !t) return;
    const core = t.ns.core;
    core.views().matrices.set(s.saved, core.matrixOffset(t.instance));
    t.rt.version++;
  }

  private dropScratch(): void {
    const s = this.scratch;
    this.scratch = null;
    const t = this.live();
    if (!s || !t) return;
    try {
      t.ns.core.destroyInstance(s.instance);
      t.ns.core.closeWorld(s.world);
    } catch {
      // The page's core is gone with its Engine.
    }
  }
}

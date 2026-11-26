// The engine's tween backend (`src/engine/tween/backend.ts`, ADR 0420) over the animation core's tween table: what UI
// animation runs on while the animation plugin is active, so the core's wasm loads once and UI and game tweens run the
// same table. The plugin installs it as the engine's provider when it activates (`features/core/register.ts`).
//
// A backend is a World id of its own in the core (`openWorld`), so its update evaluates only its tweens and sequences
// (no Animators, and game tweens keep their lateUpdate order, 0370). Its update clears the core's per-frame outputs
// first (`writeInputs(0)`), as every World's evaluate does: run it outside a World's evaluate-to-apply span. The
// sequences are the core's timeline instances (`SEQ_CREATE` + `SEQ_MEMBER`), the same records the standalone module takes.
import type { Curve } from "../../../../engine/core/curve";
import {
  encodeSequence,
  type SequenceBlock,
  type SequenceChange,
  type SequenceHead,
  type SequenceInfo,
  type SequenceMember,
  type SequenceOutputs,
  type TweenBackend,
  type TweenChange,
  type TweenRows,
  type TweenSpec,
} from "../../../../engine/tween/backend";
import { CHANGE_DESTROYED as SEQUENCE_DESTROYED, CHANGE_FINISHED, CHANGE_KILLED as SEQUENCE_KILLED, OP_KILL as SEQUENCE_KILL } from "../wasm/wire/timeline";
import { CHANGE_COMPLETED, CHANGE_DESTROYED, CHANGE_KILLED, OP_KILL } from "../wasm/wire/tween";
import type { AnimationCore } from "./AnimationCore";

class CoreTweenBackend implements TweenBackend {
  readonly kind = "core";
  private readonly world: number;
  private closed = false;
  private readonly tweens = new Set<number>();
  private readonly sequences = new Set<number>();
  private readonly curves = new Set<number>();
  private readonly tweenChange = {} as TweenChange;
  private readonly seqChange = {} as SequenceChange;

  constructor(private readonly core: AnimationCore) {
    this.world = core.openWorld();
  }

  lastStatus(): number {
    return this.core.lastStatus();
  }

  loadCurve(curve: Curve): number {
    if (this.closed) return 0;
    const h = this.core.loadCurve(curve);
    if (h !== 0) this.curves.add(h);
    return h;
  }

  releaseCurve(handle: number): boolean {
    if (!this.curves.delete(handle)) return false;
    return this.core.releaseCurve(handle);
  }

  create(spec: TweenSpec): number {
    if (this.closed) return 0;
    const h = this.core.tweenCreate({ ...spec, world: this.world });
    if (h !== 0) this.tweens.add(h);
    return h;
  }

  control(handle: number, op: number): number {
    return this.core.tweenControl(handle, op);
  }

  createSequence(head: SequenceHead, members: readonly SequenceMember[]): number {
    if (this.closed) return 0;
    const h = this.core.timelineCreateSequence(encodeSequence(this.world, head, members));
    if (h !== 0) this.sequences.add(h);
    return h;
  }

  controlSequence(handle: number, op: number, value = 0): number {
    return this.core.timelineControl(handle, op, value);
  }

  sequenceInfo(handle: number): SequenceInfo | null {
    return this.core.timelineInfo(handle);
  }

  sequenceBlocks(handle: number): SequenceBlock[] {
    return this.core.timelineBlocks(handle);
  }

  update(pass: number, dtScaled: number, dtUnscaled: number): void {
    if (this.closed) return;
    this.core.writeInputs(0);
    this.core.evaluate(this.world, pass, dtScaled, dtUnscaled);
    // What ended leaves the sets, so they hold only what `dispose` must kill.
    for (let i = 0, n = this.core.tweenChangeCount(); i < n; i++) {
      const c = this.core.tweenChange(i, this.tweenChange);
      if (c.kind === CHANGE_COMPLETED || c.kind === CHANGE_KILLED || c.kind === CHANGE_DESTROYED) this.tweens.delete(c.handle);
    }
    for (let i = 0, n = this.core.timelineChangeCount(); i < n; i++) {
      const c = this.core.timelineChange(i, this.seqChange);
      const ended = c.kind === SEQUENCE_KILLED || c.kind === SEQUENCE_DESTROYED || (c.kind === CHANGE_FINISHED && !this.core.timelineInfo(c.instance));
      if (ended) this.sequences.delete(c.instance);
    }
  }

  rows(): TweenRows {
    return this.core.tweenRows();
  }

  changeCount(): number {
    return this.core.tweenChangeCount();
  }

  change(i: number, out?: TweenChange): TweenChange {
    return this.core.tweenChange(i, out);
  }

  activeSequences(): Uint32Array {
    return this.core.timelineActive();
  }

  sequenceOutputs(): SequenceOutputs {
    return this.core.timelineOutputs();
  }

  sequenceChangeCount(): number {
    return this.core.timelineChangeCount();
  }

  sequenceChange(i: number, out?: SequenceChange): SequenceChange {
    return this.core.timelineChange(i, out);
  }

  dispose(): void {
    if (this.closed) return;
    this.closed = true;
    for (const h of this.tweens) this.core.tweenControl(h, OP_KILL);
    this.tweens.clear();
    for (const h of this.sequences) this.core.timelineControl(h, SEQUENCE_KILL);
    this.sequences.clear();
    for (const h of this.curves) this.core.releaseCurve(h);
    this.curves.clear();
    this.core.closeWorld(this.world);
  }
}

/** @internal A tween backend over `core`'s tween table (a World id of its own in it). */
export function createCoreTweenBackend(core: AnimationCore): TweenBackend {
  return new CoreTweenBackend(core);
}

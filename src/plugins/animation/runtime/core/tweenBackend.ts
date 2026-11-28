// The engine's tween backend (`src/engine/tween/backend.ts`, ADR 0424) over the animation core's tween table: what UI
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
import { LiveHandles } from "../../../../engine/tween/liveHandles";
import { OP_KILL as SEQUENCE_KILL } from "../wasm/wire/timeline";
import { OP_KILL } from "../wasm/wire/tween";
import type { AnimationCore } from "./AnimationCore";

class CoreTweenBackend implements TweenBackend {
  readonly kind = "core";
  private readonly world: number;
  private closed = false;
  private readonly held = new LiveHandles();
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
    return this.held.curve(this.core.loadCurve(curve));
  }

  releaseCurve(handle: number): boolean {
    if (!this.held.freeCurve(handle)) return false;
    return this.core.releaseCurve(handle);
  }

  create(spec: TweenSpec): number {
    if (this.closed) return 0;
    return this.held.tween(this.core.tweenCreate({ ...spec, world: this.world }));
  }

  control(handle: number, op: number): number {
    return this.core.tweenControl(handle, op);
  }

  createSequence(head: SequenceHead, members: readonly SequenceMember[]): number {
    if (this.closed) return 0;
    return this.held.sequence(this.core.timelineCreateSequence(encodeSequence(this.world, head, members)));
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
    // What ended is forgotten, so `held` keeps only what `dispose` must end.
    for (let i = 0, n = this.core.tweenChangeCount(); i < n; i++) this.held.tweenChanged(this.core.tweenChange(i, this.tweenChange));
    for (let i = 0, n = this.core.timelineChangeCount(); i < n; i++) this.held.sequenceChanged(this.core.timelineChange(i, this.seqChange), (h) => !!this.core.timelineInfo(h));
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
    this.held.endAll({
      killTween: (h) => this.core.tweenControl(h, OP_KILL),
      killSequence: (h) => this.core.timelineControl(h, SEQUENCE_KILL),
      releaseCurve: (h) => this.core.releaseCurve(h),
    });
    this.core.closeWorld(this.world);
  }
}

/** @internal A tween backend over `core`'s tween table (a World id of its own in it). */
export function createCoreTweenBackend(core: AnimationCore): TweenBackend {
  return new CoreTweenBackend(core);
}

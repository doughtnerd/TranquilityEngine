/**
 * What a tween backend holds and its `dispose` must end (ADR 0470): the tweens and sequences it created that haven't
 * ended, and the curves it loaded and hasn't freed. Both backends (the standalone module's, `./standalone.ts`, and the
 * animation core's, the plugin's `core/tweenBackend.ts`) keep it the same way, from the same change records.
 *
 * Internal: not public API.
 */
import type { SequenceChange, TweenChange } from "./backend";
import { CHANGE_DESTROYED as SEQUENCE_DESTROYED, CHANGE_FINISHED, CHANGE_KILLED as SEQUENCE_KILLED } from "./wasm/wire/sequence";
import { CHANGE_COMPLETED, CHANGE_DESTROYED, CHANGE_KILLED } from "./wasm/wire/tween";

/** @internal How a backend ends what it holds, in its module. */
export interface HeldEnder {
  killTween(handle: number): void;
  killSequence(handle: number): void;
  releaseCurve(handle: number): void;
}

/** @internal A backend's live tweens, sequences and curves. */
export class LiveHandles {
  private readonly tweens = new Set<number>();
  private readonly sequences = new Set<number>();
  private readonly curves = new Set<number>();

  /** Notes a created tween (0, a refusal, is ignored); returns the handle. */
  tween(handle: number): number {
    if (handle !== 0) this.tweens.add(handle);
    return handle;
  }

  /** Notes a created sequence (0 ignored); returns the handle. */
  sequence(handle: number): number {
    if (handle !== 0) this.sequences.add(handle);
    return handle;
  }

  /** Notes a loaded curve (0 ignored); returns the handle. */
  curve(handle: number): number {
    if (handle !== 0) this.curves.add(handle);
    return handle;
  }

  /** Forgets a curve being freed: false when it isn't one of these (then it mustn't be freed). */
  freeCurve(handle: number): boolean {
    return this.curves.delete(handle);
  }

  /** A tween change record of the last update: a tween that completed, was killed or destroyed has ended. */
  tweenChanged(c: TweenChange): void {
    if (c.kind === CHANGE_COMPLETED || c.kind === CHANGE_KILLED || c.kind === CHANGE_DESTROYED) this.tweens.delete(c.handle);
  }

  /**
   * A sequence change record of the last update: a sequence killed or destroyed has ended, and one that finished has
   * unless the module still holds it (`live`).
   */
  sequenceChanged(c: SequenceChange, live: (handle: number) => boolean): void {
    if (c.kind === SEQUENCE_KILLED || c.kind === SEQUENCE_DESTROYED || (c.kind === CHANGE_FINISHED && !live(c.instance))) this.sequences.delete(c.instance);
  }

  /** Kills the tweens, then the sequences, then frees the curves, and forgets them all. */
  endAll(ender: HeldEnder): void {
    for (const h of this.tweens) ender.killTween(h);
    this.tweens.clear();
    for (const h of this.sequences) ender.killSequence(h);
    this.sequences.clear();
    for (const h of this.curves) ender.releaseCurve(h);
    this.curves.clear();
  }
}

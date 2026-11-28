/**
 * One cache of loaded curve assets for whatever loads them (ADR 0470): a tween backend (UI animation) or the animation
 * core for one World (game tweens). A curve is loaded on the first reference to its content and shared by later ones;
 * the asset is released with the last reference. A load that fails (handle 0) is not remembered, so the next reference
 * tries again.
 *
 * Internal: not public API.
 */
import type { Curve } from "../core/curve";

/** @internal What loads and frees curve assets: a `TweenBackend`, or the animation core. */
export interface CurvePort {
  /** The handle of a newly loaded asset of `curve`, or 0 when it can't be loaded. */
  loadCurve(curve: Curve): number;
  releaseCurve(handle: number): unknown;
}

/** @internal Reference-counted curve assets, by content. */
export class CurveCache {
  private readonly byKey = new Map<string, { readonly handle: number; refs: number }>();
  private readonly keyOf = new Map<number, string>();

  constructor(private readonly port: CurvePort) {}

  /**
   * One reference to the asset of `curve` (`key` names its content; by default its JSON). Returns its handle, or 0 when
   * the port refused it. Give it back with `release`.
   */
  acquire(curve: Curve, key: string = JSON.stringify(curve)): number {
    const known = this.byKey.get(key);
    if (known) {
      known.refs++;
      return known.handle;
    }
    const handle = this.port.loadCurve(curve);
    if (handle === 0) return 0;
    this.byKey.set(key, { handle, refs: 1 });
    this.keyOf.set(handle, key);
    return handle;
  }

  /** Drops one reference to a handle `acquire` gave; the asset is released with the last. Others are ignored. */
  release(handle: number): void {
    const key = this.keyOf.get(handle);
    const entry = key === undefined ? undefined : this.byKey.get(key);
    if (key === undefined || !entry || --entry.refs > 0) return;
    this.byKey.delete(key);
    this.keyOf.delete(handle);
    this.port.releaseCurve(handle);
  }

  /** Releases every asset it holds, whatever their references. */
  releaseAll(): void {
    for (const { handle } of this.byKey.values()) this.port.releaseCurve(handle);
    this.byKey.clear();
    this.keyOf.clear();
  }
}

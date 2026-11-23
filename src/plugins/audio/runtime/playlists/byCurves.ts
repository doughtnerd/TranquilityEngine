/**
 * Second-input curves at runtime (ADR 0362 §5, `engine/audio/curveBy.ts`): a playlist voice curve or automation lane
 * that also follows a second parameter.
 *
 * The core follows one input per binding, so a lane with `by` is played as its **slice**: the curve over its own input
 * (time or a parameter) at the second parameter's value now. An instance keeps one `LiveSlice` per lane; it re-slices
 * when the second parameter changes (`ByCurves.onParameter`, the instance's local and global parameter changes) and
 * redefines the curve ids it lent out (`PlaylistHost.leaseCurve`), so every voice bound through one follows at once.
 * Main-thread time curves read `LiveSlice.curve` each frame. A second parameter that isn't the instance's or a global
 * one leaves the lane at its own curve (the Studio lints it).
 */
import type { Curve } from "../../../../engine/core/curve";
import { secondValueOf, sliceCurveBy, type CurveBy, type SecondValue } from "../../../../engine/audio/curveBy";
import type { ParameterDef } from "../../../../engine/audio/parameters";
import { warnOnce } from "../core/handle";
import { playlistHost } from "./host";

/** A lane's slice now, and the core curves made from it. */
export class LiveSlice {
  /** The slice at the second parameter's value now, in the lane's units after its owner's mapping (`pre`). */
  curve: Curve;
  private last = Number.NaN;
  private readonly lent: { key: string; map: (c: Curve) => Curve; id: number | null }[] = [];

  constructor(
    readonly main: Curve,
    readonly by: CurveBy,
    private readonly pre: (c: Curve) => Curve,
    private readonly second: () => SecondValue | null,
    private readonly alive: () => boolean,
  ) {
    this.curve = this.compute();
  }

  private compute(): Curve {
    const s = this.second();
    this.last = s ? s.value : Number.NaN;
    return this.pre(s ? sliceCurveBy(this.main, this.by, s) : this.main);
  }

  /** The second parameter moved: the slice again, and every lent curve redefined. */
  update(): void {
    const s = this.second();
    if (s && s.value === this.last) return;
    this.curve = this.compute();
    for (const l of this.lent) if (l.id !== null) playlistHost().redefineCurve(l.id, l.map(this.curve));
  }

  /** A core curve id holding `map` of the slice (`key` names the mapping: one id per mapping), kept up to date. */
  curveId(key: string, map: (c: Curve) => Curve = (c) => c): number | null {
    let l = this.lent.find((x) => x.key === key);
    if (!l) this.lent.push((l = { key, map, id: playlistHost().leaseCurve(map(this.curve), this.alive) }));
    return l.id;
  }
}

/** What the slices need of their instance. */
export interface ByHost {
  path(): string;
  /** A parameter's value and definition (local, else global); null when there is none. */
  param(name: string): { value: number; def: ParameterDef } | null;
  /** True while anything of the instance may still sound (its lent curves must not be reused before). */
  alive(): boolean;
}

/** An instance's slices, one per lane (and owner mapping). */
export class ByCurves {
  private readonly slices = new Map<Curve, Map<CurveBy, Map<string, LiveSlice>>>();
  private readonly all: LiveSlice[] = [];

  constructor(private readonly host: ByHost) {}

  /**
   * The slice of lane `main` following `by`; `pre` maps it as the lane's owner maps its curve (an `enabled` lane's
   * step, an effect gain's offset), named by `key` (one slice per lane and mapping).
   */
  slice(main: Curve, by: CurveBy, key = "", pre: (c: Curve) => Curve = (c) => c): LiveSlice {
    let byBy = this.slices.get(main);
    if (!byBy) this.slices.set(main, (byBy = new Map()));
    let byKey = byBy.get(by);
    if (!byKey) byBy.set(by, (byKey = new Map()));
    let s = byKey.get(key);
    if (!s) {
      const second = () => {
        const p = this.host.param(by.input);
        if (!p) {
          warnOnce(`playlist:by:${this.host.path()}:${by.input}`, `[myco] ${this.host.path()}: a curve follows the parameter "${by.input}", which is neither the playlist's nor a global one; it plays its own curve.`);
          return null;
        }
        return secondValueOf(p.def, p.value);
      };
      byKey.set(key, (s = new LiveSlice(main, by, pre, second, () => this.host.alive())));
      this.all.push(s);
    }
    return s;
  }

  /** A parameter changed: the slices that follow it again. */
  onParameter(name: string): void {
    for (const s of this.all) if (s.by.input === name) s.update();
  }
}

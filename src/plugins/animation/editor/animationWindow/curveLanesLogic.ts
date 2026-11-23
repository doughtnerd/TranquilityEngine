// The Animation window's curve view (ADR 0373): the clip's curve tracks as `kind: "time"` lanes of the one shared curve
// editor (ADR 0346, `src/editor/ui/curves/`), one lane per bound field component (`Body/Lamp · intensity`,
// `Sword · position.y`), over the clip's duration, with Bézier keys. Apply writes the lanes back to their tracks.
//
// The curve editor keeps a key at each end of a lane's domain (`withEnds`); a lane the user didn't change is written
// back as it was, so opening and applying never adds end keys to curves nobody touched.
//
// Pure; no DOM.
import type { AnimSource } from "../../../../engine/animation/animSource";
import { CURVE_TRACK_WIDTH, type CurveTrack, type CurveTrackKind } from "../../../../engine/animation/tracks";
import type { Curve, CurveKey } from "../../../../engine/core/curve";
import { accept, refuse, type EditResult } from "../../../../editor/sdk";
import { withCurveEnds as withEnds, type CurveEditorResult, type CurveEditorSpec, type CurveLane } from "../../../../editor/sdk";
import { fitYRange } from "../../../../editor/sdk";
import { parseRowId, rowId } from "./trackRowsLogic";

const COMPONENT = { float: [""], morph: [""], curve: [""], vec2: ["x", "y"], vec3: ["x", "y", "z"], vec4: ["x", "y", "z", "w"], color: ["r", "g", "b", "a"] } as const;

const isCurveTrack = (t: AnimSource["tracks"][number]): t is CurveTrack => t.kind in CURVE_TRACK_WIDTH;

/** A lane's name: the bound node and field (and component). */
function laneName(t: CurveTrack, component: number): string {
  const part = COMPONENT[t.kind as CurveTrackKind][component];
  if (t.kind === "curve") return `Curve ${t.name}`;
  const field = part ? `${t.target.field}.${part}` : t.target.field;
  return t.target.nodePath ? `${t.target.nodePath} · ${field}` : field;
}

/** The lane over a curve: its range fits the keys (a colour's 0..1 at least). */
function lane(t: CurveTrack, index: number, component: number, color: number): CurveLane {
  const curve = t.curves[component] ?? [];
  const [lo, hi] = t.kind === "color" ? [Math.min(0, ...curve.map((k) => k[1])), Math.max(1, ...curve.map((k) => k[1]))] : fitYRange(curve);
  return {
    id: rowId(index, { kind: "curve", component }),
    name: laneName(t, component),
    unit: "",
    min: lo,
    max: hi,
    step: 0.001,
    color,
    base: curve[0]?.[1] ?? 0,
    curve,
    input: "time",
  };
}

/**
 * The curve editor's spec for the clip's curve tracks (all of them, or only `tracks`), or null when it has none.
 * Lanes are named and coloured as the dope sheet's rows.
 */
export function curveLanes(clip: AnimSource, tracks?: readonly number[]): CurveEditorSpec | null {
  const lanes: CurveLane[] = [];
  let color = 0;
  clip.tracks.forEach((t, i) => {
    if (!isCurveTrack(t) || (tracks && !tracks.includes(i))) return;
    color = (color % 8) + 1;
    for (let c = 0; c < CURVE_TRACK_WIDTH[t.kind]; c++) lanes.push(lane(t, i, c, color));
  });
  return lanes.length ? { kind: "time", lanes, length: clip.duration > 0 ? clip.duration : 1, timeName: "Clip time" } : null;
}

const sameCurve = (a: Curve, b: Curve) => JSON.stringify(a) === JSON.stringify(b);

/** The curve editor's Apply written back to the clip's tracks. Lanes left as they opened keep their curves (none changed: `clip` itself). */
export function applyCurveLanes(clip: AnimSource, spec: CurveEditorSpec, result: CurveEditorResult): EditResult<AnimSource> {
  const tracks = [...clip.tracks];
  let changed = false;
  for (const r of result.lanes) {
    const id = parseRowId(r.id);
    const opened = spec.lanes.find((l) => l.id === r.id);
    if (!id || id.channel.kind !== "curve" || !opened) continue;
    const t = tracks[id.track];
    if (!t || !isCurveTrack(t)) return refuse("a curve's track is gone");
    const before = t.curves[id.channel.component] ?? [];
    if (sameCurve(withEnds(before, 0, spec.length ?? 1, opened), r.curve)) continue; // untouched
    const component = id.channel.component;
    const curve: CurveKey[] = r.curve.map((k) => k.slice() as unknown as CurveKey);
    tracks[id.track] = { ...t, curves: t.curves.map((c, i) => (i === component ? curve : c)) };
    changed = true;
  }
  return accept(changed ? { ...clip, tracks } : clip); // unchanged: `applyEdit` records nothing
}

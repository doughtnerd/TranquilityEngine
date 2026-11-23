// The Scene settings' occlusion curves (ADR 0362 item 6): the Curves window's "Occlusion" mode over how blocked the path
// from an emitter to the listener is (0..1) with a Volume and a Low-pass lane, what Apply writes, the "Fully blocked"
// readout, which curves a playing scene hears (its own, else the project's), and the edits that give a test scene its
// own curves or take them away. The project's live in `audio.json` (`settings.occlusion.curves`), a scene's in its
// `*.audioscene.json` (`settings.occlusion.curves`).
//
// Pure: no DOM, no signals.
import type { CurveEditorResult, CurveEditorSpec, CurveLane } from "../../../editor/ui/curves/curveEditorModel";
import { OCCLUSION_CURVE_LIMITS, occlusionCutoffHz, occlusionVolumeDb, type OcclusionCurves } from "../../../engine/audio/occlusionCurves";
import type { OccluderMaterial } from "../../../engine/audio/occlusionMaterials";
import type { AudioProject } from "../../../engine/audio/project/types";
import type { AudioTestScene } from "../../../engine/audio/spatial/testSceneTypes";
import type { Curve } from "../../../engine/core/curve";
import type { EditResult } from "./sceneEdits";
import { materialText } from "./settingsEdits";

/** The window's target and context line (the prototype's "Occlusion · Scene settings · how blocked…"). */
export const OCCLUSION_TARGET = "Occlusion";
export const OCCLUSION_CONTEXT = "Scene settings · how blocked the path from emitter to listener is";

/** Each lane's range, unit and plain value (a missing curve is flat at it: the materials decide). */
const LANES: Readonly<Record<keyof OcclusionCurves, Omit<CurveLane, "id" | "curve">>> = {
  volume: { name: "Volume", unit: "dB", min: -60, max: OCCLUSION_CURVE_LIMITS.volume[1], step: 0.5, base: 0, color: 1 },
  lowpass: { name: "Low-pass", unit: "Hz", min: OCCLUSION_CURVE_LIMITS.lowpass[0], max: 20000, step: 10, scale: "log", base: 20000, color: 2 },
};

/** A new set (the prototype's starting point): −9 dB and a 1.2 kHz low-pass when fully blocked. */
export const DEFAULT_OCCLUSION_CURVES: OcclusionCurves = { volume: [[0, 0], [1, -9]], lowpass: [[0, 20000], [1, 1200]] };

/** The Curves window's Occlusion mode over `curves` (absent: the starting point), X "Blocked" 0..1. */
export function occlusionDialog(curves: OcclusionCurves | undefined): CurveEditorSpec {
  const from = curves ?? DEFAULT_OCCLUSION_CURVES;
  const lanes: CurveLane[] = (["volume", "lowpass"] as const).map((id) => {
    const l = LANES[id];
    const c = from[id];
    return { id, ...l, curve: c && c.length > 0 ? (c.map((k) => [...k]) as unknown as Curve) : [[0, l.base], [1, l.base]] };
  });
  return { kind: "parameter", lanes, parameter: { name: "Blocked", min: 0, max: 1 } };
}

const isFlatAt = (curve: Curve, base: number) => curve.every((k) => Math.abs(k[1] - base) < 1e-9);

/**
 * What Apply writes: each lane's keys, except bypassed lanes and lanes flat at their plain value (0 dB, no low-pass),
 * which leave that property to the materials; null when neither lane says anything.
 */
export function occlusionFromResult(result: CurveEditorResult): OcclusionCurves | null {
  const out: OcclusionCurves = {};
  for (const lane of result.lanes) {
    const id = lane.id as keyof OcclusionCurves;
    if (!(id in LANES) || lane.bypass || lane.curve.length === 0) continue;
    const curve = lane.curve as Curve;
    if (isFlatAt(curve, LANES[id].base)) continue;
    out[id] = curve.map((k) => [...k]) as unknown as Curve;
  }
  return out.volume || out.lowpass ? out : null;
}

const hzText = (hz: number) => (hz >= 20000 ? "no low-pass" : `low-pass ${hz >= 1000 ? `${(hz / 1000).toFixed(1)} kHz` : `${Math.round(hz)} Hz`}`);
const dbText = (db: number) => `${db.toFixed(Number.isInteger(Math.round(db * 10) / 10) ? 0 : 1).replace("-", "−")} dB`;

/**
 * "−9 dB · low-pass 1.2 kHz": what a fully blocked path sounds like. With curves, their values at Blocked 1 (a property
 * without a curve: the default material's); without, one obstacle of the default material (ADR 0347).
 */
export function fullyBlockedText(curves: OcclusionCurves | undefined, def: OccluderMaterial | undefined): string {
  if (!curves || (!curves.volume && !curves.lowpass)) return def ? materialText(def) : "—";
  const db = occlusionVolumeDb(curves, 1);
  const hz = occlusionCutoffHz(curves, 1);
  const volume = db === db ? dbText(db) : def ? dbText(def.transmissionDb) : "—";
  const lp = hz === hz ? hzText(hz) : def ? hzText(def.cutoffHz) : "";
  return lp ? `${volume} · ${lp}` : volume;
}

/** The curves a playing scene hears: its own when it has them, else the project's (undefined: the materials alone). */
export function effectiveOcclusionCurves(project: AudioProject | null, scene: AudioTestScene | null): OcclusionCurves | undefined {
  return scene?.settings?.occlusion?.curves ?? project?.settings.occlusion.curves;
}

/** `p` with the project's occlusion curves (null: none). */
export function setProjectOcclusionCurves(p: AudioProject, curves: OcclusionCurves | null): EditResult<AudioProject> {
  const { curves: _drop, ...occ } = p.settings.occlusion;
  return { next: { ...p, settings: { ...p.settings, occlusion: curves ? { ...occ, curves: structuredClone(curves) } : occ } } };
}

/** `s` with its own occlusion curves (null: none, so it hears the project's). */
export function setSceneOcclusionCurves(s: AudioTestScene, curves: OcclusionCurves | null): EditResult<AudioTestScene> {
  const { settings: _drop, ...rest } = s;
  return { next: curves ? { ...rest, settings: { ...s.settings, occlusion: { ...s.settings?.occlusion, curves: structuredClone(curves) } } } : rest };
}

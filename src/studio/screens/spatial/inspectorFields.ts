// The Inspector's fields (the prototype's inspector, S:1380-1440): each number field's range, step and unit, and the one
// check every typed value goes through before it becomes an edit: a number in the field's range (clamped, as the
// format's own limits), a whole number where it must be, a box's bottom below its top. The format (`AUDIO_SCENE_LIMITS`)
// declares the hard limits; the UI ranges are the prototype's where they are narrower and still inside them.
//
// Pure: no DOM, no signals.
import { AUDIO_SCENE_LIMITS } from "../../../engine/audio/spatial/testScene";
import type { TestAudioZone, Vec3 } from "../../../engine/audio/spatial/testSceneTypes";
import { nearestOnBox } from "./geometry";
import type { EditResult } from "./sceneEdits";

export interface FieldSpec {
  readonly label: string;
  readonly unit: string;
  /** Hard range: values are clamped into it. */
  readonly min: number;
  readonly max: number;
  readonly step: number;
  /** Decimals shown. */
  readonly digits: number;
  readonly whole?: boolean;
  /** The slider's range where it is narrower than the hard one (the prototype's). */
  readonly slider?: readonly [number, number];
}

const L = AUDIO_SCENE_LIMITS;
const C = L.coordinate;

export const FIELDS = {
  volume: { label: "Volume", unit: "dB", min: L.volume[0], max: L.volume[1], step: 0.5, digits: 1, slider: [-24, 6] },
  x: { label: "X", unit: "m", min: -C, max: C, step: 0.5, digits: 1 },
  z: { label: "Z", unit: "m", min: -C, max: C, step: 0.5, digits: 1 },
  height: { label: "Height", unit: "m", min: L.height[0], max: L.height[1], step: 0.1, digits: 1 },
  speed: { label: "Speed", unit: "m/s", min: L.speed[0], max: L.speed[1], step: 0.5, digits: 1, slider: [0, 60] },
  start: { label: "On path", unit: "%", min: 0, max: 100, step: 1, digits: 0 },
  width: { label: "Width", unit: "m", min: L.size[0], max: L.size[1], step: 0.5, digits: 1 },
  depth: { label: "Depth", unit: "m", min: L.size[0], max: L.size[1], step: 0.5, digits: 1 },
  yaw: { label: "Rotation", unit: "°", min: -180, max: 180, step: 5, digits: 0 },
  bottom: { label: "Bottom", unit: "m", min: L.height[0], max: L.height[1], step: 0.5, digits: 1 },
  top: { label: "Top", unit: "m", min: L.height[0], max: L.height[1], step: 0.5, digits: 1 },
  feather: { label: "Feather", unit: "m", min: L.feather[0], max: L.feather[1], step: 0.5, digits: 1, slider: [0, 20] },
  // Prototype: Priority ≥ 1 (the implicit level default is 1); the format allows 0..100.
  priority: { label: "Priority", unit: "", min: Math.max(1, L.priority[0]), max: L.priority[1], step: 1, digits: 0, whole: true },
  wet: { label: "Send", unit: "dB", min: L.wet[0], max: L.wet[1], step: 0.5, digits: 1, slider: [-30, 6] },
  listenerYaw: { label: "Facing", unit: "°", min: -180, max: 180, step: 5, digits: 0 },
  // audio.json settings shown on this screen (ADR 0347): `voices.hrtf` and `bedBeyond`, `dopplerAmount` in percent.
  hrtf: { label: "HRTF for the nearest", unit: "voices", min: 0, max: 32, step: 1, digits: 0, whole: true },
  bedBeyond: { label: "Ambisonic bed beyond", unit: "m", min: 1, max: 100000, step: 1, digits: 0, slider: [20, 80] },
  dopplerPercent: { label: "Doppler amount", unit: "%", min: 0, max: 200, step: 5, digits: 0 },
} as const satisfies Record<string, FieldSpec>;

export type FieldId = keyof typeof FIELDS;

/** `raw` (typed text or a number) as a value of field `id`: refused when it isn't a number, else clamped into range and rounded. */
export function fieldValue(id: FieldId, raw: string | number): EditResult<number> {
  const f: FieldSpec = FIELDS[id];
  const v = typeof raw === "number" ? raw : Number(raw.trim().replace(",", "."));
  if (typeof raw === "string" && raw.trim() === "") return { refused: `${f.label} needs a value` };
  if (!Number.isFinite(v)) return { refused: `${f.label} is a number${f.unit ? ` of ${f.unit}` : ""}` };
  const clamped = Math.min(f.max, Math.max(f.min, v));
  const rounded = f.whole ? Math.round(clamped) : Number(clamped.toFixed(Math.max(f.digits, 2)));
  return { next: rounded + 0 };
}

/** A box's bottom and top: the bottom at least the format's least height below the top. */
export function heightsValue(bottom: number, top: number): EditResult<{ bottom: number; top: number }> {
  if (!(bottom < top - L.minHeight + 1e-9)) return { refused: `the bottom must be at least ${L.minHeight} m below the top` };
  return { next: { bottom, top } };
}

/** The bottom field typed: refused when it would reach the top. */
export const bottomValue = (raw: string | number, top: number): EditResult<number> => {
  const r = fieldValue("bottom", raw);
  if ("refused" in r) return r;
  const h = heightsValue(r.next, top);
  return "refused" in h ? h : { next: r.next };
};

/**
 * The audio zone's state line for the listener at `at` (the prototype's state box): heard from its edge and how far,
 * inside it, fading in its feather, or silent outside.
 */
export function zoneState(zone: Pick<TestAudioZone, "box" | "heard" | "feather">, at: Vec3): string {
  const b = zone.box;
  const near = nearestOnBox(b, at);
  const across = Math.hypot(near.x - at.x, near.z - at.z);
  const up = at.y < b.bottom ? b.bottom - at.y : at.y > b.top ? at.y - b.top : 0;
  const d = Math.hypot(across, up);
  if (d < 1e-6) return zone.heard === "edge" ? "Listener inside: surrounds you" : "Listener inside: playing at full level";
  if (zone.heard === "edge") return `Heard from its nearest edge, ${Math.round(d)} m away`;
  if (zone.feather > 0 && d < zone.feather) return `In the feather: fading, ${Math.round((1 - d / zone.feather) * 100)}%`;
  return "Listener outside: silent";
}

/** The top field typed: refused when it would reach the bottom. */
export const topValue = (raw: string | number, bottom: number): EditResult<number> => {
  const r = fieldValue("top", raw);
  if ("refused" in r) return r;
  const h = heightsValue(bottom, r.next);
  return "refused" in h ? h : { next: r.next };
};

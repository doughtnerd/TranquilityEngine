// Pure mappings for the Babylon fallback backend (ADR 0157 BB1): the mixer's bus tree to AudioBus creation steps,
// `Attenuation` to Babylon's spatial settings, and the listener's forward/up to the rotation quaternion Babylon takes.
// No Babylon imports, so the maths is testable without the library (the listener test uses Babylon's own maths to
// confirm the convention).
import type { Vec3Like } from "../../../engine/core/math";
import type { AudioSettings } from "../../../engine/audio/settings";
import type { Attenuation, Rolloff } from "./backend";

/** What the plan needs of a bus: `ResolvedBus` and `BusSettings` both fit. */
export interface BusNode {
  name: string;
  parent?: string | null;
  maxVoices?: number;
}

/** One `AudioBus` to create, parents before children. `parent` null means it feeds the main bus. */
export interface BusPlan {
  name: string;
  parent: string | null;
  /** The bus's `maxVoices` (a cap on its live sounds), or null for unlimited. */
  maxVoices: number | null;
}

/**
 * The creation order of the mixer's buses as Babylon `AudioBus`es (parent through `outBus`): every parent comes before
 * its children, whatever order the project lists them in. A parent that doesn't exist, or that would close a cycle,
 * makes the bus a root (it feeds the main bus), and a repeated name is created once.
 */
export function planBuses(buses: readonly BusNode[]): BusPlan[] {
  const byName = new Map<string, BusNode>();
  for (const b of buses) if (!byName.has(b.name)) byName.set(b.name, b);
  const plan: BusPlan[] = [];
  const done = new Set<string>();
  const visiting = new Set<string>();
  const emit = (name: string): void => {
    if (done.has(name)) return;
    const node = byName.get(name)!;
    visiting.add(name);
    let parent: string | null = node.parent ?? null;
    if (parent !== null && (parent === name || !byName.has(parent) || visiting.has(parent))) parent = null;
    if (parent !== null) emit(parent);
    visiting.delete(name);
    done.add(name);
    plan.push({ name, parent, maxVoices: node.maxVoices ?? null });
  };
  for (const name of byName.keys()) emit(name);
  return plan;
}

/** A bus volume Babylon accepts: finite and not negative (the mixer already keeps it within 0..2). */
export function busVolume(gain: number | undefined): number {
  return gain !== undefined && Number.isFinite(gain) ? Math.max(0, gain) : 1;
}

/** `AudioBus` creation options for each planned bus (the backend resolves `parent` to the node), with its starting volume. */
export function busCreationSteps(plan: readonly BusPlan[], gains: ReadonlyMap<string, number>): { name: string; parent: string | null; options: { volume: number } }[] {
  return plan.map((b) => ({ name: b.name, parent: b.parent, options: { volume: busVolume(gains.get(b.name)) } }));
}

/** Babylon's distance models, by the engine's `Rolloff` names. */
export type DistanceModel = "linear" | "inverse" | "exponential";

/** The spatial settings of one sound, in Babylon's terms. `rolloffFactor` is always 1: the engine has no per-source rolloff factor. */
export interface SpatialParams {
  distanceModel: DistanceModel;
  minDistance: number;
  maxDistance: number;
  rolloffFactor: 1;
  panningModel: "HRTF" | "equalpower";
}

const MODELS: readonly Rolloff[] = ["linear", "inverse", "exponential"];

/**
 * `Attenuation` to Babylon spatial settings: the distance model from `rolloff` (unknown names are "inverse"),
 * `minDistance` as the reference distance, and `maxDistance` never below it nor zero (Web Audio refuses zero). The
 * panning model follows `audio.spatial`: HRTF unless the project asks for equal power.
 */
export function spatialParams(a: Attenuation, spatial: AudioSettings["spatial"] = "hrtf"): SpatialParams {
  const min = Number.isFinite(a.minDistance) ? Math.max(0, a.minDistance) : 1;
  const max = Number.isFinite(a.maxDistance) ? a.maxDistance : 10000;
  return {
    distanceModel: MODELS.includes(a.rolloff) ? a.rolloff : "inverse",
    minDistance: min,
    maxDistance: Math.max(min, max, 0.001),
    rolloffFactor: 1,
    panningModel: spatial === "equalPower" ? "equalpower" : "HRTF",
  };
}

/** The same settings as `createSoundAsync` options (a sound made with these is spatial from the start). */
export function spatialSoundOptions(p: SpatialParams) {
  return {
    spatialEnabled: true as const,
    spatialDistanceModel: p.distanceModel,
    spatialMinDistance: p.minDistance,
    spatialMaxDistance: p.maxDistance,
    spatialRolloffFactor: p.rolloffFactor,
    spatialPanningModel: p.panningModel,
  };
}

/** A pitch ratio as a playback rate: finite and above zero. */
export function playbackRate(pitch: number): number {
  return Number.isFinite(pitch) && pitch > 0 ? pitch : 1;
}

/** A sound volume Babylon accepts (finite, not negative). */
export function soundVolume(v: number): number {
  return Number.isFinite(v) ? Math.max(0, v) : 1;
}

/** The unit quaternion (x, y, z, w) that turns the engine's listener frame (forward -Z, up +Y) into `forward` and `up`. */
export function listenerQuaternion(forward: Vec3Like, up: Vec3Like): { x: number; y: number; z: number; w: number } {
  const norm = (v: Vec3Like, fallback: Vec3Like): Vec3Like => {
    const len = Math.hypot(v.x, v.y, v.z);
    return len > 1e-9 && Number.isFinite(len) ? { x: v.x / len, y: v.y / len, z: v.z / len } : fallback;
  };
  const cross = (a: Vec3Like, b: Vec3Like): Vec3Like => ({ x: a.y * b.z - a.z * b.y, y: a.z * b.x - a.x * b.z, z: a.x * b.y - a.y * b.x });
  const f = norm(forward, { x: 0, y: 0, z: -1 });
  let u = norm(up, { x: 0, y: 1, z: 0 });
  let rc = cross(f, u);
  if (Math.hypot(rc.x, rc.y, rc.z) < 1e-6) {
    // `up` is parallel to `forward`: any perpendicular will do.
    u = Math.abs(f.y) < 0.9 ? { x: 0, y: 1, z: 0 } : { x: 0, y: 0, z: 1 };
    rc = cross(f, u);
  }
  const r = norm(rc, { x: 1, y: 0, z: 0 });
  const y = cross(r, f);
  // Rotation matrix with columns r, y, -f.
  const m00 = r.x, m01 = y.x, m02 = -f.x;
  const m10 = r.y, m11 = y.y, m12 = -f.y;
  const m20 = r.z, m21 = y.z, m22 = -f.z;
  const trace = m00 + m11 + m22;
  if (trace > 0) {
    const s = Math.sqrt(trace + 1) * 2;
    return { w: s / 4, x: (m21 - m12) / s, y: (m02 - m20) / s, z: (m10 - m01) / s };
  }
  if (m00 > m11 && m00 > m22) {
    const s = Math.sqrt(1 + m00 - m11 - m22) * 2;
    return { w: (m21 - m12) / s, x: s / 4, y: (m01 + m10) / s, z: (m02 + m20) / s };
  }
  if (m11 > m22) {
    const s = Math.sqrt(1 + m11 - m00 - m22) * 2;
    return { w: (m02 - m20) / s, x: (m01 + m10) / s, y: s / 4, z: (m12 + m21) / s };
  }
  const s = Math.sqrt(1 + m22 - m00 - m11) * 2;
  return { w: (m10 - m01) / s, x: (m02 + m20) / s, y: (m12 + m21) / s, z: s / 4 };
}

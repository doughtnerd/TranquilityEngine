// The model import panel's LOD section as pure state (ADR 0446 §1, §7): the draft's `lod` edited as the rows change,
// and what the loaded model reports about each level it generated.
import { DEFAULT_LOD_SETTINGS, type LodLevelSettings, type LodSettings } from "../../../engine/scene/lod/types";
import type { ModelMesh } from "../../../engine/scene/models";

/** Levels a model can have beyond LOD0 in the panel (ADR 0446 §1: add and remove up to four). */
export const MAX_LOD_LEVELS = 4;
/** A mesh at least this big gets the "Generate LODs" hint (ADR 0446 §1). */
export const SUGGEST_LOD_TRIANGLES = 2000;
/** A level that reached more than this many times its target ratio stopped short. */
export const SHORT_FACTOR = 1.2;

const MIN_RATIO = 0.01;
const round = (n: number, digits = 4) => Math.round(n * 10 ** digits) / 10 ** digits;

/** The switch: off is no levels (`lod: null`), on is the defaults. */
export function setGenerate(lod: LodSettings | null, on: boolean): LodSettings | null {
  if (!on) return null;
  return lod ?? { ...DEFAULT_LOD_SETTINGS, levels: DEFAULT_LOD_SETTINGS.levels.map((l) => ({ ...l })) };
}

/** Ratios must lie in [0.01, 1) and fall level by level (the sidecar drops a level that doesn't); errors must be ≥ 0. */
function normalize(levels: readonly LodLevelSettings[]): LodLevelSettings[] {
  const out: LodLevelSettings[] = [];
  for (const l of levels) {
    const ceiling = out.length ? out[out.length - 1].ratio - MIN_RATIO : 0.99;
    const ratio = Math.max(MIN_RATIO, Math.min(Number.isFinite(l.ratio) ? l.ratio : 0.5, ceiling));
    const error = Number.isFinite(l.error) && l.error >= 0 ? l.error : 0;
    out.push({ ratio: round(ratio), error: round(error, 6) });
  }
  return out;
}

/** Change one level's ratio or error. The levels after it are pulled down if it now sits below them. */
export function editLevel(lod: LodSettings, index: number, change: Partial<LodLevelSettings>): LodSettings {
  if (index < 0 || index >= lod.levels.length) return lod;
  return { ...lod, levels: normalize(lod.levels.map((l, i) => (i === index ? { ...l, ...change } : l))) };
}

/** Whether another level can be added (at most four, and the last must leave room below it). */
export const canAddLevel = (lod: LodSettings): boolean => lod.levels.length < MAX_LOD_LEVELS && (lod.levels.at(-1)?.ratio ?? 1) > 2 * MIN_RATIO;

/** A new last level: half the last one's triangles, twice its error. */
export function addLevel(lod: LodSettings): LodSettings {
  if (!canAddLevel(lod)) return lod;
  const last = lod.levels.at(-1);
  const next = last ? { ratio: Math.max(MIN_RATIO, last.ratio / 2), error: Math.max(last.error * 2, 0.005) } : { ratio: 0.5, error: 0.01 };
  return { ...lod, levels: normalize([...lod.levels, next]) };
}

/** Remove a level; the last one stays (turn the switch off for none). */
export function removeLevel(lod: LodSettings, index: number): LodSettings {
  if (lod.levels.length <= 1 || index < 0 || index >= lod.levels.length) return lod;
  return { ...lod, levels: lod.levels.filter((_, i) => i !== index) };
}

/** A pixel-error value from the field: positive, else unchanged. */
export const setPixelError = (lod: LodSettings, value: number): LodSettings => (Number.isFinite(value) && value > 0 ? { ...lod, pixelError: value } : lod);

/** Triangles in a model's meshes at LOD0. */
export function modelTriangles(meshes: readonly ModelMesh[]): number {
  let n = 0;
  for (const m of meshes) n += m.lods ? m.lods.levels[0].triangles : m.data.indices.length / 3;
  return n;
}

/** Whether to hint at "Generate LODs": the switch is off and the model is big enough to gain from it. */
export const suggestsLods = (lod: LodSettings | null, triangles: number): boolean => lod === null && triangles >= SUGGEST_LOD_TRIANGLES;

/** What one generated level reached, summed over the model's meshes. */
export interface LevelReport {
  readonly level: number;
  /** The settings' target ratio for it. */
  readonly target: number;
  /** Triangles over LOD0's, as reached. */
  readonly reached: number;
  readonly triangles: number;
  /** The worst measured error over the meshes, as a fraction of the diagonal. */
  readonly error: number;
  /** Stopped short of its target: it reached more than `SHORT_FACTOR` times the target ratio. */
  readonly short: boolean;
}

/**
 * The generated levels of the loaded model against `lod`'s targets, or null when it has none. A mesh with fewer levels
 * than another counts its last at the deeper ones, as an `LODGroup` draws it.
 */
export function levelReports(meshes: readonly ModelMesh[], lod: LodSettings): LevelReport[] | null {
  const withLods = meshes.filter((m) => m.lods && m.lods.levels.length > 1);
  if (withLods.length === 0) return null;
  const count = Math.max(...withLods.map((m) => m.lods!.levels.length));
  const base = withLods.reduce((n, m) => n + m.lods!.levels[0].triangles, 0);
  const out: LevelReport[] = [];
  for (let i = 1; i < count; i++) {
    let triangles = 0, error = 0;
    for (const m of withLods) {
      const l = m.lods!.levels[Math.min(i, m.lods!.levels.length - 1)];
      triangles += l.triangles;
      error = Math.max(error, l.error);
    }
    const target = lod.levels[i - 1]?.ratio ?? 0;
    const reached = base > 0 ? triangles / base : 0;
    out.push({ level: i, target, reached, triangles, error, short: target > 0 && reached > target * SHORT_FACTOR });
  }
  return out;
}

/** The warning under the level list when any level stopped short, or null. */
export function shortWarning(reports: readonly LevelReport[] | null, lod: LodSettings): string | null {
  const short = reports?.filter((r) => r.short);
  if (!short?.length) return null;
  const which = short.map((r) => `LOD${r.level}`).join(", ");
  const hint = lod.permissive ? "Raise the error limit or lower the target." : "For a hard-edged mesh, turn on Permissive; otherwise raise the error limit.";
  return `${which} stopped short of the target. ${hint}`;
}

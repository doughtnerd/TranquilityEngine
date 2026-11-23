// The Scene settings panel's edits (ADR 0347 "Settings the Spatial screen shows are the project's"): `audio.json`'s HRTF
// voice count (`voices.hrtf`), the ambisonic bed distance (`bedBeyond`, null = beds by priority only), the global Doppler
// amount (`dopplerAmount` 0..2, shown in percent) and the occlusion materials. Applied through the Mixer's `audio.json`
// document (one document, one history). A built-in material can be changed but not renamed or removed (the parse adds
// the built-ins back); the default material can't be removed.
//
// Pure: no DOM, no signals.
import { MIX_LIMITS } from "../../../engine/audio/project/format";
import type { AudioProject } from "../../../engine/audio/project/types";
import { BUILTIN_MATERIALS, MATERIAL_LIMITS, MAX_MATERIALS, type OccluderMaterial } from "../../../engine/audio/occlusionMaterials";
import { uniqueName } from "../../../engine/core/uniqueName";
import { FIELDS } from "./inspectorFields";
import type { EditResult } from "./sceneEdits";

const withSettings = (p: AudioProject, settings: Partial<AudioProject["settings"]>): AudioProject => ({ ...p, settings: { ...p.settings, ...settings } });
const clamp = (v: number, [lo, hi]: readonly [number, number]) => Math.min(hi, Math.max(lo, v));

/** HRTF for the nearest `n` voices (a whole number in `voices.hrtf`'s range). */
export function setHrtfVoices(p: AudioProject, n: number): EditResult<AudioProject> {
  if (!Number.isFinite(n)) return { refused: "the HRTF voice count is a whole number" };
  const v = Math.round(clamp(n, [FIELDS.hrtf.min, FIELDS.hrtf.max]));
  return { next: withSettings(p, { voices: { ...p.settings.voices, hrtf: v } }) };
}

/** Sounds farther than `m` metres go to their bus's bed; null turns it off. */
export function setBedBeyond(p: AudioProject, m: number | null): EditResult<AudioProject> {
  if (m === null) return { next: withSettings(p, { bedBeyond: null }) };
  if (!Number.isFinite(m) || m <= 0) return { refused: "the bed distance is a number of metres above 0" };
  return { next: withSettings(p, { bedBeyond: Math.round(clamp(m, [FIELDS.bedBeyond.min, FIELDS.bedBeyond.max]) * 10) / 10 }) };
}

/** The Doppler amount in percent (0..200 → `dopplerAmount` 0..2). */
export function setDopplerPercent(p: AudioProject, percent: number): EditResult<AudioProject> {
  if (!Number.isFinite(percent)) return { refused: "the Doppler amount is a percentage" };
  const v = clamp(Math.round(percent) / 100, MIX_LIMITS.dopplerAmount);
  return { next: withSettings(p, { dopplerAmount: v }) };
}

export const dopplerPercent = (p: AudioProject): number => Math.round(p.settings.dopplerAmount * 100);

const withMaterials = (p: AudioProject, materials: OccluderMaterial[], defaultMaterial = p.settings.occlusion.defaultMaterial): AudioProject =>
  withSettings(p, { occlusion: { ...p.settings.occlusion, materials, defaultMaterial } });

export const isBuiltinMaterial = (name: string): boolean => BUILTIN_MATERIALS.some((m) => m.name === name);

/** A new material ("Material", numbered), starting from the default material's values. */
export function addMaterial(p: AudioProject): EditResult<{ project: AudioProject; name: string }> {
  const list = p.settings.occlusion.materials;
  if (list.length >= MAX_MATERIALS) return { refused: `the table holds at most ${MAX_MATERIALS} materials` };
  const from = list.find((m) => m.name === p.settings.occlusion.defaultMaterial) ?? list[0] ?? BUILTIN_MATERIALS[0]!;
  const name = uniqueName("Material", list.map((m) => m.name));
  return { next: { project: withMaterials(p, [...list, { name, transmissionDb: from.transmissionDb, cutoffHz: from.cutoffHz, wetOcclusion: from.wetOcclusion }]), name } };
}

/** Material `name` changed: its numbers clamped to the table's limits; a new name must be free and not a built-in's. */
export function editMaterial(p: AudioProject, name: string, patch: Partial<Pick<OccluderMaterial, "name" | "transmissionDb" | "cutoffHz" | "wetOcclusion">>): EditResult<AudioProject> {
  const list = p.settings.occlusion.materials;
  const at = list.findIndex((m) => m.name === name);
  if (at < 0) return { refused: `there's no material "${name}"` };
  const next = { ...list[at]! };
  if (patch.name !== undefined && patch.name !== name) {
    const clean = patch.name.trim();
    if (isBuiltinMaterial(name)) return { refused: `${name} is a built-in material: it can be changed but not renamed` };
    if (clean === "") return { refused: "a material needs a name" };
    if (list.some((m) => m.name === clean)) return { refused: `another material is named "${clean}"` };
    next.name = clean;
  }
  for (const key of ["transmissionDb", "cutoffHz", "wetOcclusion"] as const) {
    const v = patch[key];
    if (v === undefined) continue;
    if (!Number.isFinite(v)) return { refused: `${key} is a number` };
    next[key] = clamp(v, MATERIAL_LIMITS[key]);
  }
  const materials = list.map((m, i) => (i === at ? next : m));
  const def = p.settings.occlusion.defaultMaterial === name ? next.name : p.settings.occlusion.defaultMaterial;
  return { next: withMaterials(p, materials, def) };
}

/** Material `name` removed (not a built-in, not the default). Obstacles that name it then use the default. */
export function removeMaterial(p: AudioProject, name: string): EditResult<AudioProject> {
  if (isBuiltinMaterial(name)) return { refused: `${name} is a built-in material: it can be changed but not removed` };
  if (p.settings.occlusion.defaultMaterial === name) return { refused: `${name} is the default material` };
  const list = p.settings.occlusion.materials;
  if (!list.some((m) => m.name === name)) return { refused: `there's no material "${name}"` };
  return { next: withMaterials(p, list.filter((m) => m.name !== name)) };
}

/** The default material (what an occluder without one uses, and new obstacles get). */
export function setDefaultMaterial(p: AudioProject, name: string): EditResult<AudioProject> {
  if (!p.settings.occlusion.materials.some((m) => m.name === name)) return { refused: `there's no material "${name}"` };
  return { next: withMaterials(p, p.settings.occlusion.materials, name) };
}

/** "−30 dB · low-pass 800 Hz": a material in a line. */
export function materialText(m: OccluderMaterial): string {
  const lp = m.cutoffHz >= 20000 ? "no low-pass" : `low-pass ${m.cutoffHz >= 1000 ? `${(m.cutoffHz / 1000).toFixed(1)} kHz` : `${m.cutoffHz} Hz`}`;
  return `${m.transmissionDb.toFixed(0).replace("-", "−")} dB · ${lp}`;
}

/**
 * Internal (ADR 0162 M3, api-and-models §2.2): the occluder material table. `audio.occlusion.materials` parses into
 * the effective table here (the built-in rows, overridden or extended by the authored list). D2b adds the compile,
 * combine and cache steps (several hits on one ray: add dB, lowest cutoff, floor -60 dB) beside this parse.
 * Pure data and parsing: imports nothing from `settings.ts` (which imports this file).
 */

/** One material: what a ray hit through an `AudioOccluder` of this material does to a sound. */
export interface OccluderMaterial {
  /** Unique, non-empty. */
  name: string;
  /** Gain through the hit in dB, -80..0 (0 = none). */
  transmissionDb: number;
  /** Low-pass cutoff through the hit in Hz, 100..22000. At or above 20,000 it means off. */
  cutoffHz: number;
  /** How much of the wet (reverb send) path the hit removes, 0..1. */
  wetOcclusion: number;
  /** Ms to close, 0..2000. Absent: `audio.occlusion.smoothingMs`. */
  attackMs?: number;
  /** Ms to open, 0..2000. Absent: `audio.occlusion.smoothingMs`. */
  releaseMs?: number;
}

/** The ranges of §2.2, `[min, max]`. */
export const MATERIAL_LIMITS = {
  transmissionDb: [-80, 0],
  cutoffHz: [100, 22000],
  wetOcclusion: [0, 1],
  attackMs: [0, 2000],
  releaseMs: [0, 2000],
} as const;

/** At most this many materials in the effective table (built-ins included). */
export const MAX_MATERIALS = 32;

/** The material `audio.occlusion.defaultMaterial` names when absent. */
export const DEFAULT_MATERIAL_NAME = "concrete";

/** §2.2 defaults, starting points for the listening pass. `none` is the pass-through row. */
export const BUILTIN_MATERIALS: readonly Readonly<OccluderMaterial>[] = [
  { name: "none", transmissionDb: 0, cutoffHz: 22000, wetOcclusion: 1 },
  { name: "cloth", transmissionDb: -4, cutoffHz: 8000, wetOcclusion: 0.3 },
  { name: "glass", transmissionDb: -8, cutoffHz: 5000, wetOcclusion: 0.4 },
  { name: "wood", transmissionDb: -12, cutoffHz: 2500, wetOcclusion: 0.5 },
  { name: "metal", transmissionDb: -25, cutoffHz: 1200, wetOcclusion: 0.6 },
  { name: "concrete", transmissionDb: -30, cutoffHz: 800, wetOcclusion: 0.6 },
];

/** A fresh copy of the built-in table (callers may mutate it). */
export const builtinMaterials = (): OccluderMaterial[] => BUILTIN_MATERIALS.map((m) => ({ ...m }));

/**
 * Parse `audio.occlusion.materials` (`raw`, `undefined` when absent) into the effective table: the built-ins in
 * order, an authored entry named like a built-in replacing it in place, others appended. Lenient, never throws, each
 * repair a line in `problems` prefixed by `key` (e.g. `audio.occlusion.materials`). L-A6b.
 * Rules: not a list gives the built-ins plus a problem; more than `MAX_MATERIALS` authored entries: the rest ignored
 * plus a problem; an entry that is not an object or has no non-empty string name: dropped plus a problem; a repeated
 * name: dropped plus a problem (the first counts); a numeric field is clamped to `MATERIAL_LIMITS` (a problem when
 * clamped), a non-number one takes the same-named built-in's value, else `concrete`'s, plus a problem;
 * `attackMs`/`releaseMs` absent stay absent, a non-number one is dropped plus a problem. The effective table is cut to
 * `MAX_MATERIALS` (a problem).
 */
export function parseOccluderMaterials(raw: unknown, key: string, problems: string[]): OccluderMaterial[] {
  void raw; void key; void problems; // L-A6b: the stub returns the built-ins so the suite stays green until the leaf lands
  return builtinMaterials();
}

/**
 * `audio.occlusion.defaultMaterial`: `raw` undefined gives "concrete" when the table has it (else the first row), no
 * problem; a name in `table` is kept; anything else (unknown name, non-string) gives the table's first material plus a
 * problem `${key}: unknown material "<raw>"; using "<first>".`. L-A6b.
 */
export function resolveDefaultMaterial(raw: unknown, table: readonly OccluderMaterial[], key: string, problems: string[]): string {
  void raw; void table; void key; void problems; // L-A6b stub
  return DEFAULT_MATERIAL_NAME;
}

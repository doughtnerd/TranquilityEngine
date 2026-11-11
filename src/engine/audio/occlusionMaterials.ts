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
  const table = builtinMaterials();
  if (raw === undefined) return table;
  if (!Array.isArray(raw)) {
    problems.push(`${key} must be a list; using the built-in materials.`);
    return table;
  }
  if (raw.length > MAX_MATERIALS) problems.push(`${key}: at most ${MAX_MATERIALS} materials; the rest are ignored.`);
  const concrete = BUILTIN_MATERIALS.find((m) => m.name === DEFAULT_MATERIAL_NAME) ?? BUILTIN_MATERIALS[0];
  const at = new Map(table.map((m, i) => [m.name, i] as const));
  const seen = new Set<string>();
  raw.slice(0, MAX_MATERIALS).forEach((entry: unknown, i) => {
    const where = `${key}[${i}]`;
    if (!isRecord(entry) || typeof entry.name !== "string" || entry.name.trim() === "") {
      problems.push(`${where}: must be an object with a non-empty name; dropped.`);
      return;
    }
    const name = entry.name;
    if (seen.has(name)) return void problems.push(`${where}: another material is already named "${name}"; dropped.`);
    seen.add(name);
    const base = BUILTIN_MATERIALS.find((b) => b.name === name) ?? concrete;
    const m: OccluderMaterial = {
      name,
      transmissionDb: materialNumber(entry.transmissionDb, `${where}.transmissionDb`, MATERIAL_LIMITS.transmissionDb, base.transmissionDb, problems),
      cutoffHz: materialNumber(entry.cutoffHz, `${where}.cutoffHz`, MATERIAL_LIMITS.cutoffHz, base.cutoffHz, problems),
      wetOcclusion: materialNumber(entry.wetOcclusion, `${where}.wetOcclusion`, MATERIAL_LIMITS.wetOcclusion, base.wetOcclusion, problems),
    };
    const attackMs = materialNumber(entry.attackMs, `${where}.attackMs`, MATERIAL_LIMITS.attackMs, undefined, problems);
    if (attackMs !== undefined) m.attackMs = attackMs;
    const releaseMs = materialNumber(entry.releaseMs, `${where}.releaseMs`, MATERIAL_LIMITS.releaseMs, undefined, problems);
    if (releaseMs !== undefined) m.releaseMs = releaseMs;
    const existing = at.get(name);
    if (existing !== undefined) table[existing] = m;
    else {
      at.set(name, table.length);
      table.push(m);
    }
  });
  if (table.length > MAX_MATERIALS) {
    problems.push(`${key}: the table holds at most ${MAX_MATERIALS} materials; the rest are dropped.`);
    table.length = MAX_MATERIALS;
  }
  return table;
}

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/**
 * One numeric field of an authored material, clamped to `limits` (a problem when clamped). `undefined` gives
 * `fallback` with no problem. A non-number or non-finite value gives `fallback` plus a problem saying so; with no
 * `fallback` (attackMs/releaseMs) the value is dropped instead.
 */
function materialNumber(raw: unknown, key: string, limits: readonly [number, number], fallback: number, problems: string[]): number;
function materialNumber(raw: unknown, key: string, limits: readonly [number, number], fallback: undefined, problems: string[]): number | undefined;
function materialNumber(
  raw: unknown,
  key: string,
  limits: readonly [number, number],
  fallback: number | undefined,
  problems: string[],
): number | undefined {
  const [min, max] = limits;
  if (raw === undefined) return fallback;
  if (typeof raw !== "number" || !Number.isFinite(raw)) {
    problems.push(`${key}: must be a number from ${min} to ${max}; ${fallback === undefined ? "dropped" : `using ${fallback}`}.`);
    return fallback;
  }
  const clamped = Math.min(max, Math.max(min, raw));
  if (clamped !== raw) problems.push(`${key}: ${raw} is outside ${min}..${max}; using ${clamped}.`);
  return clamped;
}

/**
 * `audio.occlusion.defaultMaterial`: `raw` undefined gives "concrete" when the table has it (else the first row), no
 * problem; a name in `table` is kept; anything else (unknown name, non-string) gives "concrete" (else the table's first
 * material) plus a problem `${key}: unknown material "<raw>"; using "<fallback>".`. L-A6b. Coordinator ruling: the
 * fallback is "concrete", not the first row, because "none" would silently disable occlusion.
 */
export function resolveDefaultMaterial(raw: unknown, table: readonly OccluderMaterial[], key: string, problems: string[]): string {
  const fallback = table.some((m) => m.name === DEFAULT_MATERIAL_NAME) ? DEFAULT_MATERIAL_NAME : (table[0]?.name ?? DEFAULT_MATERIAL_NAME);
  if (raw === undefined) return fallback;
  if (typeof raw === "string" && table.some((m) => m.name === raw)) return raw;
  const shown = typeof raw === "string" ? raw : JSON.stringify(raw) ?? String(raw);
  problems.push(`${key}: unknown material "${shown}"; using "${fallback}".`);
  return fallback;
}

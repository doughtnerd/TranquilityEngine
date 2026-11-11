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

// --- D2b (ADR 0162 §2.2, §1.5): compile, combine, cache ---------------------------------------------------------------

/** The top of the cutoff range: a transparent hit, and where `openness` blends a cutoff to (log scale). */
export const CUTOFF_OPEN_HZ = 22000;
/** A cutoff at or above this means the low-pass is off. */
export const CUTOFF_OFF_HZ = 20000;
/** Several hits on one ray never take more than this many dB (§2.2). */
export const COMBINED_FLOOR_DB = -60;

/** What one ray hit costs: the gain through it in dB (<= 0), the low-pass cutoff in Hz, and the wet (reverb send) fraction it removes, 0..1. */
export interface HitCost {
  transmissionDb: number;
  cutoffHz: number;
  wetOcclusion: number;
}

/** A `HitCost` that also says which material produced it (debug rows). */
export interface ResolvedHit extends HitCost {
  material: string;
}

/** The per-wall part of an `AudioOccluder` the compile needs (a structural subset of the component). */
export interface OccluderParams {
  /** Material name; empty is the project's default material. */
  material: string;
  transmissionTrimDb: number;
  cutoffScale: number;
  /** 0 closed .. 1 open (transparent). */
  openness: number;
}

const clamp = (v: number, lo: number, hi: number) => (v < lo ? lo : v > hi ? hi : v);
const OPEN_LOG = Math.log(CUTOFF_OPEN_HZ);

/** A hit that changes nothing. Writes into `out`. */
export function setTransparent(out: HitCost): HitCost {
  out.transmissionDb = 0;
  out.cutoffHz = CUTOFF_OPEN_HZ;
  out.wetOcclusion = 0;
  return out;
}

/**
 * Compile one hit into `out` (no allocation): the material's `transmissionDb` plus `trimDb`, its cutoff times
 * `cutoffScale` (clamped to 100..22000), its `wetOcclusion`; then `openness` (clamped 0..1) blends dB toward 0, the
 * cutoff toward 22000 in log scale, and the wet fraction toward 0 (1 is fully transparent). An undefined material and
 * the `none` row are transparent whatever the trims. Non-finite trims count as 0 and 1.
 */
export function compileHit(material: Readonly<OccluderMaterial> | undefined, trimDb: number, cutoffScale: number, openness: number, out: HitCost): HitCost {
  if (!material || material.name === "none") return setTransparent(out);
  const trim = Number.isFinite(trimDb) ? trimDb : 0;
  const scale = Number.isFinite(cutoffScale) && cutoffScale > 0 ? cutoffScale : 1;
  const open = Number.isFinite(openness) ? clamp(openness, 0, 1) : 0;
  const closed = 1 - open;
  const db = clamp(material.transmissionDb + trim, MATERIAL_LIMITS.transmissionDb[0], 0);
  const hz = clamp(material.cutoffHz * scale, MATERIAL_LIMITS.cutoffHz[0], CUTOFF_OPEN_HZ);
  out.transmissionDb = db * closed;
  out.cutoffHz = open === 0 ? hz : Math.exp(Math.log(hz) * closed + OPEN_LOG * open);
  out.wetOcclusion = material.wetOcclusion * closed;
  return out;
}

/**
 * The cost of several hits on one ray (§2.2): dB add (floored at -60), the cutoff is the lowest, wet fractions combine
 * as `1 - prod(1 - w)` (each wall removes its share of what is left). Reuse one accumulator: `reset()`, `add()` per hit.
 */
export class HitAccumulator implements HitCost {
  transmissionDb = 0;
  cutoffHz = CUTOFF_OPEN_HZ;
  wetOcclusion = 0;
  /** Hits added since `reset()`. */
  hits = 0;
  reset(): this {
    this.transmissionDb = 0;
    this.cutoffHz = CUTOFF_OPEN_HZ;
    this.wetOcclusion = 0;
    this.hits = 0;
    return this;
  }
  add(hit: HitCost): this {
    this.hits++;
    this.transmissionDb = Math.max(COMBINED_FLOOR_DB, this.transmissionDb + hit.transmissionDb);
    if (hit.cutoffHz < this.cutoffHz) this.cutoffHz = hit.cutoffHz;
    this.wetOcclusion = 1 - (1 - this.wetOcclusion) * (1 - hit.wetOcclusion);
    return this;
  }
}

/** Linear gain of `db` (0 dB is 1). */
export const dbToGain = (db: number): number => Math.pow(10, db / 20);

/** The node shape the cache needs (a `GameObject`): a collider's owner. */
export interface OcclusionNode {
  readonly name: string;
  readonly parent: OcclusionNode | null;
}

interface CacheEntry {
  /** The occluder that applied when the entry was made (null: none up the chain, the default material). */
  occluder: OccluderParams | null;
  /** What the base was compiled from: a change to any of these recompiles it. */
  material: string;
  trim: number;
  scale: number;
  /** The material compiled with trim and scale at openness 0. */
  baseDb: number;
  baseHz: number;
  baseWet: number;
  /** Resolved material name ("none" included). */
  name: string;
}

/**
 * Cache of compiled hits per collider node: node -> nearest occluder and its material, compiled once (ADR 0162 §1.5,
 * §2.2). `find` is the nearest-occluder lookup (the plugin's `nearestOccluder`). `configure` (settings change)
 * and `invalidate` (an occluder added, removed, enabled, disabled or a node reparented) drop every entry; edits to an
 * occluder's material, trims or scale are noticed per lookup, and `openness` is applied live (a door script moves it
 * every frame). `resolve` allocates nothing on a cached node.
 */
export class OccluderCache<N extends OcclusionNode = OcclusionNode> {
  private readonly entries = new Map<N, CacheEntry>();
  private table = new Map<string, Readonly<OccluderMaterial>>();
  private defaultName = DEFAULT_MATERIAL_NAME;

  constructor(
    private readonly find: (node: N) => OccluderParams | null,
    table: readonly OccluderMaterial[] = BUILTIN_MATERIALS,
    defaultMaterial: string = DEFAULT_MATERIAL_NAME,
  ) {
    this.configure(table, defaultMaterial);
  }

  /** New settings (`audio.occlusion.materials`, `defaultMaterial`): the cache is dropped. */
  configure(table: readonly OccluderMaterial[], defaultMaterial: string): void {
    this.table = new Map(table.map((m) => [m.name, m] as const));
    this.defaultName = defaultMaterial;
    this.entries.clear();
  }

  /** Drop every entry (component added/removed/enabled, hierarchy change; D2a also calls it every 120 frames). */
  invalidate(): void {
    this.entries.clear();
  }

  /** Cached node count (tests, debug). */
  get size(): number {
    return this.entries.size;
  }

  /**
   * What a hit on a collider of `node` costs, into `out` (`out.material` is the material's name): the nearest enabled
   * occluder up the parent chain applies, else the project's default material with no trims and openness 0.
   */
  resolve(node: N, out: ResolvedHit): ResolvedHit {
    let e = this.entries.get(node);
    if (!e) {
      e = { occluder: this.find(node), material: "\0", trim: NaN, scale: NaN, baseDb: 0, baseHz: CUTOFF_OPEN_HZ, baseWet: 0, name: "" };
      this.entries.set(node, e);
    }
    const o = e.occluder;
    const material = o ? o.material : "";
    const trim = o ? o.transmissionTrimDb : 0;
    const scale = o ? o.cutoffScale : 1;
    if (material !== e.material || trim !== e.trim || scale !== e.scale) {
      e.material = material;
      e.trim = trim;
      e.scale = scale;
      e.name = material !== "" && this.table.has(material) ? material : this.defaultName;
      compileHit(this.table.get(e.name), trim, scale, 0, out);
      e.baseDb = out.transmissionDb;
      e.baseHz = out.cutoffHz;
      e.baseWet = out.wetOcclusion;
    }
    out.material = e.name;
    const open = o ? o.openness : 0;
    if (!(open > 0) || e.name === "none") {
      out.transmissionDb = e.baseDb;
      out.cutoffHz = e.baseHz;
      out.wetOcclusion = e.baseWet;
      return out;
    }
    // Openness blends the base (already trimmed and scaled) the same way `compileHit` does.
    const k = clamp(open, 0, 1), closed = 1 - k;
    out.transmissionDb = e.baseDb * closed;
    out.cutoffHz = Math.exp(Math.log(e.baseHz) * closed + OPEN_LOG * k);
    out.wetOcclusion = e.baseWet * closed;
    return out;
  }
}

/** The debug label of a collider (`AudioDebugInfo.voices[].occlusion.collider`): its node's name, "(unnamed)", or null without a node. */
export function colliderLabel(node: { readonly name: string } | null | undefined): string | null {
  return node ? node.name || "(unnamed)" : null;
}

/**
 * Why occlusion is inert in a World, for `AudioDebugInfo.occlusion.note` (§1.6): "" when a 3D physics service runs,
 * "2D world" when only a 2D one does, else "no 3D physics service". Inputs are whether the World's `myco.physics3d` /
 * `myco.physics2d` services are running.
 */
export function occlusionNote(has3dService: boolean, has2dService: boolean): string {
  if (has3dService) return "";
  return has2dService ? "2D world" : "no 3D physics service";
}

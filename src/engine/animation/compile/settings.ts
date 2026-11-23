/**
 * Clip compression settings and their inheritance (ADR 0371 "Compression": "Settings inherit as audio export settings
 * do (audio 0351): project profile → folder rule → model sidecar per clip → platform override").
 *
 * `project.json`'s `animation.compression` holds the project's profile, its platform overrides and folder rules:
 *
 * ```jsonc
 * "animation": {
 *   "compression": {
 *     "error": 0.1,                    // mm: object-space error bound for bone tracks (default 0.1)
 *     "maxRate": 30,                   // Hz: clips sampled faster are resampled to this (default: none, the clip's rate)
 *     "propertyError": 0.0001,         // absolute error bound for property tracks (default 1e-4)
 *     "platforms": { "android": { "error": 0.5 } },
 *     "rules": [                       // first match wins; globs as in .gitignore (audio's `pathGlob`)
 *       { "path": "anims/crowd/**", "error": 1, "maxRate": 15, "platforms": { "web": { "maxRate": 10 } } }
 *     ]
 *   }
 * }
 * ```
 *
 * A model clip's sidecar entry (`animation.clips.<take>[i].compression`, T14) is the nearest level, with its own
 * `platforms`. **Resolution** (`resolveCompression`), each key on its own, first hit wins: the sidecar's
 * `platforms.<platform>`, the sidecar; the first matching rule's `platforms.<platform>`, the rule; the project's
 * `platforms.<platform>`, the project; the built-in default. As audio's encoding settings (0351 §2), each level's
 * platform override sits just above that level.
 *
 * Parsing is lenient (ADR 0306): a bad value is dropped with one problem line, nothing throws, and the limits are
 * declared once (`COMPRESSION_LIMITS`). Pure. Internal: not public API.
 */
import type { ImportPlatform } from "../../scene/importSettings";
import { compileGlob } from "../../audio/encoding/pathGlob";
import { isRecord, LenientReader, type JsonRecord } from "../shared";
import { TRACK_LIMITS } from "../tracks";

/** @internal The platforms an override can name (`ImportPlatform`). */
export const COMPRESSION_PLATFORMS: readonly ImportPlatform[] = ["web", "desktop", "android"];

/** @internal Limits of the settings, declared once (ADR 0306). `error` in mm. */
export const COMPRESSION_LIMITS = Object.freeze({ error: { min: 0.001, max: 1000 }, maxRate: { min: TRACK_LIMITS.minRate, max: TRACK_LIMITS.maxRate }, propertyError: { min: 1e-7, max: 1 }, rules: 256 });

/** @internal The keys each level may set. */
export const COMPRESSION_KEYS = ["error", "maxRate", "propertyError"] as const;
export type CompressionKey = (typeof COMPRESSION_KEYS)[number];

/** @internal Values one level sets (absent: inherited). */
export interface CompressionValues {
  /** Object-space error bound for bone tracks, millimetres. */
  readonly error?: number;
  /** Resample clips faster than this, Hz. */
  readonly maxRate?: number;
  /** Absolute error bound for property tracks. */
  readonly propertyError?: number;
}

/** @internal A level with its per-platform overrides. */
export interface CompressionLevel extends CompressionValues {
  readonly platforms?: Readonly<Partial<Record<ImportPlatform, CompressionValues>>>;
}

/** @internal A folder rule. */
export interface CompressionRule extends CompressionLevel {
  readonly path: string;
}

/** @internal `animation.compression`: the project profile and its rules. */
export interface AnimationCompressionSettings extends CompressionLevel {
  readonly rules: readonly CompressionRule[];
}

/** @internal `project.json`'s `animation` section. */
export interface AnimationProjectSettings {
  readonly compression: AnimationCompressionSettings;
}

/** @internal What a clip compiles with. */
export interface ResolvedCompression {
  readonly error: number;
  /** null: the clip's own rate. */
  readonly maxRate: number | null;
  readonly propertyError: number;
}

/** @internal Where a resolved value came from. */
export type CompressionOrigin =
  | { readonly level: "sidecar"; readonly platform: ImportPlatform | null }
  | { readonly level: "rule"; readonly index: number; readonly path: string; readonly platform: ImportPlatform | null }
  | { readonly level: "project"; readonly platform: ImportPlatform | null }
  | { readonly level: "builtin" };

/** @internal The built-in defaults (ADR 0371: 0.1 mm; property tracks 1e-4; the clip's rate). */
export const BUILTIN_COMPRESSION: ResolvedCompression = Object.freeze({ error: 0.1, maxRate: null, propertyError: 1e-4 });

/** @internal A project with no `animation` section. */
export const defaultAnimationProjectSettings = (): AnimationProjectSettings => ({ compression: { rules: [] } });

function readValues(r: LenientReader, o: JsonRecord, where: string): CompressionValues {
  const out: { -readonly [K in CompressionKey]?: number } = {};
  const L = COMPRESSION_LIMITS;
  if (o.error !== undefined) out.error = r.num(o.error, `${where}.error`, BUILTIN_COMPRESSION.error, L.error.min, L.error.max);
  if (o.maxRate !== undefined && o.maxRate !== null) out.maxRate = r.num(o.maxRate, `${where}.maxRate`, 30, L.maxRate.min, L.maxRate.max);
  if (o.propertyError !== undefined) out.propertyError = r.num(o.propertyError, `${where}.propertyError`, BUILTIN_COMPRESSION.propertyError, L.propertyError.min, L.propertyError.max);
  return out;
}

/** @internal One level (values and `platforms`) read leniently; unknown platforms are dropped with a problem. */
export function readCompressionLevel(r: LenientReader, o: JsonRecord, where: string): CompressionLevel {
  const values = readValues(r, o, where);
  const p = r.record(o.platforms, `${where}.platforms`);
  if (!p) return values;
  const platforms: Partial<Record<ImportPlatform, CompressionValues>> = {};
  for (const [name, v] of Object.entries(p)) {
    if (!(COMPRESSION_PLATFORMS as readonly string[]).includes(name)) {
      r.problem(`${where}.platforms.${name}`, `isn't a platform (${COMPRESSION_PLATFORMS.join(", ")}); ignored.`);
      continue;
    }
    const rec = r.record(v, `${where}.platforms.${name}`);
    if (rec) platforms[name as ImportPlatform] = readValues(r, rec, `${where}.platforms.${name}`);
  }
  return Object.keys(platforms).length ? { ...values, platforms } : values;
}

/** @internal `project.json`'s `animation` value, leniently (absent: the defaults). Problems start with `animation`. */
export function parseAnimationProjectSettings(raw: unknown): { readonly settings: AnimationProjectSettings; readonly problems: string[] } {
  const problems: string[] = [];
  const r = new LenientReader(problems);
  if (raw === undefined) return { settings: defaultAnimationProjectSettings(), problems };
  const o = r.record(raw, "animation");
  const c = o ? r.record(o.compression, "animation.compression") : null;
  if (!c) return { settings: defaultAnimationProjectSettings(), problems };
  const base = readCompressionLevel(r, c, "animation.compression");
  const rules: CompressionRule[] = [];
  const list = r.list(c.rules, "animation.compression.rules");
  if (list.length > COMPRESSION_LIMITS.rules) r.problem("animation.compression.rules", `at most ${COMPRESSION_LIMITS.rules} rules; the rest are dropped.`);
  list.slice(0, COMPRESSION_LIMITS.rules).forEach((raw, i) => {
    const where = `animation.compression.rules.${i}`;
    const rec = r.record(raw, where);
    if (!rec) return;
    if (typeof rec.path !== "string" || rec.path.trim() === "") {
      r.problem(`${where}.path`, "a rule needs a path pattern; the rule is dropped.");
      return;
    }
    rules.push({ path: rec.path, ...readCompressionLevel(r, rec, where) });
  });
  return { settings: { compression: { ...base, rules } }, problems };
}

/** @internal The section as JSON (absent members left out; an all-default section is `undefined`). */
export function animationProjectSettingsToJson(s: AnimationProjectSettings): JsonRecord | undefined {
  const level = (l: CompressionLevel): JsonRecord => {
    const out: JsonRecord = {};
    for (const k of COMPRESSION_KEYS) if (l[k] !== undefined) out[k] = l[k];
    if (l.platforms && Object.keys(l.platforms).length) out.platforms = { ...l.platforms };
    return out;
  };
  const c: JsonRecord = level(s.compression);
  if (s.compression.rules.length) c.rules = s.compression.rules.map((rule) => ({ path: rule.path, ...level(rule) }));
  return Object.keys(c).length ? { compression: c } : undefined;
}

/** Compiled folder rules, once per rule list. */
const matchers = new WeakMap<readonly CompressionRule[], ((path: string) => boolean)[]>();

function firstRule(rules: readonly CompressionRule[], path: string): number {
  let m = matchers.get(rules);
  if (!m) {
    m = rules.map((rule) => {
      const g = compileGlob(rule.path);
      return (p: string) => g.matches(p);
    });
    matchers.set(rules, m);
  }
  return m.findIndex((f) => f(path));
}

/** @internal What to resolve: the clip's file (a model's for a model clip) and its sidecar level, if any. */
export interface CompressionSubject {
  readonly path: string;
  readonly sidecar: CompressionLevel | null;
}

/** @internal A clip's settings on `platform` with each value's origin (see the module comment). */
export function resolveCompression(
  subject: CompressionSubject,
  platform: ImportPlatform,
  project: AnimationProjectSettings,
): { readonly settings: ResolvedCompression; readonly origins: Readonly<Record<CompressionKey, CompressionOrigin>> } {
  const layers: { values: CompressionValues; origin: CompressionOrigin }[] = [];
  const add = (level: CompressionLevel | null | undefined, origin: (platform: ImportPlatform | null) => CompressionOrigin) => {
    if (!level) return;
    const p = level.platforms?.[platform];
    if (p) layers.push({ values: p, origin: origin(platform) });
    layers.push({ values: level, origin: origin(null) });
  };
  add(subject.sidecar, (p) => ({ level: "sidecar", platform: p }));
  const c = project.compression;
  const i = firstRule(c.rules, subject.path);
  if (i >= 0) add(c.rules[i], (p) => ({ level: "rule", index: i, path: c.rules[i].path, platform: p }));
  add(c, (p) => ({ level: "project", platform: p }));
  const settings: { -readonly [K in keyof ResolvedCompression]: ResolvedCompression[K] } = { ...BUILTIN_COMPRESSION };
  const origins = {} as Record<CompressionKey, CompressionOrigin>;
  for (const key of COMPRESSION_KEYS) {
    const hit = layers.find((l) => l.values[key] !== undefined);
    if (hit) (settings as Record<CompressionKey, number | null>)[key] = hit.values[key]!;
    origins[key] = hit ? hit.origin : { level: "builtin" };
  }
  return { settings, origins };
}

/** @internal The settings section of a raw `project.json` value (its `animation` key, parsed). */
export function animationSettingsOf(projectJson: unknown): AnimationProjectSettings {
  return parseAnimationProjectSettings(isRecord(projectJson) ? projectJson.animation : undefined).settings;
}

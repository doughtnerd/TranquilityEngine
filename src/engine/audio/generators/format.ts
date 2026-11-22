/**
 * Generators (ADR 0346 §1): parse and write `*.generator.json` (`myco.generator@1`) and embedded generators (the same
 * object without `format`). The shapes are the contract in `types.ts`; the parameters are the catalogue's.
 *
 * The parse is lenient (ADR 0306: bad values fall back to defaults with one problem line; it never throws) and
 * canonical: every parameter of the kind is filled (missing ones take their defaults), values out of range are clamped
 * by the catalogue's limits, a choice is read as its option's name (or index) and kept as its index, an unknown
 * parameter is dropped, and a preset another kind owns is dropped.
 *
 * `generatorToJson` writes a stable key order, leaving out parameters at their defaults (choices as their names), so
 * `parseGenerator(generatorToJson(x)).generator` deep-equals `x` for any parsed `x`.
 *
 * Pure; no plugin, no DOM.
 */
import { isFiniteNumber, isRecord, LenientReader, type JsonRecord } from "../lenientRead";
import { isBlipPreset } from "./blipPresets";
import { choiceIndex, defaultGeneratorParams, generatorSpec, GENERATOR_CATALOGUE } from "./catalogue";
import { MAX_SEED } from "./random";
import { isSynthPreset } from "./synthPresets";
import { GENERATOR_FORMAT, GENERATOR_KINDS, GENERATOR_SUFFIX, type GeneratorAsset, type GeneratorBody, type GeneratorKind, type GeneratorParse } from "./types";

/** True for a generator asset path. */
export const isGeneratorPath = (path: string): boolean => path.toLowerCase().endsWith(GENERATOR_SUFFIX);

/** True when `preset` is one of `kind`'s presets (blip and synth have them). */
export const isPresetOf = (kind: GeneratorKind, preset: unknown): boolean => (kind === "blip" ? isBlipPreset(preset) : kind === "synth" ? isSynthPreset(preset) : false);

/** A generator body of `kind` with every parameter at its default. */
export const emptyGeneratorBody = (kind: GeneratorKind = "oscillator"): GeneratorBody => ({ kind, params: defaultGeneratorParams(kind), seed: null, vary: 0 });

/** A generator asset of `kind` with every parameter at its default. */
export const emptyGenerator = (kind: GeneratorKind = "oscillator"): GeneratorAsset => ({ format: GENERATOR_FORMAT, ...emptyGeneratorBody(kind) });

function readBody(raw: JsonRecord, where: string, problems: string[]): GeneratorBody {
  const r = new LenientReader(problems);
  const at = (k: string) => (where ? `${where}.${k}` : k);
  if (raw.kind === undefined) r.problem(at("kind"), 'missing; using "oscillator".');
  const kind = raw.kind === undefined ? "oscillator" : r.pick(raw.kind, at("kind"), GENERATOR_KINDS, "oscillator");
  const out = emptyGeneratorBody(kind);
  const spec = GENERATOR_CATALOGUE[kind];
  const params = r.record(raw.params, at("params")) ?? {};
  for (const q of spec.params) {
    const v = params[q.name];
    const w = `${at("params")}.${q.name}`;
    if (q.choices && typeof v === "string") {
      const i = choiceIndex(q, v);
      if (i >= 0) out.params[q.name] = i;
      else r.problem(w, `must be one of ${(q.choiceIds ?? []).join(", ")}; using "${q.choiceIds?.[q.default]}".`);
      continue;
    }
    const n = r.num(v, w, q.default, q.min, q.max);
    out.params[q.name] = q.choices ? Math.round(n) : n;
  }
  for (const name of Object.keys(params)) {
    if (!spec.params.some((q) => q.name === name)) r.problem(`${at("params")}.${name}`, `${spec.label} has no parameter "${name}"; dropped.`);
  }
  if (raw.seed !== undefined && raw.seed !== null) {
    if (isFiniteNumber(raw.seed) && Number.isInteger(raw.seed) && raw.seed >= 0 && raw.seed <= MAX_SEED) out.seed = raw.seed;
    else r.problem(at("seed"), `must be a whole number 0..${MAX_SEED} or null; drawn per trigger.`);
  }
  if (raw.preset !== undefined) {
    if (isPresetOf(kind, raw.preset)) out.preset = raw.preset as string;
    else r.problem(at("preset"), `${JSON.stringify(raw.preset)} isn't a ${spec.label} preset; dropped.`);
  }
  out.vary = r.num(raw.vary, at("vary"), 0, 0, 1);
  const note = r.optStr(raw.note, at("note"));
  if (note) out.note = note;
  return out;
}

/** An embedded generator (a body without `format`) from JSON, leniently. `where` prefixes problem lines. */
export function parseGeneratorBody(raw: unknown, where: string, problems: string[]): GeneratorBody {
  if (!isRecord(raw)) {
    problems.push(`${where || "generator"}: a generator must be an object; using a default oscillator.`);
    return emptyGeneratorBody();
  }
  return readBody(raw, where, problems);
}

/**
 * A `*.generator.json` value, leniently: never throws; a wrong or missing `format` is a problem but the rest is still
 * read. Problem lines start with `path` when given.
 */
export function parseGenerator(raw: unknown, path?: string): GeneratorParse {
  const problems: string[] = [];
  let body: GeneratorBody;
  if (!isRecord(raw)) {
    problems.push("a generator must be a JSON object; using a default oscillator.");
    body = emptyGeneratorBody();
  } else {
    if (raw.format !== GENERATOR_FORMAT) {
      problems.push(`format: expected "${GENERATOR_FORMAT}"${raw.format === undefined ? "" : `, found ${JSON.stringify(raw.format)}`}; reading it anyway.`);
    }
    body = readBody(raw, "", problems);
  }
  return { generator: { format: GENERATOR_FORMAT, ...body }, problems: path ? problems.map((p) => `${path}: ${p}`) : problems };
}

// --- write -----------------------------------------------------------------------------------------------------------

/** The parameters that differ from their defaults, in catalogue order; a choice as its option's name. */
function paramsToJson(kind: GeneratorKind, params: Readonly<Record<string, number>>): JsonRecord {
  const out: JsonRecord = {};
  for (const q of generatorSpec(kind).params) {
    const v = params[q.name];
    if (!isFiniteNumber(v) || v === q.default) continue;
    out[q.name] = q.choiceIds ? (q.choiceIds[v] ?? v) : v;
  }
  return out;
}

/** A generator body as JSON (no `format`): stable key order, defaults left out. */
export function generatorBodyToJson(g: GeneratorBody): JsonRecord {
  const out: JsonRecord = { kind: g.kind };
  const params = paramsToJson(g.kind, g.params);
  if (Object.keys(params).length) out.params = params;
  if (g.seed !== null) out.seed = g.seed;
  if (g.preset !== undefined) out.preset = g.preset;
  if (g.vary !== 0) out.vary = g.vary;
  if (g.note !== undefined) out.note = g.note;
  return out;
}

/** A generator asset as JSON: `format` first, then the body. */
export const generatorToJson = (g: GeneratorBody): JsonRecord => ({ format: GENERATOR_FORMAT, ...generatorBodyToJson(g) });

/** The asset's file text: two-space JSON and a final newline. */
export const formatGenerator = (g: GeneratorBody): string => `${JSON.stringify(generatorToJson(g), null, 2)}\n`;

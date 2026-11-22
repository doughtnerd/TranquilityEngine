/**
 * Audio parameters (ADR 0304: one parameter list, used by the project's global `audio.parameters` and by a playlist's
 * local `parameters`; first defined by ADR 0158 for audio events). A parameter is numeric (a range with a seek speed) or
 * labelled (a state: one of its labels, whose numeric value is the label's index).
 *
 * The parse is lenient (bad values fall back to defaults with one problem line; it never throws) and the limits are
 * declared here once: the core's global slots and its slots per instance.
 *
 * Pure; no plugin, no DOM.
 */

/** A continuous parameter. `seekSpeed` is units per second toward a new value; 0 jumps. */
export interface NumericParameter {
  name: string;
  min: number;
  max: number;
  default: number;
  seekSpeed: number;
}

/** A labelled parameter (a "state"): one of `labels`; it always jumps. Its numeric value is the label's index. */
export interface LabelledParameter {
  name: string;
  labels: string[];
  default: string;
}

export type ParameterDef = NumericParameter | LabelledParameter;

export const isLabelled = (p: ParameterDef): p is LabelledParameter => "labels" in p;

/** The numeric range of a parameter: labelled ones are 0..labels-1. */
export const parameterRange = (p: ParameterDef): [number, number] => (isLabelled(p) ? [0, Math.max(0, p.labels.length - 1)] : [p.min, p.max]);

/** The default as a number (a label's index). */
export const parameterDefault = (p: ParameterDef): number => (isLabelled(p) ? Math.max(0, p.labels.indexOf(p.default)) : p.default);

/** At most this many parameters globally (the core's global slots). */
export const MAX_PARAMETERS = 64;
/** At most this many local parameters per playlist instance (the core's slots per instance). */
export const MAX_LOCAL_PARAMETERS = 16;

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/** A number in `min..max`, else `fallback` (or the clamped value) with one problem line. */
function num(raw: unknown, where: string, fallback: number, problems: string[], min = -Infinity, max = Infinity): number {
  if (raw === undefined) return fallback;
  if (typeof raw !== "number" || !Number.isFinite(raw)) { problems.push(`${where}: must be a number; using ${fallback}.`); return fallback; }
  if (raw < min || raw > max) {
    const c = Math.min(max, Math.max(min, raw));
    problems.push(`${where}: ${raw} is outside ${min}..${max}; using ${c}.`);
    return c;
  }
  return raw;
}

/**
 * A parameter list (a playlist's or the project's `audio.parameters`), leniently. Names must be unique and non-empty;
 * numeric ones get `min <= default <= max`; labelled ones need at least one label.
 */
export function parseParameters(raw: unknown, where: string, problems: string[], limit = MAX_PARAMETERS): ParameterDef[] {
  if (raw === undefined) return [];
  if (!Array.isArray(raw)) { problems.push(`${where}: must be a list.`); return []; }
  const out: ParameterDef[] = [];
  raw.forEach((p, i) => {
    const w = `${where}[${i}]`;
    if (!isRecord(p) || typeof p.name !== "string" || p.name.trim() === "") return void problems.push(`${w}: name must be a non-empty string; dropped.`);
    if (out.some((o) => o.name === p.name)) return void problems.push(`${w}: another parameter is already named "${p.name}"; dropped.`);
    if (out.length >= limit) return void problems.push(`${w}: at most ${limit} parameters; dropped.`);
    if (p.labels !== undefined) {
      const labels = Array.isArray(p.labels) ? [...new Set(p.labels.filter((l): l is string => typeof l === "string" && l !== ""))] : [];
      if (labels.length === 0) return void problems.push(`${w}: labels must be a list of names; dropped.`);
      let def = typeof p.default === "string" ? p.default : labels[0]!;
      if (!labels.includes(def)) { problems.push(`${w}: default "${def}" is not one of its labels; using "${labels[0]}".`); def = labels[0]!; }
      return void out.push({ name: p.name, labels, default: def });
    }
    let min = num(p.min, `${w}.min`, 0, problems), max = num(p.max, `${w}.max`, 1, problems);
    if (min > max) { problems.push(`${w}: min was above max; swapped.`); [min, max] = [max, min]; }
    out.push({ name: p.name, min, max, default: num(p.default, `${w}.default`, min, problems, min, max), seekSpeed: num(p.seekSpeed, `${w}.seekSpeed`, 0, problems, 0) });
  });
  return out;
}

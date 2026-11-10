// The Event editor's parameter edits (ADR 0158 §2): an event's local parameters, numeric or labelled, kept valid the
// way `parseParameters` reads them (unique non-empty names, min <= default <= max, a labelled default among its
// labels), and the audition values the sliders hold. Pure; renaming goes through `renameParameter` (eventTree.ts)
// so every use follows.
import {
  MAX_LOCAL_PARAMETERS,
  isLabelled,
  parameterDefault,
  type AudioEventAsset,
  type LabelledParameter,
  type NumericParameter,
  type ParameterDef,
} from "../../../../engine/audio/eventFormat";
import { renameParameter } from "./eventTree";

/** The first free name of the form "Parameter", "Parameter 2"… among `taken`. */
export function freeParameterName(taken: readonly string[], base = "Parameter"): string {
  if (!taken.includes(base)) return base;
  for (let i = 2; ; i++) if (!taken.includes(`${base} ${i}`)) return `${base} ${i}`;
}

/** The event with a new numeric parameter (0..1, default 0, seek 0) at the end; unchanged at `MAX_LOCAL_PARAMETERS`. */
export function addParameter(event: AudioEventAsset): AudioEventAsset {
  if (event.parameters.length >= MAX_LOCAL_PARAMETERS) return event;
  const p: NumericParameter = { name: freeParameterName(event.parameters.map((q) => q.name)), min: 0, max: 1, default: 0, seekSpeed: 0 };
  return { ...event, parameters: [...event.parameters, p] };
}

/** The event without parameter `index` (its uses stay; they read as global names or warn, as the parser says). */
export function removeParameter(event: AudioEventAsset, index: number): AudioEventAsset {
  return { ...event, parameters: event.parameters.filter((_, i) => i !== index) };
}

/** Why `name` can't name parameter `index` (empty, or another one has it), or null. */
export function parameterNameProblem(parameters: readonly ParameterDef[], index: number, name: string): string | null {
  if (name.trim() === "") return "a parameter needs a name";
  if (parameters.some((p, i) => i !== index && p.name === name)) return `another parameter is named "${name}"`;
  return null;
}

/** Rename parameter `index` and every use of it; unchanged when the name is refused. */
export function renameParameterAt(event: AudioEventAsset, index: number, name: string): AudioEventAsset {
  const p = event.parameters[index];
  const trimmed = name.trim();
  if (!p || parameterNameProblem(event.parameters, index, trimmed)) return event;
  return renameParameter(event, p.name, trimmed);
}

/** Replace parameter `index` with `next`. */
export function setParameterAt(event: AudioEventAsset, index: number, next: ParameterDef): AudioEventAsset {
  return { ...event, parameters: event.parameters.map((p, i) => (i === index ? next : p)) };
}

/**
 * Parameter `p` as the other kind, keeping its name: a numeric one becomes labelled with labels "A", "B" (default
 * "A"); a labelled one numeric over 0..labels-1 with its default's index.
 */
export function toggleLabelled(p: ParameterDef): ParameterDef {
  if (isLabelled(p)) return { name: p.name, min: 0, max: Math.max(1, p.labels.length - 1), default: parameterDefault(p), seekSpeed: 0 };
  return { name: p.name, labels: ["A", "B"], default: "A" };
}

/**
 * A numeric parameter with `patch` applied and kept valid: a min above max moves max up to it (and a max below min
 * moves min down), the default is clamped into the range, the seek speed is at least 0. Non-finite values are ignored.
 */
export function updateNumeric(p: NumericParameter, patch: Partial<Omit<NumericParameter, "name">>): NumericParameter {
  const ok = (v: number | undefined): v is number => v !== undefined && Number.isFinite(v);
  let { min, max } = p;
  if (ok(patch.min)) { min = patch.min; if (max < min) max = min; }
  if (ok(patch.max)) { max = patch.max; if (min > max) min = max; }
  const def = ok(patch.default) ? patch.default : p.default;
  const seekSpeed = ok(patch.seekSpeed) ? Math.max(0, patch.seekSpeed) : p.seekSpeed;
  return { name: p.name, min, max, default: Math.min(max, Math.max(min, def)), seekSpeed };
}

/**
 * A labelled parameter with labels from `text` (comma separated, trimmed, empty and repeated ones dropped). With no
 * labels left it is unchanged. The default stays if it is still a label, else it becomes the first.
 */
export function setLabels(p: LabelledParameter, text: string): LabelledParameter {
  const labels = [...new Set(text.split(",").map((l) => l.trim()).filter((l) => l !== ""))];
  if (labels.length === 0) return p;
  return { name: p.name, labels, default: labels.includes(p.default) ? p.default : labels[0] };
}

/**
 * The audition values for `parameters`: each parameter's value in `current` when it is still valid for it (a number in
 * range for a numeric one, one of its labels for a labelled one), else its default (a number, or the default label).
 */
export function auditionValues(parameters: readonly ParameterDef[], current: Readonly<Record<string, number | string>>): Record<string, number | string> {
  const out: Record<string, number | string> = {};
  for (const p of parameters) {
    const v = current[p.name];
    if (isLabelled(p)) out[p.name] = typeof v === "string" && p.labels.includes(v) ? v : p.default;
    else out[p.name] = typeof v === "number" && v >= p.min && v <= p.max ? v : p.default;
  }
  return out;
}

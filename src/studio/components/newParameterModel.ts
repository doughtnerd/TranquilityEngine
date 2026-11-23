// "+ New parameter…" (UI pass J4.1, J5.1, J6.5): every select that chooses a game parameter as an input (a Blend axis,
// a Switch's parameter, an automation lane's "Driven by", a snapshot condition) ends with this entry, so a new project
// with no parameters isn't a dead end. Choosing it opens the New parameter dialog (`NewParameterDialog.tsx`); the draft
// it edits becomes a parameter definition (ADR 0304: numeric with a range and default, or labelled with its labels),
// which the caller adds where its parameters live (the project's global ones in `audio.json`, or a playlist's own) and
// then picks.
//
// Pure: no DOM, no signals.
import { MAX_PARAMETERS, type ParameterDef } from "../../engine/audio/parameters";
import { uniqueName } from "../../engine/core/uniqueName";

/** The option value of "+ New parameter…" (no parameter name holds a control character). */
export const NEW_PARAMETER = "\u0001new-parameter";
/** Its label. */
export const NEW_PARAMETER_LABEL = "+ New parameter…";

/** `options` with "+ New parameter…" last, the option a parameter select always ends with. */
export function withNewParameter<O extends { value: string; label: string }>(options: readonly O[]): (O | { value: string; label: string })[] {
  return [...options, { value: NEW_PARAMETER, label: NEW_PARAMETER_LABEL }];
}

/** Whether a select's chosen value is "+ New parameter…". */
export const isNewParameter = (value: string): boolean => value === NEW_PARAMETER;

export type NewParameterKind = "numeric" | "labelled";

/** What the dialog edits. Labels are comma-separated text, as the parameter cards take them. */
export interface ParameterDraft {
  readonly name: string;
  readonly kind: NewParameterKind;
  readonly min: number;
  readonly max: number;
  readonly default: number;
  readonly labels: string;
}

/** A fresh draft: a free name ("Parameter", "Parameter 2"…, or `suggested`), numeric 0..1 at 0, or labelled "State 1, State 2". */
export function newDraft(existing: readonly string[], kind: NewParameterKind = "numeric", suggested = "Parameter"): ParameterDraft {
  return { name: uniqueName(suggested, existing), kind, min: 0, max: 1, default: 0, labels: "State 1, State 2" };
}

const labelsOf = (text: string): string[] => [...new Set(text.split(",").map((l) => l.trim()).filter((l) => l !== ""))];

/** Why the draft can't be created (the Create button's tooltip), or null. `limit`: the holder's most parameters. */
export function whyNotCreate(d: ParameterDraft, existing: readonly string[], limit = MAX_PARAMETERS): string | null {
  const name = d.name.trim();
  if (name === "") return "A parameter needs a name";
  if (existing.includes(name)) return `There's already a parameter named "${name}"`;
  if (existing.length >= limit) return `At most ${limit} parameters`;
  if (d.kind === "labelled") return labelsOf(d.labels).length === 0 ? "A labelled parameter needs at least one label" : null;
  if (![d.min, d.max, d.default].every(Number.isFinite)) return "Min, max and default must be numbers";
  if (d.min >= d.max) return "Max must be above min";
  return null;
}

/** The definition a valid draft makes: numeric with the default clamped into the range and no seek (it jumps); labelled with its first label as the default. */
export function parameterFromDraft(d: ParameterDraft): ParameterDef {
  const name = d.name.trim();
  if (d.kind === "labelled") {
    const labels = labelsOf(d.labels);
    return { name, labels, default: labels[0]! };
  }
  return { name, min: d.min, max: d.max, default: Math.min(d.max, Math.max(d.min, d.default)), seekSpeed: 0 };
}

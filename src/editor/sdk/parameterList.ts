// One parameter list (ADR 0304): the edits of a list of audio parameters, an event's own (`AudioEventAsset.parameters`)
// or the project's global ones (`audio.parameters`), kept valid the way `parseParameters` reads both back: unique
// non-empty names, at most the holder's limit, `min <= default <= max` (a min above max swaps, as the parse does), a
// labelled default among its labels. A holder plugs in where the list lives and what a rename or a remove carries along
// (an event's references; the settings' bus automation). Every edit is a refused-or-next result (ADR 0307).
import { isLabelled, parameterDefault, parameterRange, type LabelledParameter, type NumericParameter, type ParameterDef } from "../../engine/audio/parameters";
import { uniqueName } from "../../engine/core/uniqueName";
import { accept, refuse, type EditResult } from "./editResult";

export type ParameterKind = "numeric" | "labelled";

/** What `setRange` may change on a numeric parameter. */
export interface ParameterRangePatch { min?: number; max?: number; default?: number; seekSpeed?: number }

/** Where a parameter list lives and what its renames and removes carry along. */
export interface ParameterHolder<H> {
  read(h: H): readonly ParameterDef[];
  /** `h` with its list replaced (nothing else changes). */
  write(h: H, parameters: ParameterDef[]): H;
  /** The most parameters the parse keeps. */
  readonly limit: number;
  /** `h` with parameter `from` (known) named `to` (valid, free) in its list and wherever `h` names it. */
  rename(h: H, from: string, to: string): H;
  /** `h` without parameter `name` (known), and without what goes with it. */
  remove(h: H, name: string): H;
}

/** The edits of one holder's parameter list. */
export interface ParameterList<H> {
  readonly limit: number;
  parameters(h: H): readonly ParameterDef[];
  /** At the limit: an add would be refused. */
  full(h: H): boolean;
  /** Append "Parameter" (unique: "Parameter 2"…): numeric 0..1, default 0, seek 0; labelled "State 1", "State 2". */
  add(h: H, kind?: ParameterKind): EditResult<H>;
  remove(h: H, name: string): EditResult<H>;
  /** Trimmed; empty or taken names are refused; the same name is no change. */
  rename(h: H, from: string, to: string): EditResult<H>;
  /** Switch kind, keeping name and place: labelled gets "State 1", "State 2"; numeric 0..labels-1 (at least 0..1) at the default's index. */
  setKind(h: H, name: string, kind: ParameterKind): EditResult<H>;
  /** A numeric parameter's range, default and seek speed: non-finite fields ignored, min above max swapped, default clamped in, seek speed at least 0. */
  setRange(h: H, name: string, patch: ParameterRangePatch): EditResult<H>;
  /** A labelled parameter's labels from comma-separated text: trimmed, empty ones and repeats dropped; none left is refused. The default stays if still a label, else the first. */
  setLabels(h: H, name: string, text: string): EditResult<H>;
  /** A labelled parameter's default: one of its labels. */
  setDefaultLabel(h: H, name: string, label: string): EditResult<H>;
}

/** The labels a new labelled parameter starts with. */
export const NEW_LABELS: readonly string[] = ["State 1", "State 2"];

const newParameter = (name: string, kind: ParameterKind): ParameterDef =>
  kind === "labelled" ? { name, labels: [...NEW_LABELS], default: NEW_LABELS[0] } : { name, min: 0, max: 1, default: 0, seekSpeed: 0 };

/** `p` as the other kind (or itself when it is that kind already). */
function asKind(p: ParameterDef, kind: ParameterKind): ParameterDef {
  if (isLabelled(p) === (kind === "labelled")) return p;
  if (kind === "labelled") return newParameter(p.name, "labelled");
  return { name: p.name, min: 0, max: Math.max(1, parameterRange(p)[1]), default: parameterDefault(p), seekSpeed: 0 };
}

function withRange(p: NumericParameter, patch: ParameterRangePatch): NumericParameter {
  const finite = (v: number | undefined) => (v !== undefined && Number.isFinite(v) ? v : undefined);
  let min = finite(patch.min) ?? p.min;
  let max = finite(patch.max) ?? p.max;
  if (min > max) [min, max] = [max, min];
  const seekSpeed = Math.max(0, finite(patch.seekSpeed) ?? p.seekSpeed);
  return { name: p.name, min, max, default: Math.min(max, Math.max(min, finite(patch.default) ?? p.default)), seekSpeed };
}

const same = (a: ParameterDef, b: ParameterDef): boolean => JSON.stringify(a) === JSON.stringify(b);

export function parameterList<H>(holder: ParameterHolder<H>): ParameterList<H> {
  const missing = (name: string) => refuse(`no parameter named "${name}"`);
  /** Replace parameter `name` by `change(p)` (a string refuses); an equal parameter is no change. */
  const edit = (h: H, name: string, change: (p: ParameterDef) => ParameterDef | string): EditResult<H> => {
    const list = holder.read(h);
    const p = list.find((q) => q.name === name);
    if (!p) return missing(name);
    const next = change(p);
    if (typeof next === "string") return refuse(next);
    return accept(same(next, p) ? h : holder.write(h, list.map((q) => (q === p ? next : q))));
  };
  return {
    limit: holder.limit,
    parameters: (h) => holder.read(h),
    full: (h) => holder.read(h).length >= holder.limit,
    add(h, kind = "numeric") {
      const list = holder.read(h);
      if (list.length >= holder.limit) return refuse(`at most ${holder.limit} parameters`);
      return accept(holder.write(h, [...list, newParameter(uniqueName("Parameter", list.map((p) => p.name)), kind)]));
    },
    remove(h, name) {
      return holder.read(h).some((p) => p.name === name) ? accept(holder.remove(h, name)) : missing(name);
    },
    rename(h, from, to) {
      const list = holder.read(h);
      const name = to.trim();
      if (!list.some((p) => p.name === from)) return missing(from);
      if (name === from) return accept(h);
      if (name === "") return refuse("a parameter needs a name");
      if (list.some((p) => p.name === name)) return refuse(`another parameter is named "${name}"`);
      return accept(holder.rename(h, from, name));
    },
    setKind: (h, name, kind) => edit(h, name, (p) => asKind(p, kind)),
    setRange: (h, name, patch) => edit(h, name, (p) => (isLabelled(p) ? `${name} is labelled; it has no range` : withRange(p, patch))),
    setLabels: (h, name, text) =>
      edit(h, name, (p) => {
        if (!isLabelled(p)) return `${name} is numeric; it has no labels`;
        const labels = [...new Set(text.split(",").map((l) => l.trim()).filter((l) => l !== ""))];
        if (labels.length === 0) return "a labelled parameter needs at least one label";
        return { name: p.name, labels, default: labels.includes(p.default) ? p.default : labels[0] } satisfies LabelledParameter;
      }),
    setDefaultLabel: (h, name, label) =>
      edit(h, name, (p) => {
        if (!isLabelled(p)) return `${name} is numeric; it has no labels`;
        return p.labels.includes(label) ? { ...p, default: label } : `"${label}" is not one of ${name}'s labels`;
      }),
  };
}

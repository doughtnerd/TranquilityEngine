// The game parameters panel's rows (ADR 0335 `ParameterPanel`, ADR 0304 parameters): test values for the parameters
// a screen listens to: a slider for a numeric parameter (its range in 1000 steps), a select for a labelled one. Test
// values are the Studio's, never saved into the project; a parameter without one shows its default.
import { isLabelled, parameterDefault, type ParameterDef } from "../../engine/audio/parameters";
import { snapParam, type ParamSpec } from "./parameterRowModel";

export type ParameterRowView =
  | { readonly kind: "number"; readonly name: string; readonly spec: ParamSpec; readonly value: number; readonly isDefault: boolean }
  | { readonly kind: "labels"; readonly name: string; readonly labels: readonly string[]; readonly value: number; readonly isDefault: boolean };

/** A numeric parameter's slider spec: its range in 1000 steps (whole steps for a range of 1000 or more). */
export function numericSpec(def: { readonly name: string; readonly min: number; readonly max: number; readonly default: number }, unit = ""): ParamSpec {
  const span = def.max - def.min;
  const raw = span > 0 ? span / 1000 : 1;
  const step = raw >= 1 ? 1 : Math.pow(10, Math.floor(Math.log10(raw)));
  return { label: def.name, min: def.min, max: def.max, step, unit, default: def.default };
}

/** The rows for `defs` with the test `values` (by name; a label's index for labelled parameters). */
export function parameterRows(defs: readonly ParameterDef[], values: Readonly<Record<string, number>>, units: Readonly<Record<string, string>> = {}): ParameterRowView[] {
  return defs.map((def) => {
    const fallback = parameterDefault(def);
    const raw = values[def.name];
    if (isLabelled(def)) {
      const max = Math.max(0, def.labels.length - 1);
      const value = raw === undefined || !Number.isFinite(raw) ? fallback : Math.min(max, Math.max(0, Math.round(raw)));
      return { kind: "labels", name: def.name, labels: def.labels, value, isDefault: value === fallback };
    }
    const spec = numericSpec(def, units[def.name]);
    const value = raw === undefined || !Number.isFinite(raw) ? fallback : snapParam(spec, raw);
    return { kind: "number", name: def.name, spec, value, isDefault: value === fallback };
  });
}

/** The test values with `name` set to `value` (a label's index), or put back to its default when `value` is null. */
export function withTestValue(values: Readonly<Record<string, number>>, name: string, value: number | null): Record<string, number> {
  const next = { ...values };
  if (value === null) delete next[name];
  else next[name] = value;
  return next;
}

// What the Studio's screens hand the shared curve editor (ADR 0332, `src/editor/ui/curves/`) about game parameters: a
// lane driven by a parameter names the dialog input `param:<name>` (so a parameter called "time" can't be taken for the
// dialog's time axis), the parameters as dialog inputs with their test value as "now", the histogram of the values the
// game sent (from an open take, ADR 0334; takes aren't built yet, so the hook is empty until they register a source),
// and the undo label an Apply commits.
// Pure, apart from the histogram source a take registers.
import { isLabelled, parameterRange, type ParameterDef } from "../../engine/audio/parameters";
import type { CurveInput } from "../../editor/ui/curves/curveEditorModel";

const PREFIX = "param:";

/** The dialog input id of parameter `name`. */
export const parameterInputId = (name: string): string => `${PREFIX}${name}`;

/** The parameter a dialog input id names, or null (the time or distance axis). */
export const parameterOfInput = (id: string): string | null => (id.startsWith(PREFIX) ? id.slice(PREFIX.length) : null);

/**
 * `defs` as dialog inputs, in order: numeric ones over their range, labelled ones over their label indices (0..n−1,
 * as the core reads them). `values` (test values by name; labelled as the label's index) gives each one's "now".
 */
export function parameterInputs(defs: readonly ParameterDef[], values: Readonly<Record<string, number>> = {}): CurveInput[] {
  return defs.map((d) => {
    const [min, max] = parameterRange(d);
    const now = values[d.name];
    return { id: parameterInputId(d.name), name: isLabelled(d) ? `${d.name} (labels)` : d.name, min, max: max > min ? max : min + 1, ...(now !== undefined ? { now } : {}) };
  });
}

/**
 * How often the game sent each value of `parameter`, in bins over `range` (the dialog's parameter backdrop), or null
 * when nothing is known. Registered by an open take (ADR 0334).
 */
export type ParameterHistogramSource = (parameter: string, range: readonly [number, number]) => readonly number[] | null;

let histogramSource: ParameterHistogramSource | null = null;

/** Register the open take's histogram; returns the unregister (a later registration replaces this one). */
export function setParameterHistogramSource(source: ParameterHistogramSource): () => void {
  histogramSource = source;
  return () => {
    if (histogramSource === source) histogramSource = null;
  };
}

/** The histogram of the parameter driving dialog input `input` (undefined without an open take, or for a time axis). */
export function inputHistogram(input: string | undefined, inputs: readonly CurveInput[]): readonly number[] | undefined {
  const name = input === undefined ? null : parameterOfInput(input);
  const axis = inputs.find((i) => i.id === input);
  if (!histogramSource || name === null || !axis) return undefined;
  const bins = histogramSource(name, [axis.min, axis.max]);
  return bins && bins.length > 0 ? bins : undefined;
}

/**
 * The undo label of an Apply that changed `changed` (lane names) on `owner`: one lane is "Automate <lane> · <owner>",
 * more are "Edit <owner> curves"; null when nothing changed.
 */
export function curvesLabel(owner: string, changed: readonly string[]): string | null {
  if (changed.length === 0) return null;
  return changed.length === 1 ? `Automate ${changed[0]} · ${owner}` : `Edit ${owner} curves`;
}

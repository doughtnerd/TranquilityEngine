// What the Studio's screens hand the shared curve editor (ADR 0346, `src/editor/ui/curves/`) about game parameters: a
// lane driven by a parameter names the dialog input `param:<name>` (so a parameter called "time" can't be taken for the
// dialog's time axis), the parameters as dialog inputs with their test value as "now", the histogram of the values the
// game sent (from an open take, ADR 0348; takes aren't built yet, so the hook is empty until they register a source),
// and the undo label an Apply commits.
// Pure, apart from the histogram source a take registers.
import { isLabelled, parameterRange, type ParameterDef } from "../../engine/audio/parameters";
import type { CurveInput } from "../../editor/ui/curves/curveEditorModel";
import type { LaneBy, SecondInput } from "../../editor/ui/curves/andByModel";
import type { CurveBy } from "../../engine/audio/curveBy";

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
    const input: CurveInput = { id: parameterInputId(d.name), name: isLabelled(d) ? `${d.name} (labels)` : d.name, min, max: max > min ? max : min + 1, ...(now !== undefined ? { now } : {}) };
    // From an open take: how often the game sent each value (each input its own), and its value as the take replays.
    const histogram = inputHistogram(input.id, [input]);
    const source = nowSource;
    return { ...input, ...(histogram ? { histogram } : {}), ...(source ? { live: () => source(d.name) ?? undefined } : {}) };
  });
}

/**
 * ADR 0362 §5: `defs` as the dialog's second inputs ("And by"): as `parameterInputs`, labelled ones with their labels.
 * `id` names a parameter's dialog input (default `param:<name>`; the Sequencer's lanes use the bare name). A lane's
 * second input that is none of them (`extra`, names) is offered over 0..1, so it opens as it is.
 */
export function secondInputsOf(defs: readonly ParameterDef[], values: Readonly<Record<string, number>> = {}, id: (name: string) => string = parameterInputId, extra: readonly string[] = []): SecondInput[] {
  const out: SecondInput[] = parameterInputs(defs, values).map((input, i) => {
    const d = defs[i]!;
    return { ...input, id: id(d.name), ...(isLabelled(d) ? { labels: d.labels } : {}) };
  });
  for (const name of extra) if (!defs.some((d) => d.name === name) && !out.some((s) => s.id === id(name))) out.push({ id: id(name), name: `${name} (unknown)`, min: 0, max: 1 });
  return out;
}

/** A stored lane's `by` as the dialog's (`id` names the parameter's dialog input). */
export function laneByOf(by: CurveBy | undefined, id: (name: string) => string = parameterInputId): LaneBy | undefined {
  return by ? { ...by, input: id(by.input) } : undefined;
}

/**
 * The dialog's `by` for a lane as stored: the parameter its input names (`name`: null when it names none), dropped when
 * it names none, or is rate on a lane not keyed on time (`time`).
 */
export function curveByOf(by: LaneBy | undefined, time: boolean, name: (id: string) => string | null = parameterOfInput): CurveBy | undefined {
  if (!by || (by.mode === "rate" && !time)) return undefined;
  const input = name(by.input);
  if (input === null) return undefined;
  return { input, mode: by.mode, ...(by.curve && by.curve.length > 0 ? { curve: by.curve } : {}), ...(by.labels && Object.keys(by.labels).length > 0 ? { labels: by.labels } : {}) };
}

/** The value the game is sending for `parameter` now (the open take at its playhead), or null when it hasn't sent one. */
export type ParameterNowSource = (parameter: string) => number | null;

let nowSource: ParameterNowSource | null = null;

/** Register the open take's "game now" (the curve editor's live marker); returns the unregister. */
export function setParameterNowSource(source: ParameterNowSource): () => void {
  nowSource = source;
  return () => {
    if (nowSource === source) nowSource = null;
  };
}

/**
 * How often the game sent each value of `parameter`, in bins over `range` (the dialog's parameter backdrop), or null
 * when nothing is known. Registered by an open take (ADR 0348).
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

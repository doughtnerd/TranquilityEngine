// The Mixer's automation in the shared curve editor (ADR 0344 automation, ADR 0346; the prototype's Bus curves): a
// dialog of kind "parameter" with one lane per automatable property of a bus or return (its level, each send, each
// effect parameter; log for Hz), each lane driven by its own global parameter, and the dialog's result turned back into
// automation edits: only lanes that changed are written, a flat lane that isn't bypassed removes the automation (the
// prototype's rule, `setAutomation`), and the whole Apply is one undo step labelled "Automate Low-pass cutoff · Music"
// (one lane) or "Edit Music curves" (more). A lane may also follow a second global parameter ("And by", ADR 0362 §5;
// Morph, Scale or per label: bus lanes aren't on time, so no Rate); Apply writes it as the lane's `by`.
// Pure.
import { withEnds, type CurveEditorResult, type CurveEditorSpec, type CurveLane } from "../../../editor/ui/curves/curveEditorModel";
import { isLabelled } from "../../../engine/audio/parameters";
import type { AudioProject, MixAutomation } from "../../../engine/audio/project/types";
import type { Curve } from "../../../engine/core/curve";
import { curveByOf, curvesLabel, inputHistogram, laneByOf, parameterInputId, parameterInputs, parameterOfInput, secondInputsOf } from "../curveInputs";
import { automatableLanes, type AutomatableLane } from "./boardModel";
import type { EditResult } from "./busTree";
import { setAutomation } from "./mixEdits";
import type { TestValues } from "./snapshotBlend";

/** What the Mixer opens the curve editor with. */
export interface AutomationDialog {
  readonly spec: CurveEditorSpec;
  readonly title: string;
  /** What Apply writes to (the bus or return). */
  readonly target: string;
  readonly initialLane?: string;
  readonly histogram?: readonly number[];
  /** The lanes as they were (to tell what changed). */
  readonly lanes: readonly AutomatableLane[];
}

/**
 * The curve editor's lane for an automatable property; one not automated yet starts on `driver` (the first numeric
 * parameter: a level or a cutoff over a labelled parameter's few steps is rarely what's meant).
 */
const laneOf = (l: AutomatableLane, driver: string): CurveLane => ({
  id: l.target,
  name: l.label,
  unit: l.unit,
  min: l.min,
  max: l.max,
  step: l.step,
  scale: l.scale,
  base: l.plain,
  curve: l.current?.curve ?? [],
  ...(l.current ? { input: parameterInputId(l.current.parameter), bypass: l.current.bypass } : { input: driver }),
  ...(l.current?.by ? { by: laneByOf(l.current.by) } : {}),
});

/**
 * The dialog for `name`'s lanes (`only`: "volume", "send:<return>", "fx:<id>" picks the lane selected first; every
 * lane is in the dialog, as the prototype's Bus curves). Refused when the project has no game parameter to drive
 * automation, or `name` has nothing to automate.
 */
export function automationDialog(p: AudioProject, name: string, only: string | undefined, values: TestValues = {}): EditResult<AutomationDialog> {
  if (p.parameters.length === 0) return { refused: "the project has no game parameters to drive automation yet" };
  const lanes = automatableLanes(p, name);
  if (lanes.length === 0) return { refused: `"${name}" isn't a bus or return` };
  const first = only === undefined ? undefined : lanes.find((l) => l.target === only || (only.startsWith("fx:") && l.target.startsWith(`${only}:`)));
  const inputs = parameterInputs(p.parameters, values);
  const secondInputs = secondInputsOf(p.parameters, values);
  const driver = parameterInputId((p.parameters.find((d) => !isLabelled(d)) ?? p.parameters[0]!).name);
  const spec: CurveEditorSpec = { kind: "parameter", lanes: lanes.map((l) => laneOf(l, driver)), inputs, ...(secondInputs.length > 1 ? { secondInputs } : {}) };
  const initial = first ?? lanes[0]!;
  const histogram = inputHistogram(initial.current ? parameterInputId(initial.current.parameter) : driver, inputs);
  return { next: { spec, title: p.returns.some((r) => r.name === name) ? "Return curves" : "Bus curves", target: name, initialLane: first?.target, lanes, ...(histogram ? { histogram } : {}) } };
}

const flat = (c: Curve) => c.length > 0 && c.every((k) => k[1] === c[0]![1]);

/**
 * Whether a dialog lane's result differs from what the lane held: no automation and a flat lane that's on is
 * unchanged, and so is the stored curve with the end keys the dialog gives every curve (it evaluates the same).
 */
function laneChanged(dialog: AutomationDialog, lane: AutomatableLane, next: { parameter: string; curve: Curve; bypass: boolean; by?: MixAutomation["by"] }): boolean {
  const was = lane.current;
  if (!was) return !(flat(next.curve) && !next.bypass && !next.by);
  if (was.parameter !== next.parameter || was.bypass !== next.bypass) return true;
  if (JSON.stringify(was.by ?? null) !== JSON.stringify(next.by ?? null)) return true;
  const axis = dialog.spec.inputs?.find((i) => i.id === parameterInputId(was.parameter));
  const stored = axis ? withEnds(was.curve, axis.min, axis.max, { base: lane.plain }) : was.curve;
  return JSON.stringify(stored) !== JSON.stringify(next.curve) && JSON.stringify(was.curve) !== JSON.stringify(next.curve);
}

/**
 * `p` with the dialog's result applied to `name`'s automation, and the undo label; `{ next: null }` when nothing
 * changed. Refused when a lane is driven by something that isn't a game parameter.
 */
export function applyAutomationResult(p: AudioProject, dialog: AutomationDialog, result: CurveEditorResult): EditResult<{ project: AudioProject; label: string } | null> {
  let next = p;
  const changed: string[] = [];
  for (const r of result.lanes) {
    const lane = dialog.lanes.find((l) => l.target === r.id);
    if (!lane) continue;
    const parameter = parameterOfInput(r.input);
    if (parameter === null) return { refused: `${lane.label} must be driven by a game parameter` };
    const by = curveByOf(r.by, false);
    const value = { parameter, curve: r.curve, bypass: r.bypass, ...(by ? { by } : {}) };
    if (!laneChanged(dialog, lane, value)) continue;
    const step = setAutomation(next, { on: dialog.target, target: lane.target as MixAutomation["target"] }, value);
    if ("refused" in step) return step;
    next = step.next;
    changed.push(lane.label);
  }
  const label = curvesLabel(dialog.target, changed);
  return { next: label === null || next === p ? null : { project: next, label } };
}

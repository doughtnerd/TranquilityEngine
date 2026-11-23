// A playlist effect's automation in the shared curve editor (ADR 0343 instance automation `fx:<id>:<param>`, ADR 0346;
// the prototype's effect row Automate button, W11.3): a dialog of kind "time" with one lane per parameter of the effect
// and one for its On (bypass), each over voice time or one of the playlist's parameters; the dialog's result turned back
// into the playlist's `automation` (a lane left flat at the effect's own value, not bypassed, is removed). Also the
// automate button's menu edits (copy, paste, turn off or on, clear) and the "automated now" text a card shows. Each lane
// may also follow a second parameter ("And by", ADR 0362 §5): the dialog offers the playlist's parameters as second
// inputs and Apply writes the lane's `by` (a lane with one is never "flat"). Pure.
import { TIME_INPUT, type CurveEditorResult, type CurveEditorSpec, type CurveInput as DialogInput, type CurveLane } from "../../../editor/ui/curves/curveEditorModel";
import { effectParamValue, effectSpec } from "../../../engine/audio/effects/catalogue";
import type { Effect } from "../../../engine/audio/effects/types";
import type { ParameterDef } from "../../../engine/audio/parameters";
import type { Automation, CurveInput } from "../../../engine/audio/playlist/types";
import { evalCurve } from "../../../engine/core/curve";
import { evalCurveBy, secondValueOf } from "../../../engine/audio/curveBy";
import { curveByOf, curvesLabel, laneByOf, parameterInputId, parameterInputs, parameterOfInput, secondInputsOf } from "../curveInputs";

/** The voice time axis is at least this long, seconds. */
const MIN_LENGTH = 2;

const prefix = (id: string) => `fx:${id}:`;
const inputId = (input: CurveInput): string => (typeof input === "string" ? TIME_INPUT : parameterInputId(input.parameter));

/** Effect `id`'s lanes in `automation`. */
export const lanesOf = (automation: readonly Automation[], id: string): Automation[] => automation.filter((a) => a.target.startsWith(prefix(id)));

/**
 * Each effect's automated parameters with their value now (voice time 0, the test values): effect id → param → text. A
 * lane's second input counts when its parameter is among `parameters`.
 */
export function automatedNow(effects: readonly Effect[], automation: readonly Automation[], values: Readonly<Record<string, number>>, parameters: readonly ParameterDef[] = []): Record<string, Record<string, string>> {
  const out: Record<string, Record<string, string>> = {};
  for (const e of effects) {
    const spec = effectSpec(e.type);
    for (const a of lanesOf(automation, e.id)) {
      if (a.bypass) continue;
      const name = a.target.slice(prefix(e.id).length);
      const p = spec.params.find((q) => q.name === name);
      const x = typeof a.input === "string" ? 0 : (values[a.input.parameter] ?? 0);
      const second = a.by && parameters.find((d) => d.name === a.by!.input);
      const v = !a.curve.length ? 0 : a.by && second ? evalCurveBy(a.curve, a.by, x, secondValueOf(second, values[second.name] ?? 0)) : evalCurve(a.curve, x);
      (out[e.id] ??= {})[name === "on" ? "On" : name] = p ? `${Math.round(v / p.step) * p.step}${p.unit ? ` ${p.unit}` : ""}` : v >= 0.5 ? "on" : "off";
    }
  }
  return out;
}

export interface EffectAutomationDialog {
  readonly spec: CurveEditorSpec;
  readonly effect: Effect;
  /** The effect's lanes as they were. */
  readonly lanes: readonly Automation[];
}

/** The dialog for effect `effect`'s automation, with the parameters the playlist can use (test values in `values`). */
export function effectAutomationDialog(effect: Effect, automation: readonly Automation[], parameters: readonly ParameterDef[], values: Readonly<Record<string, number>> = {}): EffectAutomationDialog {
  const spec = effectSpec(effect.type);
  const mine = lanesOf(automation, effect.id);
  const inputs: DialogInput[] = parameterInputs(parameters, values);
  let length = MIN_LENGTH;
  for (const a of mine) if (typeof a.input === "string") for (const k of a.curve) length = Math.max(length, k[0]);
  const lane = (target: string, rest: Omit<CurveLane, "id" | "curve" | "input" | "bypass">): CurveLane => {
    const a = mine.find((x) => x.target === target);
    const by = laneByOf(a?.by);
    return { id: target, ...rest, curve: a?.curve ?? [], ...(a ? { input: inputId(a.input), bypass: a.bypass } : {}), ...(by ? { by } : {}) };
  };
  const lanes: CurveLane[] = [
    ...spec.params.filter((p) => !p.bool).map((p) =>
      lane(`${prefix(effect.id)}${p.name}`, { name: p.label, unit: p.unit, min: p.min, max: p.max, step: p.step, base: effectParamValue(effect, p.name) ?? p.default, ...(p.scale === "log" && p.min > 0 ? { scale: "log" as const } : {}) }),
    ),
    lane(`${prefix(effect.id)}on`, { name: "On", unit: "", min: 0, max: 1, step: 1, base: effect.on ? 1 : 0, bool: true }),
  ];
  const secondInputs = secondInputsOf(parameters, values, parameterInputId, mine.flatMap((a) => (a.by ? [a.by.input] : [])));
  return { spec: { kind: "time", timeName: "Voice time", length: Math.ceil(length * 2) / 2, lanes, inputs, ...(secondInputs.length ? { secondInputs } : {}) }, effect, lanes: mine };
}

const flatAt = (c: readonly (readonly [number, number, ...unknown[]])[], y: number) => c.length > 0 && c.every((k) => k[1] === y);

/** A fresh lane id not in `automation`. */
function freeId(automation: readonly Automation[]): string {
  for (let n = 1; ; n++) if (!automation.some((a) => a.id === `a${n}`)) return `a${n}`;
}

/** The playlist's automation after the dialog's `result`, and the undo label; null when nothing changed. */
export function applyEffectAutomationResult(dialog: EffectAutomationDialog, automation: readonly Automation[], result: CurveEditorResult): { automation: Automation[]; label: string } | null {
  let next = [...automation];
  const changed: string[] = [];
  for (const r of result.lanes) {
    const lane = dialog.spec.lanes.find((l) => l.id === r.id);
    if (!lane) continue;
    const was = next.find((a) => a.target === r.id);
    const parameter = parameterOfInput(r.input);
    const input: CurveInput = parameter !== null ? { parameter } : "voiceTime";
    const by = curveByOf(r.by, parameter === null);
    const none = !r.bypass && flatAt(r.curve, lane.base) && !by;
    if (!was) {
      if (none || r.curve.length === 0) continue;
      next.push({ id: freeId(next), target: r.id as Automation["target"], input, curve: r.curve, bypass: r.bypass, ...(by ? { by } : {}) });
      changed.push(lane.name);
      continue;
    }
    if (none) {
      next = next.filter((a) => a !== was);
      changed.push(lane.name);
      continue;
    }
    if (inputId(was.input) === r.input && was.bypass === r.bypass && JSON.stringify(was.curve) === JSON.stringify(r.curve) && JSON.stringify(was.by ?? null) === JSON.stringify(by ?? null)) continue;
    next = next.map((a) => {
      if (a !== was) return a;
      const { by: _old, ...rest } = a;
      return { ...rest, input, curve: r.curve, bypass: r.bypass, ...(by ? { by } : {}) };
    });
    changed.push(lane.name);
  }
  const label = curvesLabel(effectSpec(dialog.effect.type).label, changed);
  return label === null ? null : { automation: next, label };
}

/** Effect `id`'s lanes with every one bypassed (true) or running (false). */
export const bypassLanes = (automation: readonly Automation[], id: string, bypass: boolean): Automation[] => automation.map((a) => (a.target.startsWith(prefix(id)) ? { ...a, bypass } : a));

/** The automation without effect `id`'s lanes. */
export const clearLanes = (automation: readonly Automation[], id: string): Automation[] => automation.filter((a) => !a.target.startsWith(prefix(id)));

/**
 * Lanes copied from another effect pasted onto effect `to`: those whose parameter `to` has (same type: all), replacing
 * its own; null when none fits.
 */
export function pasteLanes(automation: readonly Automation[], copied: readonly Automation[], to: Effect): Automation[] | null {
  const names = new Set([...effectSpec(to.type).params.map((p) => p.name), "on"]);
  const fit = copied.filter((a) => names.has(a.target.slice(a.target.indexOf(":", 3) + 1)));
  if (fit.length === 0) return null;
  let next = clearLanes(automation, to.id);
  for (const a of fit) next = [...next, { ...structuredClone(a), id: freeId(next), target: `${prefix(to.id)}${a.target.slice(a.target.indexOf(":", 3) + 1)}` as Automation["target"] }];
  return next;
}

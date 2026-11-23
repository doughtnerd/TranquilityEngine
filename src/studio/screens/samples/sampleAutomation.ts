// A baked effect's automation in the shared curve editor (ADR 0346, decision log D23; `SampleEdits.automation`): a
// dialog of kind "time" over sample time (clipTime: seconds in the source file, the only input a sample has) with one
// lane per parameter of the effect, and the dialog's result turned back into the sample's lanes
// (`fx:<effect id>:<parameter>`). A lane left flat at the parameter's set value is removed (as voice curves are); the
// render bakes the rest (`renderSample`), so Flatten follows the edit. Pure.
import type { CurveEditorResult, CurveEditorSpec } from "../../../editor/ui/curves/curveEditorModel";
import { effectParamValue, effectSpec } from "../../../engine/audio/effects/catalogue";
import type { Curve } from "../../../engine/core/curve";
import { SAMPLE_LIMITS } from "../../../engine/audio/sample/format";
import type { SampleAutomation, SampleEdits } from "../../../engine/audio/sample/types";
import { freeId, type SampleEdit } from "./sampleEditing";

/** The render reads an effect's first eight parameters (`audio_dsp::fx::PARAMS`); only those can be automated. */
export const AUTOMATABLE_PARAMS = 8;

/** A lane's id and the sample automation target it edits. */
export const targetOf = (effectId: string, param: string): SampleAutomation["target"] => `fx:${effectId}:${param}`;

/** The parameters of effect `id` that can be automated, with their current values. */
function paramsOf(e: SampleEdits, id: string) {
  const f = e.effects.find((x) => x.id === id);
  if (!f) return null;
  return { effect: f, params: effectSpec(f.type).params.slice(0, AUTOMATABLE_PARAMS).filter((p) => !p.bool) };
}

/** The number of automated lanes effect `id` has (its row's "Automated · 2" chip). */
export const automatedCount = (e: SampleEdits, id: string): number => e.automation.filter((a) => a.target.startsWith(`fx:${id}:`)).length;

/** The dialog for effect `id`'s automation over a sample `length` seconds long; null when there is no such effect. */
export function automationDialog(e: SampleEdits, id: string, length: number): CurveEditorSpec | null {
  const found = paramsOf(e, id);
  if (!found) return null;
  const { effect, params } = found;
  return {
    kind: "time",
    timeName: "Sample time",
    length: length > 0 ? length : 1,
    lanes: params.map((p) => {
      const base = effectParamValue(effect, p.name) ?? p.default;
      const lane = e.automation.find((a) => a.target === targetOf(effect.id, p.name));
      return {
        id: targetOf(effect.id, p.name), name: p.label, unit: p.unit, min: p.min, max: p.max, step: p.step, base,
        ...(p.scale === "log" && p.min > 0 ? { scale: "log" as const } : {}),
        curve: lane ? lane.curve : [[0, base]],
        bypass: lane?.bypass ?? false,
      };
    }),
  };
}

const flatAt = (curve: readonly (readonly number[] | readonly unknown[])[], value: number) => curve.every((k) => Math.abs((k[1] as number) - value) < 1e-9);

/**
 * The sample's lanes after the dialog's Apply for effect `id`: a lane flat at the parameter's value is removed, any
 * other written with `clipTime` as its input (each keeps its id); other effects' lanes are untouched. Null when nothing
 * changed; refused past the lane limit.
 */
export function applyAutomationResult(e: SampleEdits, id: string, result: CurveEditorResult): SampleEdit | null {
  const found = paramsOf(e, id);
  if (!found) return { refused: "that effect is gone" };
  const { effect, params } = found;
  const label = effectSpec(effect.type).label;
  let automation = [...e.automation];
  for (const p of params) {
    const target = targetOf(effect.id, p.name);
    const lane = result.lanes.find((l) => l.id === target);
    if (!lane) continue;
    const base = effectParamValue(effect, p.name) ?? p.default;
    const i = automation.findIndex((a) => a.target === target);
    if (lane.curve.length === 0 || (flatAt(lane.curve, base) && !lane.bypass)) {
      if (i >= 0) automation.splice(i, 1);
      continue;
    }
    const next: SampleAutomation = { id: i >= 0 ? automation[i].id : freeId("a", automation.map((a) => a.id)), target, input: "clipTime", curve: lane.curve as Curve, bypass: lane.bypass };
    if (i >= 0) automation[i] = next;
    else automation = [...automation, next];
  }
  if (automation.length > SAMPLE_LIMITS.automation) return { refused: `a sample holds at most ${SAMPLE_LIMITS.automation} automation lanes` };
  if (JSON.stringify(automation) === JSON.stringify(e.automation)) return null;
  return { next: { ...e, automation }, label: `Automate ${label}` };
}

/** The sample's lanes without effect `id`'s (when it is removed, its lanes go with it). */
export const withoutLanesOf = (e: SampleEdits, id: string): SampleAutomation[] => e.automation.filter((a) => !a.target.startsWith(`fx:${id}:`));

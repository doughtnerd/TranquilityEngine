// A clip's or a track's automation in the shared curve editor (ADR 0346, proto §4 "CurveDialog use": the Sequencer's
// group mode). The dialog gets one lane per automatable target of the owner (its curve, or the plain value when not
// automated), each driven by time ("Clip time" on a clip, "Timeline" on a track) or a scalar parameter; Apply writes
// the lanes back as one edit: a changed lane's curve, input and bypass; a newly shaped lane becomes automation; a lane
// flattened to one value goes back to the plain value (proto: "Flat lanes collapse back to plain values"). Pure.
import { isLabelled, type ParameterDef } from "../../../../engine/audio/parameters";
import type { CurveKey } from "../../../../engine/core/curve";
import type { Automation, CurveInput as PlaylistCurveInput, SequenceSettings } from "../../../../engine/audio/playlist/types";
import { TIME_INPUT, type CurveEditorResult, type CurveEditorSpec, type CurveInput, type CurveLane } from "../../../../editor/ui/curves/curveEditorModel";
import { accept, refuse, type EditResult } from "../../../../plugins/audio/editor/editResult";
import { isTimeInput, MAX_AUTOMATION, ownerOf, targetSpecs, type AutomationOwner } from "./automationEdits";
import { findClip, mapClips, mapTrack, nextId } from "./sequenceModel";

/** The dialog's spec for an owner: kind time, its targets as lanes, scalar parameters as inputs. */
export function curveSpec(s: SequenceSettings, owner: AutomationOwner, length: number, parameters: readonly ParameterDef[]): CurveEditorSpec | null {
  const view = ownerOf(s, owner);
  if (!view) return null;
  const lanes: CurveLane[] = targetSpecs(view.effects).map((t, i) => {
    const a = view.automation.find((x) => x.target === t.target);
    return {
      id: t.target, name: t.name, unit: t.unit, min: t.min, max: t.max, step: t.step, scale: t.scale, bool: t.bool, color: (i % 8) + 1, base: t.base,
      curve: a?.curve ?? [[0, t.base]],
      input: a ? (isTimeInput(a.input) ? TIME_INPUT : (a.input as { parameter: string }).parameter) : TIME_INPUT,
      bypass: a?.bypass ?? false,
    };
  });
  const inputs: CurveInput[] = parameters.filter((p) => !isLabelled(p)).map((p) => ({ id: p.name, name: p.name, min: (p as { min: number }).min, max: (p as { max: number }).max }));
  return { kind: "time", lanes, inputs, length: Math.max(0.01, length), timeName: "clip" in owner ? "Clip time" : "Timeline" };
}

const flat = (curve: readonly CurveKey[]): boolean => curve.every((k) => Math.abs(k[1] - curve[0]![1]) < 1e-9);

/** "Edit X curves": the dialog's result applied to the owner's automation (one edit). */
export function applyCurveResult(s: SequenceSettings, owner: AutomationOwner, result: CurveEditorResult): EditResult<SequenceSettings> {
  const view = ownerOf(s, owner);
  if (!view) return refuse("that clip or track isn't there any more");
  const timeInput: PlaylistCurveInput = "clip" in owner ? "clipTime" : "sequenceTime";
  const list: Automation[] = [...view.automation];
  for (const lane of result.lanes) {
    const input: PlaylistCurveInput = lane.input === TIME_INPUT ? timeInput : { parameter: lane.input };
    const i = list.findIndex((a) => a.target === lane.id);
    if (lane.curve.length === 0 || flat(lane.curve)) {
      if (i >= 0) list.splice(i, 1);
      continue;
    }
    if (i >= 0) list[i] = { ...list[i]!, curve: lane.curve, input, bypass: lane.bypass };
    else {
      if (list.length >= MAX_AUTOMATION) return refuse(`at most ${MAX_AUTOMATION} automation lanes`);
      list.push({ id: nextId("a", list.map((a) => a.id)), target: lane.id as Automation["target"], input, curve: lane.curve, bypass: lane.bypass });
    }
  }
  if ("clip" in owner) return findClip(s, owner.clip) ? accept(mapClips(s, (c) => (c.id === owner.clip ? { ...c, automation: list } : c))) : refuse("that clip isn't there any more");
  return accept(mapTrack(s, owner.track, (t) => ({ ...t, automation: list })));
}

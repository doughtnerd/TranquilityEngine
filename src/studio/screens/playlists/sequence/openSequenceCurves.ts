// Open the shared curve editor (ADR 0332) on a clip's or a track's automation: the spec and the Apply mapping are
// `sequenceCurves.ts`'s; Apply commits one edit labelled "Edit <name> curves". Used by the timeline's menus and lanes
// and by the Inspector's automation list.
import type { ParameterDef } from "../../../../engine/audio/eventFormat";
import type { SequenceSettings } from "../../../../engine/audio/playlist/types";
import { openCurveEditorDialog } from "../../../../editor/ui/curves/openCurveEditorDialog";
import type { AutomationOwner } from "./automationEdits";
import { applyCurveResult, curveSpec } from "./sequenceCurves";
import type { SeqEdit } from "./sequenceModel";

export interface CurveOpenRequest {
  readonly doc: Document;
  readonly seq: SequenceSettings;
  readonly owner: AutomationOwner;
  /** The time axis: the clip's length or the sequence's. */
  readonly length: number;
  /** The owner's name ("brake_skid", "Skid"). */
  readonly name: string;
  /** The sequence's name, for the dialog's context line. */
  readonly context: string;
  readonly parameters: readonly ParameterDef[];
  /** The playhead in the curve's time (clip time for a clip). */
  readonly playhead: number;
  /** The lane selected when it opens (a target). */
  readonly lane?: string;
  commit(label: string, edit: SeqEdit): void;
}

export function openSequenceCurves(r: CurveOpenRequest): void {
  const spec = curveSpec(r.seq, r.owner, r.length, r.parameters);
  if (!spec) return;
  openCurveEditorDialog(r.doc, {
    ...spec,
    title: `Automation · ${r.name}`,
    target: r.name,
    context: r.context,
    initialLane: r.lane,
    playhead: r.playhead,
    onApply: (result) => r.commit(`Edit ${r.name} curves`, (q) => applyCurveResult(q, r.owner, result)),
    onCancel: () => {},
  });
}

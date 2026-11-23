// The Playlists screen's one door to the shared curve editor (ADR 0346, `src/editor/ui/curves/`): "Edit voice curves…"
// opens the dialog on an entry's voice curves (`voiceCurves.ts`: gain, pitch, pan, low-pass, high-pass over voice time or
// a parameter) and applies its result through `apply`, one labelled undo step on the playlist.
import { openCurveEditorDialog } from "../../../editor/ui/curves/openCurveEditorDialog";
import type { ParameterDef } from "../../../engine/audio/parameters";
import { parameterInputs } from "../curveInputs";
import { applyVoiceCurveResult, voiceCurveDialog, type VoiceCurves } from "./voiceCurves";
import { applyWeightCurveResult, weightCurveDialog } from "./weightCurves";
import type { Curve } from "../../../engine/core/curve";

/** What the Playlists screen asks the curve editor to edit: one entry's voice curves. */
export interface CurveEditorRequest {
  /** The entry's name ("dirt_02"). */
  readonly entry: string;
  /** Where it sits ("Footsteps › Dirt"), under the title. */
  readonly context?: string;
  /** The curves as they are, by target. */
  readonly curves: VoiceCurves;
  /** The parameters a curve can be keyed on besides voice time (the playlist's local ones over the global ones). */
  readonly parameters: readonly ParameterDef[];
  /** Their test values (labelled ones as the label's index): the dialog's "now". */
  readonly values?: Readonly<Record<string, number>>;
  /** Write the edited curves back (one undo step on the playlist). */
  apply(curves: VoiceCurves, label: string): void;
  /** "+ New parameter…" in Driven by (J6.5): make a game parameter; null when cancelled. */
  newParameter?(): Promise<ParameterDef | null>;
}

/** ADR 0350: open the curve editor on a Blend entry's weight curve; `apply` gets the new curve (undefined: cleared). */
export function openWeightCurveEditor(request: { readonly entry: string; readonly context?: string; readonly curve: Curve | undefined; apply(curve: Curve | undefined): void }, doc: Document = document): void {
  openCurveEditorDialog(doc, {
    ...weightCurveDialog(request.curve),
    title: "Blend weight curve",
    target: request.entry,
    context: request.context,
    onCancel: () => {},
    onApply(result) {
      const r = applyWeightCurveResult(request.curve, result);
      if (r) request.apply(r.curve);
    },
  });
}

/** Open the curve editor on `request`. */
export function openCurveEditor(request: CurveEditorRequest, doc: Document = document): void {
  const dialog = voiceCurveDialog(request.entry, request.curves, request.parameters, request.values);
  openCurveEditorDialog(doc, {
    ...dialog.spec,
    title: "Voice curves",
    target: request.entry,
    context: request.context,
    histogram: dialog.histogram,
    newInput: request.newParameter
      ? async () => {
          const def = await request.newParameter!();
          return def ? parameterInputs([def], request.values)[0]! : null;
        }
      : undefined,
    onCancel: () => {},
    onApply(result) {
      const r = applyVoiceCurveResult(dialog, result);
      if (r) request.apply(r.curves, r.label);
    },
  });
}

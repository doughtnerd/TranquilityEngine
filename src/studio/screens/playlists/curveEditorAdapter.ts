// The Playlists screen's one door to the shared curve editor (ADR 0332, `src/editor/ui/curves/`): "Edit voice curves…"
// opens the dialog on an entry's voice curves (`voiceCurves.ts`: gain, pitch, pan, low-pass, high-pass over voice time or
// a parameter) and applies its result through `apply`, one labelled undo step on the playlist.
import { openCurveEditorDialog } from "../../../editor/ui/curves/openCurveEditorDialog";
import type { ParameterDef } from "../../../engine/audio/eventFormat";
import { applyVoiceCurveResult, voiceCurveDialog, type VoiceCurves } from "./voiceCurves";

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
    onCancel: () => {},
    onApply(result) {
      const r = applyVoiceCurveResult(dialog, result);
      if (r) request.apply(r.curves, r.label);
    },
  });
}

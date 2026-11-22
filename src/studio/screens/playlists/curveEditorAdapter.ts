// The one seam to the shared curve editor (ADR 0332, 0335: `src/editor/ui/curves/`, being built beside this screen).
// "Edit voice curves…" calls `openCurveEditor(request)`; until the shared editor merges, it opens a small placeholder
// (`CurvePlaceholder` in `PlaylistDialogs.tsx`) that lists the entry's curves and can clear one. When the shared editor
// lands, this function is the only thing to change: open it with the request and apply its result through `apply`.
import { signal } from "@preact/signals";
import type { VoiceCurve, VoiceCurveTarget } from "../../../engine/audio/playlist/types";

/** What the Playlists screen asks the curve editor to edit: one entry's voice curves. */
export interface CurveEditorRequest {
  /** The dialog's title ("Voice curves · dirt_02"). */
  readonly title: string;
  /** The curves as they are, by target. */
  readonly curves: Partial<Record<VoiceCurveTarget, VoiceCurve>>;
  /** Numeric parameters a curve can be keyed on, besides voice time. */
  readonly drivers: readonly string[];
  /** Write the edited curves back (one undo step on the playlist). */
  apply(curves: Partial<Record<VoiceCurveTarget, VoiceCurve>>, label: string): void;
}

/** The request the placeholder shows (null: closed). */
export const curveRequest = signal<CurveEditorRequest | null>(null);

/** Open the curve editor on `request`. */
export function openCurveEditor(request: CurveEditorRequest): void {
  curveRequest.value = request;
}

export const closeCurveEditor = (): void => {
  curveRequest.value = null;
};

/** The voice curve targets in the prototype's words and units (PL:1701). */
export const CURVE_TARGET_TEXT: Record<VoiceCurveTarget, string> = {
  gain: "Gain (dB)", pitch: "Pitch (st)", pan: "Pan (%)", lowpass: "Low-pass (Hz)", highpass: "High-pass (Hz)",
};

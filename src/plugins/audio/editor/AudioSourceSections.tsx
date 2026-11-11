// Under an AudioSource's fields in the Inspector (ADR 0162 E2, api-and-models §1.2): the reverb send curve drawn with the
// SDK's CurveEditor (the field is a plain object, so the card has no editor of its own for it), and, when the clip is
// ambisonic, the fields it ignores (spatial, the distance fields, rolloff, occlusion, Doppler level) greyed with a note.
// The M3 number and checkbox fields (occlusion, Doppler level, reverb send, ambisonic yaw) are the card's rows.
import { useLayoutEffect, useRef } from "preact/hooks";
import { CurveEditor, editor, sectionField, type InspectorSectionProps } from "../../../editor/sdk";
import { AMBISONIC_IGNORED_FIELDS, sendCurveOf } from "./audioInspectorModel";
import { dragGroup, writeField, type FieldTarget } from "./inspectorWrite";
import "./audioInspectors.css";

const DEFAULT_CURVE: [number, number][] = [[0, 1], [1, 0.5]];
/** `reverbSend` is 0..2 and the product with the curve is clamped to 4 (§1.2), so a curve value reaches 4. */
const CURVE_Y: [number, number] = [0, 4];

/** Whether the AudioSource's clip is an ambisonic clip (its import settings say so). Events and unset or unknown clips are not. */
export function clipIsAmbisonic(clip: unknown): boolean {
  const project = editor.project.current;
  const path = typeof clip === "string" ? clip.replace(/^asset:/, "") : "";
  if (!project || path === "" || editor.assets.kindOf(path) !== "audio") return false;
  return editor.assets.importSettings(project, path).settings.ambisonic !== null;
}

/** Marks the card's rows for `fields` greyed (or clears them): the Inspector owns the rows, so this sets an attribute it never touches. */
function greyRows(card: Element | null, titles: readonly string[], greyed: boolean): void {
  if (!card) return;
  for (const label of card.querySelectorAll<HTMLElement>(".fields .label-cell > label")) {
    if (!titles.includes(label.title)) continue;
    for (const cell of [label.parentElement, label.parentElement?.nextElementSibling]) {
      if (!cell) continue;
      if (greyed) cell.setAttribute("data-audio-greyed", "");
      else cell.removeAttribute("data-audio-greyed");
    }
  }
}

export function AudioSourceSection({ scene, paths, info }: InspectorSectionProps) {
  editor.project.version; // import settings (tracked)
  const root = useRef<HTMLDivElement>(null);
  const ambisonic = clipIsAmbisonic(sectionField(info, "clip"));
  // A row's label carries the field's description as its tooltip, else its name.
  const titles = info.fields.filter((f) => AMBISONIC_IGNORED_FIELDS.includes(f.name)).map((f) => f.options?.description || f.name);
  const key = titles.join("|");
  useLayoutEffect(() => {
    const card = root.current?.closest("section") ?? null;
    greyRows(card, titles, ambisonic);
    return () => greyRows(card, titles, false);
  }, [ambisonic, key]);

  const target: FieldTarget = { scene, path: paths[0]!, type: info.type, index: info.index };
  const curve = sendCurveOf(sectionField(info, "reverbSendCurve"));
  const group = dragGroup(scene, "Edit reverb send curve");
  const yaw = Number(sectionField(info, "ambisonicYaw") ?? 0);
  return (
    <div class="audio-section" ref={root} aria-label="Audio source spatial">
      {ambisonic && (
        <p class="audio-note audio-note-warning" role="status">
          This clip is ambisonic, so it ignores Spatial, Min and Max Distance, Rolloff, Occlusion and Doppler Level (greyed above): the recording carries its own directions. Use Ambisonic Yaw to turn it.
        </p>
      )}
      {!ambisonic && yaw !== 0 && <p class="audio-note">Ambisonic Yaw only turns ambisonic clips; this clip isn't one.</p>}
      <div class="audio-curve-field" {...group}>
        <h4 title="How much of the source goes to the reverb zones that hold it, against distance: 0 at Min Distance to 1 at Max Distance. Multiplies Reverb Send; the product is clamped to 4.">Reverb send by distance</h4>
        <CurveEditor curve={curve} xRange={[0, 1]} yRange={CURVE_Y} interpolation={false} label="Reverb send curve" onChange={(c) => writeField(target, "reverbSendCurve", c.map((k) => [k[0], k[1]]))} />
        <button title="Back to full send up close and half at Max Distance" onClick={() => writeField(target, "reverbSendCurve", DEFAULT_CURVE.map((k) => [...k]))}>
          Reset curve
        </button>
      </div>
    </div>
  );
}

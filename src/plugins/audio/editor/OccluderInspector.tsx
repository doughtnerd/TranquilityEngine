// Under an AudioOccluder's fields in the Inspector (ADR 0162 E2, api-and-models §1.5, §7): what the wall does (its
// material's row with this wall's trims and openness applied), the colliders it applies to, an openness slider (the
// door script's field, tried by hand), and the warnings: no collider, no 3D physics service, another occluder
// overriding some of its colliders. The material, trims and the rest are the fields above.
import { editor, useFieldDrag, type InspectorSectionProps } from "../../../editor/sdk";
import type { AudioOccluder } from "../runtime/AudioOccluder";
import { analyzeOccluder, describeCost, materialLabel, materialTint, occluderCost, physics3dAvailable } from "./audioInspectorModel";
import { projectAudio } from "./projectAudio";
import "./audioInspectors.css";

const swatch = (color: number) => `#${color.toString(16).padStart(6, "0")}`;
const FIRST_NAMED = 4;

/** The colliders' names, the first few. */
function names(colliders: readonly { node: { name: string } }[]): string {
  const shown = colliders.slice(0, FIRST_NAMED).map((c) => c.node.name || "(unnamed)");
  return colliders.length > FIRST_NAMED ? `${shown.join(", ")} and ${colliders.length - FIRST_NAMED} more` : shown.join(", ");
}

export function OccluderSection({ scene, paths, info }: InspectorSectionProps) {
  editor.project.version; // the settings and the file list (tracked)
  const place = { scene, path: paths[0]!, type: info.type, index: info.index };
  const drag = useFieldDrag(place, "Drag openness");
  const occluder = info.component as AudioOccluder | null;
  if (!occluder) return null;
  const audio = projectAudio(editor.project.current?.settings);
  const report = analyzeOccluder(occluder, { physics3d: physics3dAvailable(), audio });
  const cost = occluderCost(occluder, audio);
  const closed = occluderCost(occluder, audio, 0);
  return (
    <div class="audio-section" aria-label="Occluder">
      {report.warnings.map((w) => (
        <p key={w.code + w.text} class="audio-note audio-note-warning" role="status" data-warning={w.code}>
          {w.text}
        </p>
      ))}
      <p class="audio-readout">
        <span class="audio-swatch" style={{ background: swatch(materialTint(audio, occluder.material)) }} />
        {materialLabel(audio, occluder.material)}: {cost.known || occluder.material === "" ? describeCost(closed) : "no such material"}.
      </p>
      <label class="audio-openness" title="0 closed, 1 open: blends this wall's effect away. Script it for a door.">
        Openness
        <input
          type="range"
          min={0}
          max={1}
          step={0.01}
          value={occluder.openness}
          aria-label="Openness"
          {...drag}
          onInput={(e) => editor.scene.writeField(place, "openness", Number((e.currentTarget as HTMLInputElement).value))}
        />
        <output>{Math.round(occluder.openness * 100) / 100}</output>
      </label>
      {occluder.openness > 0 && <p class="audio-readout">Now: {describeCost(cost)}.</p>}
      <p class="audio-note">
        {report.covered.length === 0 ? "Applies to no colliders." : `Applies to ${report.covered.length} collider${report.covered.length === 1 ? "" : "s"}: ${names(report.covered)}. They are outlined in the scene view.`}
      </p>
    </div>
  );
}

// Under an AudioZone's fields in the Inspector (ADR 0333). The fields themselves (sound, heard, feather, volume, centre,
// width, depth, yaw, bottom, top) are the card's rows; this section says how the zone is heard and warns when it has no
// sound, its sound isn't in the project, or its box has no height.
import { editor, type InspectorSectionProps } from "../../../editor/sdk";
import type { AudioZone } from "../runtime/AudioZone";
import { audioZoneHeardLine, audioZoneNotices } from "./audioZoneGizmoModel";
import "./audioInspectors.css";

export function AudioZoneSection({ info }: InspectorSectionProps) {
  editor.project.version; // the file list (tracked)
  const zone = info.component as AudioZone | null;
  if (!zone) return null;
  const notices = audioZoneNotices(zone, editor.project.current?.files ?? null);
  return (
    <div class="audio-section" aria-label="Audio zone">
      {notices.map((n) => (
        <p key={n.text} class={`audio-note${n.kind === "warning" ? " audio-note-warning" : ""}`} role="status">
          {n.text}
        </p>
      ))}
      <p class="audio-readout">{audioZoneHeardLine(zone)}</p>
    </div>
  );
}

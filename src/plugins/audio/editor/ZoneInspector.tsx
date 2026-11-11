// Under an AudioReverbZone's fields in the Inspector (ADR 0162 E2, api-and-models §1.5, §7). The fields themselves
// (shape, centre, size, radius, preset, impulse response, wet, blend distance, priority and the `output` bus, whose
// choices are the project's buses, empty being Master) are the card's rows, and the Edit Zone button is in its header.
// This section says which reverb plays, what the zone costs in memory (from Project Settings > Audio > Zones), and warns
// when the project's backend is Babylon (zones are inert there), when zones are off, or when the output bus or the
// impulse response doesn't exist.
import { editor, type InspectorSectionProps } from "../../../editor/sdk";
import type { AudioReverbZone } from "../runtime/AudioReverbZone";
import { audioOfProject, zoneCostLine, zoneNotices, zoneReverbLine } from "./audioInspectorModel";
import "./audioInspectors.css";

export function ZoneSection({ info }: InspectorSectionProps) {
  editor.project.version; // the settings and the file list (tracked)
  const zone = info.component as AudioReverbZone | null;
  if (!zone) return null;
  const audio = audioOfProject(editor.project.current?.settings);
  const notices = zoneNotices(zone, audio, editor.project.current?.files ?? null);
  const cost = zoneCostLine(audio);
  return (
    <div class="audio-section" aria-label="Reverb zone">
      {notices.map((n) => (
        <p key={n.text} class={`audio-note${n.kind === "warning" ? " audio-note-warning" : ""}`} role="status">
          {n.text}
        </p>
      ))}
      <p class="audio-readout">{zoneReverbLine(zone)}</p>
      {cost && <p class="audio-note">{cost}</p>}
    </div>
  );
}

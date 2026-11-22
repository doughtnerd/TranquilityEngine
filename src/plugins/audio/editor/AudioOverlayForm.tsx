// The Scene toolbar's audio overlay popover (ADR 0142), a toolbar item the Audio plugin registers: whether the occlusion
// overlay (`OcclusionOverlay.ts`) draws while the game plays. The Audio Debug panel held this checkbox until the editor's
// audio panels moved to the Audio Studio (ADR 0327).
import { occlusionOverlayOn } from "./OcclusionOverlay";

export function AudioOverlayForm() {
  return (
    <div class="snap-form audio-overlay-form">
      <label class="snap-row check" title="While playing: a line from each occluded source to the listener, with a marker where it hits a wall, coloured by how much it muffles">
        <input type="checkbox" checked={occlusionOverlayOn.value} aria-label="Occlusion rays" onChange={(e) => (occlusionOverlayOn.value = (e.currentTarget as HTMLInputElement).checked)} />
        <span>Occlusion rays</span>
      </label>
    </div>
  );
}

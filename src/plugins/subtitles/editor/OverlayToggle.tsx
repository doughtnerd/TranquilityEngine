// The Play toolbar's "Subtitles" toggle (ADR 0357 §6), contributed by the subtitles plugin's editor half: a per-user
// preference (local storage, `myco.editor.subtitlesOverlay`), and while it is on, the play session's first World gets
// the overlay display.
import { useEffect } from "preact/hooks";
import { editor, persisted } from "../../../editor/sdk";
import { syncSubtitlesOverlay } from "./playOverlay";

/** Per user: show the subtitle overlay in editor Play for scenes without a subtitle display. */
export const subtitlesOverlay = persisted<boolean>("myco.editor.subtitlesOverlay", false);

export function OverlayToggle() {
  const on = subtitlesOverlay.value;
  const world = editor.scene.playWorlds[0] ?? null;
  useEffect(() => syncSubtitlesOverlay(world, on), [world, on]);
  return (
    <button
      type="button"
      class={`play-subtitles${on ? " active" : ""}`}
      aria-pressed={on}
      title={on ? "Hide the subtitle overlay" : "Show subtitles over Play for scenes without a subtitle display (editor only, never saved)"}
      onClick={() => (subtitlesOverlay.value = !on)}
    >
      Subtitles
    </button>
  );
}

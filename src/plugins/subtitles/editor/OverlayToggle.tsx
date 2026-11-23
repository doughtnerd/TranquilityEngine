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
      class={`icon-button play-subtitles${on ? " active" : ""}`}
      aria-label="Subtitles"
      aria-pressed={on}
      title={on ? "Hide the subtitle overlay" : "Show subtitles over Play for scenes without a subtitle display (editor only, never saved)"}
      onClick={() => (subtitlesOverlay.value = !on)}
    >
      <SubtitlesIcon />
    </button>
  );
}

/** The Subtitles icon (a caption box with two lines of text), in `currentColor`; drawn like the editor's tool icons (class `tool-icon`). */
const SubtitlesIcon = () => (
  <svg class="tool-icon" width="16" height="16" viewBox="0 0 16 16" aria-hidden="true" focusable="false" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><rect x="1.8" y="3" width="12.4" height="9" rx="1.5" /><path d="M4.5 7 H7 M8.5 7 H11.5 M4.5 9.6 H6 M7.5 9.6 H11.5" /></svg>
);

// Pause and single-frame step for the whole play session (ADR 0022): the toolbar's Pause and Step
// buttons and their shortcuts (Ctrl/Cmd+Shift+P pauses or resumes; F10 or Ctrl/Cmd+Alt+P steps).
import { computed } from "@preact/signals";
import { playing } from "./session";

/**
 * True while the play session is paused; false while editing. Read from the session itself (its `paused` is a signal
 * it owns), so a pause from anywhere (`step`, `setPaused`) shows, not only this module's actions.
 */
export const playPaused = computed(() => playing.value?.paused ?? false);

/** Pause or resume the whole play session. No-op while editing. */
export function togglePause(): void {
  const session = playing.peek();
  if (session) session.setPaused(!session.paused);
}

/** Advance every World one frame (pausing first). No-op while editing. */
export function stepFrame(): void {
  playing.peek()?.step();
}

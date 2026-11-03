// Pause and single-frame step for the whole play session (ADR 0022): the toolbar's Pause and Step
// buttons and their shortcuts (Ctrl/Cmd+Shift+P pauses or resumes; F10 or Ctrl/Cmd+Alt+P steps).
import { effect, signal } from "@preact/signals";
import { playing } from "./session";

/** True while the play session is paused (follows the session; false while editing). */
export const playPaused = signal(false);

// A new session starts running; none is never paused.
effect(() => {
  playPaused.value = playing.value?.paused ?? false;
});

/** Pause or resume the whole play session. No-op while editing. */
export function togglePause(): void {
  const session = playing.peek();
  if (!session) return;
  session.setPaused(!session.paused);
  playPaused.value = session.paused;
}

/** Advance every World one frame (pausing first). No-op while editing. */
export function stepFrame(): void {
  const session = playing.peek();
  if (!session) return;
  session.step();
  playPaused.value = session.paused;
}

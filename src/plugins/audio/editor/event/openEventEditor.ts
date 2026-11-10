// Contract C4 (audio events M2, ADR 0158 §7): opening the Event editor. E6.3 fills the panel behind it; this file's
// export is what the asset kind's `open` and the "New Event" flow call, so `editor/index.ts` never changes for it.
import { signal } from "@preact/signals";
import { editor } from "../../../../editor/sdk";

/** The event asset open in the Event editor panel, or null. */
export const openEvent = signal<string | null>(null);

/** The Event editor panel's id (registered in `editor/index.ts`). */
export const EVENT_EDITOR_PANEL = "audioevent";

/** Open `path` (an `*.audioevent.json`) in the Event editor and bring the panel forward. */
export function openEventEditor(path: string): void {
  openEvent.value = path;
  editor.showPanel(EVENT_EDITOR_PANEL);
}

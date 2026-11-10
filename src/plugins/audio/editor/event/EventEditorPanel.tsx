// The Event editor panel (ADR 0158 §7). A placeholder until E6.3 fills it (tree, properties, parameters).
import { openEvent } from "./openEventEditor";

export function EventEditorPanel() {
  const path = openEvent.value;
  return <div class="event-editor-placeholder">{path ? `Event editor: ${path} (coming soon)` : "Open an audio event to edit it."}</div>;
}

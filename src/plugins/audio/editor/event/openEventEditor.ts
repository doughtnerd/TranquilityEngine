// Contract C4 (audio events M2, ADR 0158 §7): the Event editor panel's id. The `audioEvent` kind names it as its
// `panel` (ADR 0233), so double-clicking an event opens it there; the panel reads `editor.assets.openIn` with it.

/** The Event editor panel's id (registered in `editor/index.ts`). */
export const EVENT_EDITOR_PANEL = "audioevent";

// Who hears that an Engine was created or disposed, and of which kind. A file of its own with no imports but a type, as
// `audioConfigure.ts` is, so a plugin (the audio capture) can listen without importing `Engine.ts`. The audio capture
// frees its ring when the editor's Engine goes (a project closed) or when a game's Engine goes with no editor around (an
// exported game exits); the editor's per-Play runtime Engine going is a Play stop, which keeps the take for a save.
import type { WorldKind } from "./World";

export type EngineLifecycleEvent = "created" | "disposed";

const listeners = new Set<(event: EngineLifecycleEvent, kind: WorldKind) => void>();

/** @internal Adds a listener for every Engine's creation and disposal; returns the removal. */
export function onEngineLifecycle(listener: (event: EngineLifecycleEvent, kind: WorldKind) => void): () => void {
  listeners.add(listener);
  return () => void listeners.delete(listener);
}

/** @internal `Engine.create` and `Engine.dispose`: tells every listener; one that throws is logged and doesn't stop the others. */
export function notifyEngineLifecycle(event: EngineLifecycleEvent, kind: WorldKind): void {
  for (const listener of [...listeners]) {
    try {
      listener(event, kind);
    } catch (err) {
      console.error(`[myco] engine ${event} listener failed:`, err);
    }
  }
}

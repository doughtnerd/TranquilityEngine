// ADR 0157 (A0.8): who hears that an `Engine.create` reconfigured the one mixer. A file of its own, with no imports
// but a type, so the audio plugin's `service.ts` can listen without importing `Engine.ts` (which would pull the
// renderer into every module graph the plugin is in, before test mocks apply). `Engine._onAudioConfigured` is the
// same registry.
import type { AudioSettings } from "../audio/settings";

const listeners = new Set<(settings: AudioSettings) => void>();

/** @internal Adds a listener for each Engine's mixer reconfigure; returns the removal. */
export function onAudioConfigured(listener: (settings: AudioSettings) => void): () => void {
  listeners.add(listener);
  return () => void listeners.delete(listener);
}

/** @internal `Engine.create`: tells every listener; one that throws is logged and doesn't stop the others or `create`. */
export function notifyAudioConfigured(settings: AudioSettings): void {
  for (const listener of [...listeners]) {
    try {
      listener(settings);
    } catch (err) {
      console.error("[myco] audio reconfigure failed:", err);
    }
  }
}

// The Audio plugin's manifest (ADR 0133, 0157): AudioSource, AudioListener, the `Audio` helpers, the audio
// system and the `myco.audio` World service that loads the audio core. The mixer's model and the `audio`
// settings stay in `src/engine/audio/` (core modules, like navigation's settings).
import type { PluginManifest } from "../manifest";

export const audioManifest: PluginManifest = {
  name: "myco.audio",
  title: "Audio",
  description: "Sound playback: AudioSource, AudioListener, the mixer's buses and the Audio helpers.",
  // First-party plugins carry the engine's version: keep in step with package.json's "version".
  version: "1.0.0",
};

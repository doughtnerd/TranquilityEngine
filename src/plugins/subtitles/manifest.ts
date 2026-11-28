// The Subtitles plugin's manifest (ADR 0133, 0357 §5): the optional built-in subtitle display (`SubtitleDisplay`) and the
// player's subtitle settings (`Subtitles`), built only on public API (`Audio.onLine`, `Audio.onCaption`, `Locale`,
// `Storage` and a UI view), so a game can turn it off and build its own on the same events. On in new projects
// (first-party plugins default on, ADR 0133); it needs the Audio and UI plugins.
import type { PluginManifest } from "../manifest";

export const subtitlesManifest: PluginManifest = {
  name: "myco.subtitles",
  title: "Subtitles",
  description: "A drop-in subtitle and caption display with speaker names, sizes, a background box and player settings.",
  // First-party plugins carry the engine's version: keep in step with package.json's "version".
  version: "1.0.0",
  // Where the Add Component menu lists its Components.
  componentCategories: {
    UI: ["engine.SubtitleDisplay"],
  },
  dependencies: { "myco.audio": "1.0.0", "myco.ui": "1.0.0" },
  // Drawing only: the dedicated server has no screen to show subtitles on.
  server: false,
};

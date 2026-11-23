// The Play toolbar's Subtitles overlay (ADR 0343 §6): while it is on, editor Play gets a `SubtitleDisplay` (the subtitles
// plugin's, editor-only, never saved) on a node under the play World's root, so it survives scene loads. It stands aside
// while the game's scene has a display of its own, so lines can be checked before a game adds one. Needs the subtitles
// plugin on (Project Settings > Plugins).
import type { Engine } from "../engine/core/Engine";
import { GameObject } from "../engine/scene/GameObject";
import { isRuntimePluginActive } from "../plugins/runtimeContext";
import { subtitlesManifest } from "../plugins/subtitles/manifest";
import { SubtitleDisplay } from "../plugins/subtitles/runtime";

const OVERLAY_NAME = "Subtitles (editor overlay)";

/** Why the overlay can't show anything (the plugin is off), or null when it can. */
export function subtitlesOverlayUnavailable(): string | null {
  return isRuntimePluginActive(subtitlesManifest.name) ? null : "Subtitle overlay: the Subtitles plugin is off for this project (Project Settings > Plugins).";
}

const overlays = new WeakMap<Engine, GameObject>();

/** Adds the overlay display to `engine`'s main World when `on` (and the plugin is on), or removes it. Idempotent. */
export function syncSubtitlesOverlay(engine: Engine | null, on: boolean): void {
  if (!engine) return;
  const existing = overlays.get(engine);
  const want = on && subtitlesOverlayUnavailable() === null;
  if (!want) {
    if (existing?.isValid) GameObject.destroy(existing);
    overlays.delete(engine);
    return;
  }
  if (existing?.isValid) return;
  const world = engine.world;
  const node = GameObject.create(OVERLAY_NAME, { parent: world.root, transform: false });
  const display = node.addBehavior(SubtitleDisplay);
  display._overlay = true;
  overlays.set(engine, node);
}

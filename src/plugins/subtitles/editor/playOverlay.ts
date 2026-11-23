// The Play toolbar's Subtitles overlay (ADR 0357 §6): while it is on, editor Play gets a `SubtitleDisplay` (editor-only,
// never saved) on a node under the play session's first World's root, so it survives scene loads. It stands aside while
// the game's scene has a display of its own, so lines can be checked before a game adds one. The plugin's editor half
// contributes the toggle (`OverlayToggle`), so it is there only while the plugin is on.
import type { World } from "../../../engine/core/World";
import { GameObject } from "../../../engine/scene/GameObject";
import { SubtitleDisplay } from "../runtime";

const OVERLAY_NAME = "Subtitles (editor overlay)";

const overlays = new WeakMap<World, GameObject>();

/** Adds the overlay display to `world` (a play World) when `on`, or removes it. Idempotent; nothing without a World. */
export function syncSubtitlesOverlay(world: World | null, on: boolean): void {
  if (!world) return;
  const existing = overlays.get(world);
  if (!on) {
    if (existing?.isValid) GameObject.destroy(existing);
    overlays.delete(world);
    return;
  }
  if (existing?.isValid) return;
  const node = GameObject.create(OVERLAY_NAME, { parent: world.root, transform: false });
  node.addBehavior(SubtitleDisplay)._overlay = true;
  overlays.set(world, node);
}

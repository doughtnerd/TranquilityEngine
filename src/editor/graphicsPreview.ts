// Graphics quality in the editor (ADR 0050): the tier the scene view previews, and keeping the
// running engine's tiers in step with project.json as the Project panel edits them.
import { signal } from "@preact/signals";
import type { GraphicsSettings } from "../engine/core/graphics";
import { Graphics } from "../engine/render/Graphics";

/** The previewed tier's name (the Scene view's Quality menu shows it). */
export const previewedQuality = signal<string>(Graphics.quality);
/** The tiers' names, as the running engine has them. */
export const qualityTiers = signal<readonly string[]>(Graphics.tiers);

/** Preview a tier in the editor's views. Never saved as the player's choice. */
export function previewQuality(name: string): void {
  if (Graphics._apply(name)) previewedQuality.value = Graphics.quality;
}

/** Give the running engine the project's tiers (after project.json changes), keeping the previewed tier if it still exists. */
export function reloadGraphics(graphics: GraphicsSettings): void {
  Graphics._configure(graphics, Graphics.quality);
  qualityTiers.value = Graphics.tiers;
  previewedQuality.value = Graphics.quality;
}

// Clips among Assets panel entries (ADR 0022, 0158 §7). The Event editor's tree registers as a drop target with the
// SDK (`registerAssetDropTarget`); this holds the filter it and the clip field share.
import { draggedAssets, editor } from "../../../../editor/sdk";

/** The audio clips among asset browser entries (folders end in "/"; slices carry "#"), in order. */
export function audioPaths(paths: readonly string[]): string[] {
  return paths.filter((p) => !p.endsWith("/") && !p.includes("#") && editor.assets.kindOf(p) === "audio");
}

/**
 * The audio clips an asset browser drag carries now, or `[]` when none is in progress (or it carries no audio). The
 * argument is ignored (it was the pointer's buttons). Reads without subscribing. A panel that takes drops should
 * `registerAssetDropTarget` instead; this stays for the node properties' clip field.
 */
export function draggedClips(_buttons?: number): string[] {
  return audioPaths(draggedAssets() ?? []);
}

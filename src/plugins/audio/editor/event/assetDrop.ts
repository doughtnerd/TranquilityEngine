// Taking clips dragged from the asset browser (ADR 0022, 0158 §7). The browser's drag is pointer based, carries the
// Assets panel's selection, and has no drop targets in plugin panels (its state lives behind the shell, out of the
// SDK's reach). So the Event editor recognises one from what it can see: the primary button held, the drag's label
// following the pointer (`.asset-drag-ghost`) naming the selection, and audio among the selected entries. It acts on
// the pointer's release over it; the browser's own release then finds no target there and does nothing.
import { editor, selectedAssets } from "../../../../editor/sdk";

/** The audio clips among asset browser entries (folders end in "/"; slices carry "#"), in order. */
export function audioPaths(paths: readonly string[]): string[] {
  return paths.filter((p) => !p.endsWith("/") && !p.includes("#") && editor.assets.kindOf(p) === "audio");
}

/** The name the drag label uses for `paths` (assetDrag.ts `dropDescription`): one file's name, or "n items". */
const dragName = (paths: readonly string[]): string => (paths.length === 1 ? editor.assets.fileName(paths[0].replace(/\/$/, "")) : `${paths.length} items`);

/**
 * The audio clips an asset browser drag carries now, or `[]` when none is in progress (or it carries no audio). `buttons`
 * is the pointer event's (a drag holds the primary button; a release passes `1`). Reads without subscribing.
 */
export function draggedClips(buttons: number): string[] {
  if ((buttons & 1) === 0 || typeof document === "undefined") return [];
  const ghost = document.querySelector(".asset-drag-ghost");
  const selected = selectedAssets.peek();
  if (!ghost || selected.length === 0 || !ghost.textContent?.includes(dragName(selected))) return [];
  return audioPaths(selected);
}

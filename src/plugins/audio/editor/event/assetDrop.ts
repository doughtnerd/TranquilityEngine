// Taking clips dragged from the asset browser (ADR 0022, 0158 §7). The browser's drag is pointer based and has no
// drop targets in plugin panels, so the Event editor reads the drag in progress (`assetDrag`) while the pointer is
// over it and acts on the pointer's release there; the browser's own release then finds no target and does nothing.
import { assetDrag, editor } from "../../../../editor/sdk";

/** The audio clips among dragged asset browser entries (folders end in "/"; slices carry "#"), in order. */
export function audioPaths(paths: readonly string[]): string[] {
  return paths.filter((p) => !p.endsWith("/") && !p.includes("#") && editor.assets.kindOf(p) === "audio");
}

/** The audio clips being dragged from the asset browser now (empty when nothing is, or nothing dragged is audio). */
export function draggedClips(): string[] {
  const drag = assetDrag.value;
  return drag ? audioPaths(drag.paths) : [];
}

/** Whether an asset browser drag is in progress (subscribes the caller). */
export const assetDragging = (): boolean => assetDrag.value !== null;

/** The audio clips of the drag at its release (read without subscribing; call from a pointerup handler). */
export function releasedClips(): string[] {
  const drag = assetDrag.peek();
  return drag ? audioPaths(drag.paths) : [];
}

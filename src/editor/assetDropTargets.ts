// Drop targets for assets dragged from the Assets panel (ADR 0022), for plugin panels (the editor SDK, ADR 0147). The
// asset browser's drag (assetDrag.ts) asks the registered element under the pointer what releasing would do, shows its
// label on the drag's ghost, and calls it on release. This module holds only the registry and the drag in progress, and
// imports nothing, so the SDK can export it without reaching the shell's state or the plugin list.

/** Where the pointer is, in client pixels. */
export interface AssetDropPoint {
  x: number;
  y: number;
}

export interface AssetDropTargetSpec {
  /** Whether this target takes these Assets panel entries at all (folders end in "/"); false shows "can't drop here". */
  accepts(assets: readonly string[]): boolean;
  /** What releasing at `point` does, for the drag's label ("Add the clip in random at 2"), or null when nothing can be dropped there. */
  label(assets: readonly string[], point: AssetDropPoint): string | null;
  /** Releasing at `point`, after `label` gave a message there. */
  drop(assets: readonly string[], point: AssetDropPoint): void;
  /** The pointer moves over the element with a drag `accepts` took (also when `label` gave null): show a drop indicator. */
  over?(assets: readonly string[], point: AssetDropPoint): void;
  /** The pointer left the element, or the drag ended (dropped or cancelled): clear the indicator. */
  leave?(): void;
}

const targets = new Map<HTMLElement, AssetDropTargetSpec>();
let current: readonly string[] | null = null;

/**
 * Make `element` (and what it contains) a drop target for Assets panel drags. The innermost registered element under
 * the pointer wins. Returns the function that unregisters it (call it when the panel unmounts).
 */
export function registerAssetDropTarget(element: HTMLElement, spec: AssetDropTargetSpec): () => void {
  targets.set(element, spec);
  return () => {
    if (targets.get(element) === spec) targets.delete(element);
  };
}

/** The registered target at or above `el`, innermost first. */
export function dropTargetFor(el: Element | null): { element: HTMLElement; spec: AssetDropTargetSpec } | null {
  for (let e: Element | null = el; e; e = e.parentElement) {
    const spec = targets.get(e as HTMLElement);
    if (spec) return { element: e as HTMLElement, spec };
  }
  return null;
}

/** The Assets panel entries being dragged now, or null when no drag is in progress. Read it without subscribing. */
export function draggedAssets(): readonly string[] | null {
  return current;
}

/** The asset drag sets what it carries while it runs (null when it ends). */
export function setDraggedAssets(paths: readonly string[] | null): void {
  current = paths;
}

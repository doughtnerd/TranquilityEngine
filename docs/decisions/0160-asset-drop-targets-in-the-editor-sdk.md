# 0160. Plugin panels accept assets dragged from the Assets panel through `registerAssetDropTarget` in the editor SDK

- **Status:** Accepted
- **Date:** 2026-11-10
- **Deciders:** Chris Carlson
- **Supersedes:** —
- **Related:** 0147 (the editor SDK, `myco/editor`), 0158 (the Event editor accepts clips)

## Context

Dragging an asset from the Assets panel (`src/editor/assetDrag.ts`) knows three kinds of target: the viewport, the hierarchy and asset folders. A plugin panel had no way to take part. The M2 Event editor (E6.3) needed clips dropped into its tree, and exporting the drag's state through the SDK failed `src/plugins/plugins.test.ts`, because `assetDrag.ts` reaches the shell's state and through it the plugin list (a load cycle for `myco/editor`). E6.3 shipped a workaround that guessed a drag from the screen, while the browser's drag label said the drop wouldn't work.

## Decision

We will add asset drop targets to the editor SDK:

- `registerAssetDropTarget(element, spec)` returns an unregister function. `spec` is `{ accepts(assets): boolean; label(assets, point): string | null; drop(assets, point): void; over?(assets, point): void; leave?(): void }`, with `point` in client pixels. While an asset drag is over a registered element (the innermost one wins), the drag's label shows `label(...)`; `accepts` false or a null label shows a red "can't drop here"; releasing calls `drop`; `leave` fires when the pointer moves off, on drop and on cancel.
- `draggedAssets()` returns the entries a drag carries, or null (read-only).
- The registry lives in an import-free module (`src/editor/assetDropTargets.ts`), so the SDK stays clear of the shell and the plugin list. `assetDrag.ts` consults it before its own viewport, hierarchy and folder targets, which are unchanged.

## Alternatives considered

- **Export `assetDrag`'s state through the SDK.** It pulls the plugin list into `myco/editor` (the boundary test's no-cycle rule).
- **Reading the drag off the screen** (E6.3's workaround). Fragile, and the browser's label contradicted the panel.
- **HTML5 drag and drop.** The asset drag is pointer-driven (it also drives the viewport's placement preview); switching would change every target.

## Consequences

**Positive**
- Any plugin panel can accept assets with a correct drag label; the Event editor's workaround is gone.

**Negative / costs**
- Two more SDK exports to keep stable for third-party plugins.

## Deprecates

`selectedAssets` in the SDK (added during E6.3, now unused by plugins) can be removed once nothing uses it. `draggedClips` in the audio plugin stays a thin wrapper over `draggedAssets()` until its last caller (`NodeProperties.tsx`'s clip select) moves to a drop target.

## Open questions

- Whether the viewport, hierarchy and folders move onto the same registry.

## References

- `src/editor/assetDropTargets.ts`, `src/editor/assetDrag.ts`, `src/editor/sdk/index.ts`; `src/plugins/audio/editor/event/EventTree.tsx`; M2 task E6.3b.

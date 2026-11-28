# 0455. Every editor press-and-drag is the one pointer gesture

- **Status:** Accepted
- **Date:** 2026-11-28
- **Deciders:** Chris Carlson
- **Supersedes:** —
- **Related:** 0022, 0174, 0259, 0278

## Context

ADR 0278 made `src/editor/pointerDrag.ts` the gesture for dragging Hierarchy rows, but three more copies of the same loop stayed: asset tiles (`assetDrag.ts`), dock panel tabs (`layout/DockLayout.tsx`) and the Assets panel's selection box (`ui/Assets.tsx`). Each had its own threshold constant (5, 5 and 4 pixels), and the Assets tile's click suppression typed 5 again by hand. The box select never listened for `pointercancel`, so a cancelled pointer left the box and its move listener up until the next release. The shared gesture couldn't take the others' place because `end(drop: boolean)` couldn't tell a plain click from a cancel, and the dock tab needs the click (it shows the tab).

## Decision

We will drag every editor press through `startPointerDrag` in `pointerDrag.ts`, with one threshold:

```ts
type PointerDragEnd = "drop" | "click" | "cancel";
interface PointerDragHandlers {
  begin?(e: PointerEvent, doc: Document): void; // the press just became a drag, before its first move
  move(e: PointerEvent, doc: Document): void;   // while dragging, and at the release point
  end(how: PointerDragEnd): void;              // window listeners already removed
}
function startPointerDrag(e: PointerEvent, handlers: PointerDragHandlers): void;
function isDragDistance(a: ClientPoint, b: ClientPoint): boolean; // click suppression, same threshold
```

Releasing after a drag is `drop`; releasing before the threshold is `click`; Escape while dragging (swallowed) or a cancelled pointer at any time is `cancel`. Listeners live on the press's window (ADR 0174). The graph canvas keeps its own pan-and-zoom `startPointerDrag` (ADR 0259), which works in graph units.

## Alternatives considered

- **Keep `end(drop)` and add an `onClick`** — two callbacks for one ending; callers would have to know which fires when.
- **A per-caller threshold option** — the 4-pixel box select was an accident, not a need.

## Consequences

**Positive**
- One threshold and one listener set; the box select ends on `pointercancel` like the rest.
- Callers write only what their drag does.

**Negative / costs**
- Small behaviour changes: the selection box starts at 5 pixels, not 4; Escape before the box has moved is no longer swallowed by it (the release then counts as a click); a cancelled pointer on a dock tab that never moved no longer shows that tab.

## Deprecates

The drag loops in `assetDrag.ts`, `DockLayout.tsx` and `ui/Assets.tsx`, and their threshold constants: removed.

## As built

`pointerDrag.ts` (tested in `pointerDrag.test.ts`; its Escape listener is added and removed with `{ capture: true }`, because Node's `EventTarget`, which headless tests drive, doesn't remove a listener by a bare `true`); callers `nodeDrag.ts`, `uiElementDrag.ts`, `ui/RuntimeHierarchy.tsx`, `assetDrag.ts`, `layout/DockLayout.tsx`, `ui/Assets.tsx` (box select and tile click suppression).

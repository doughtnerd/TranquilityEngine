# 0468. One rule turns a click or box gesture into a selection

- **Status:** Accepted
- **Date:** 2026-11-28
- **Deciders:** Chris Carlson
- **Supersedes:** —
- **Related:** 0022, 0228, 0373

## Context

How a gesture's modifier keys combine a click or a box with the selection was written in eight places: the scene view and hierarchy (`selectionModel.ts`: `selectModeFor`, `combineSelection`), the graph panels (`graph/selection.ts` item presses, `graph/canvas.tsx` `startBoxSelect`), the animation graphs (`MachineCanvas`, `PoseCanvas`), the dope sheet (`DopeSheetGrid`'s `modeOf`, a verbatim copy), the Animation and Timeline windows (their own combine), and the Assets panel (`boxSelection`, `clickSelection`). The copies drifted:

- Shift-clicking an already-selected node kept it selected in the scene view but deselected it in every graph canvas (they treated Shift as a toggle).
- A Ctrl/Cmd box in a graph only added; in the scene view and the Assets panel it toggled each hit.

The scene view's rule is the canonical one (ADR 0022): Shift adds, Ctrl/Cmd toggles (and wins over Shift), no modifier replaces.

## Decision

We will keep the rule in one pure module, `src/editor/selectMode.ts` (no editor imports, so the graph view and plugins can use it):

```ts
type SelectMode = "replace" | "add" | "toggle";
selectModeFor(e: { shiftKey; ctrlKey; metaKey }): SelectMode;               // Ctrl/Cmd → toggle, Shift → add, else replace
combineSelection(current, hits, mode): string[];                            // a box (or any set of hits)
pressSelection(selected, id, mode): readonly string[];                      // a press on one draggable item
```

`pressSelection`: Shift adds, Ctrl/Cmd toggles, a plain press selects just the item unless it is already selected, when the selection stays so the drag that follows moves every selected item (what the graph canvases and dope sheet already did). It returns `selected` itself when nothing changes.

The graph view wraps it for its sets: `pressItem(selection, id, e)` in `graph/selection.ts` (used by `useGraphSelection` and the animation graphs) and `startBoxSelect`, which now combines with `combineSelection`. The editor SDK exports `combineSelection`, `pressSelection`, `selectModeFor` and `SelectMode`; `DopeSelectMode` is now an alias of `SelectMode`. Every copy listed above calls these.

## Alternatives considered

- **Extend `selectionModel.ts` in place** — it imports the scene document and node keys, which would pull scene code into the graph view and the SDK's graph surface; the hierarchy-specific helpers stay there instead.
- **Keep Shift as a toggle in graphs** — the graphs were the odd ones out; the scene view, hierarchy and Assets panel all add on Shift.

## Consequences

**Positive**
- One rule in every selectable view; a new view calls `selectModeFor` and `combineSelection`/`pressSelection`.

**Negative / costs**
- Behaviour change in the Shader Graph, Particle Graph and animation graphs: Shift-pressing a selected node keeps it selected (was: deselected), and a Ctrl/Cmd box toggles each boxed node (was: added). No e2e spec exercised the old behaviour.
- `combineSelection` drops duplicate hits, so the Animation window's selection no longer double-toggles a key reached through two rows.

## Deprecates

`assetSelection.ts` `boxSelection` (removed; the Assets panel calls `combineSelection`), `DopeSheetGrid`'s `modeOf`, the Animation and Timeline windows' own combine, and the inline press logic in `graph/selection.ts`, `MachineCanvas` and `PoseCanvas`.

## Open questions

None.

## References

As built: `src/editor/selectMode.ts` (+ `selectMode.test.ts`), `src/editor/graph/selection.test.ts` (both bugs through `pressItem` and `startBoxSelect`).

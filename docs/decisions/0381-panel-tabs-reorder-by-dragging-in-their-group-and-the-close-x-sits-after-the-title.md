# 0381. Panel tabs reorder by dragging within their group, and the close × sits right after the title

- **Status:** Accepted
- **Date:** 2026-11-23
- **Deciders:** Chris Carlson
- **Supersedes:** —
- **Amends:** 0174 (where the close × sits and its colour)
- **Related:** 0174, 0182

## Context

ADR 0174 gave every closable panel's tab a red **×** (`var(--danger)`) "at its right end". In a group holding one panel, the tab is drawn as the group's title and stretches across the header, so the × ended up at the far right of the panel, away from the title it closes, and always red, which drew the eye to a destructive control on every panel.

Tabs in one group could not be put in another order. Dragging a tab onto a header (`movePanel` with a `tab` target) always appended it, and dragging a tab onto its own group's header moved it to the end, so the only way to reorder was to drag tabs out and back in one by one.

## Decision

- **The ×** sits right after the panel's title (6 px gap), in a solo title as in a tab strip. It is drawn in the muted text colour (`var(--muted)`) and turns red (`var(--danger)`) on hover and on keyboard focus (`:focus-visible`). Everything else 0174 says about it holds (not drawn in a collapsed strip, never on the Scene view).
- **A `tab` drop target carries an optional slot**: `{ kind: "tab"; group; index? }` in `layout/model.ts`. `index` is the slot in the group's *current* tab order (0 before the first tab, `panels.length` after the last); `movePanel` inserts there (accounting for the panel leaving its own group) and shows the panel. Without `index` the panel goes last, as before. A move to where the tab already is returns the same layout, like every other no-op move.
- **`hitTest` takes the drawn tabs**: an optional `Record<groupId, TabSpan[]>` (`{ panel, start, end }` along the header, in layout coordinates, hidden tabs left out). Over an expanded group's header it returns the slot whose tab middle is past the pointer, and an `insert` rect: a thin mark between the tabs. Over the panel's own group it reorders, shown by the mark alone (`preview` absent); over another group it joins at that slot, with the group highlighted as before. Over a collapsed strip, or without spans, it behaves as before. The geometry stays pure; `DockLayout.tsx` measures the tabs from the DOM once when a drag starts.
- The new order is just the group's `panels` order, so it is saved and restored by the existing layout store and saved layouts with no format change.

## Alternatives considered

- **A separate `reorderPanel(layout, panel, index)` operation.** The same move as a slotted `tab` target onto the panel's own group; a second entry point would duplicate `movePanel`'s copy, normalise and no-op checks, and dropping on another group at a position would still need the slot.
- **Native HTML drag-and-drop on the tabs.** The dock layout already drags with pointer events (threshold, Escape, preview, detached windows); a second drag system for one case would conflict with it.
- **Keeping the × at the right end of a solo title.** It is far from the title on wide panels; next to the title it reads as closing that panel.

## Consequences

**Positive**
- Tabs reorder by dragging, with a visible insertion point, and dragging to another group lands where the mark shows.
- The × is quieter until wanted, and sits by the title it closes.

**Negative / costs**
- `DropHit.preview` is now optional; callers draw it only when present.
- Reordering in a collapsed strip isn't offered (its tabs span several groups).

## Deprecates

Nothing.

## Open questions

- Keyboard reordering of tabs (tabs aren't focusable today).

## References

- `src/editor/layout/model.ts` (`movePanel`, `hitTest`, `TabSpan`), `src/editor/layout/DockLayout.tsx` (`drawnTabs`), `src/editor/layout/PanelHeader.tsx`, `src/editor/ui/editor.css`.

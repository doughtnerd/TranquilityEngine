# 0180. Editor popovers are one module that knows its window; one tracker follows focus in every editor window

- **Status:** Accepted
- **Date:** 2026-11-16
- **Deciders:** Chris Carlson
- **Supersedes:** —
- **Related:** 0145 (amended: one focus tracker), 0174 (amended: popovers), 0147

## Context

ADR 0174 lets panels render in detached windows: the main window's JavaScript renders into a same-origin child, so a component's code runs in the main realm while its elements live in the child's document. `windows/dom.ts` finds an element's own window and document, and commit 405d2dc moved twelve files onto it. What it left:

- **Ten copies of popover wiring.** Every menu and small floating panel (the Assets and Hierarchy context menus, the scene tab menu, the dock's overflow and header menus, the Inspector's component Worlds menu, the Scene toolbar's popovers, the play bar's Gizmos menu, the particle graph's value popovers, the menu bar's drop-down) added its own `pointerdown` / `keydown` / `blur` listeners, focused its first button by hand, and placed itself one of two ways: a guessed 26 px row height, or measuring once drawn. Copies that 405d2dc missed still listened on and clamped to the main window: in a detached Assets panel a press outside its context menu didn't close it and Escape did nothing; the Gizmos menu and the particle graph's popovers had the same fault.
- **Two copies of focus tracking.** `activeHistory.ts` (the focused panel root) and `assetDocuments.ts` (the focused asset document) each listened for `focusin` and `pointerdown` in every editor window, sharing `KEEPS_HISTORY_FOCUS`; ADR 0145 noted they "must stay in step". `editorShown`, which keeps a replaced asset editor from staying the active history, looked only in the main window's document, so Undo with focus in an asset editor in a detached window undid the scene.

## Decision

We will have one popover module and one editor focus tracker.

**`src/editor/ui/popover.ts`** owns a popover's anchor, its window, placement, dismissal and focus:

- `openPopover(el, options)` returns `{ window, place(), close() }`; `usePopover(ref, open, options)` opens it at the element's first layout while `open` is true (again when a point anchor moves, an element anchor changes, or `key` changes) and closes it after.
- **Window:** the anchor element's owner window, else the popover's own. It listens and measures there, never in the main window by default.
- **Placement:** `anchor` is a point (its top-left corner there, top-right with `align: "end"`) or an element (`side` below or above, `align` start or end, `gap`); measured once drawn and kept `margin` px inside the window's viewport, flipping to the other side of an anchor element when only that side has room. No anchor: CSS places it and the module doesn't move it. A component with an anchor doesn't set `left` / `top` itself.
- **Dismissal:** a press outside the popover and its `inside` elements (its toggle button), Escape (stopped there, so the editor's own Escape handling doesn't also run; `escape: false` for owners with their own keys), the window's `blur` (`blur: false` for a popover holding a colour input, whose picker takes the focus), or focus moving from it to another element outside. `onDismiss(reason)` is called once and the owner stops showing it.
- **Focus:** `focusFirst` focuses its first enabled control when it opens; Escape gives the focus back to what had it when it opened. Other dismissals leave focus where the user put it, and an item's action owns focus after a choice.
- The editor SDK exports `openPopover`, `usePopover` and their types (ADR 0147), so plugin editor halves use it too.

**`src/editor/windows/editorFocus.ts`** exports `editorFocus`, the element focus or the last press went to in any editor window (the main one and each detached window, followed through `forEachEditorWindow` from when the module loads), skipping presses and focus inside `KEEPS_HISTORY_FOCUS`, which moves here. `activeHistory.ts` computes the focused panel root from it, so a panel that registers with focus already inside counts without reading `document.activeElement`; `assetDocuments.ts` computes `focusedAssetDocument` from it, letting go when documents are dropped or deleted. `editorShown` looks in every editor window's document.

## Alternatives considered

- **Fix the missed copies in place** with `windows/dom.ts`, as 405d2dc did. That is what left them: each new menu copies one of the existing ones, and nothing says which is right.
- **A `<Popover>` component that renders the floating element itself.** The popovers differ in markup (`role="menu"` with items, a `role="dialog"` form, the menu bar's whole strip) and some are CSS-positioned inside their button's wrapper; a hook over the owner's own element fits all of them without a wrapper element.
- **Keep two focus trackers on a shared helper.** It would still be two listeners per window and two places that apply `KEEPS_HISTORY_FOCUS`.

## Consequences

**Positive**
- Menus and popovers dismiss, clamp and focus in the window they're in; a new one gets that by calling one hook.
- Menus no longer guess their height; all are measured.
- One listener pair per editor window follows focus; history resolution works the same in a detached window.
- The test-only `_resetActiveHistory` and `trackHistoryFocus` are gone: tests register fake editor windows (`registerEditorWindow`) and unregister what they registered.

**Negative / costs**
- Dismissal is a little wider than some copies had: the Inspector's Worlds menu, the Scene toolbar's popovers, the Gizmos menu and the dock's overflow menu now also close when their window loses focus, and all popovers close when focus moves out to another element.
- The editor focus is a module-level signal that starts listening when its module loads; it outlives any one test, so tests set it by firing events rather than resetting it.

## Deprecates

- The per-component listener and placement code in `Assets.tsx`, `HierarchyMenu.tsx`, `SceneTabs.tsx`, `DockLayout.tsx` (overflow and header menus), `Inspector.tsx` (`ComponentMenu`), `SceneTools.tsx`, `PlayStats.tsx`, `MenuBar.tsx` (the drop-down's outside press and blur) and the particle graph's `valueFields.tsx`: removed.
- The focus listeners in `activeHistory.ts` and `assetDocuments.ts`, `trackHistoryFocus` and `_resetActiveHistory`: removed. `KEEPS_HISTORY_FOCUS` moves from `assetDocuments.ts` to `windows/editorFocus.ts`.

## Open questions

- The Add Component menu and the Scene view's refine list keep their own full-window backdrops and placement (a width matched to the anchor, a capped height, flyouts beside rows); they already work in any window. They could move onto the module if it gains a max-height rule.
- The menu bar's submenus still place themselves against the main window; the menu bar only renders there.

## References

- `src/editor/ui/popover.ts`, `popover.test.ts`; `src/editor/windows/editorFocus.ts`, `editorFocus.test.ts`; `src/editor/activeHistory.test.ts` (an asset editor focused in a detached window).

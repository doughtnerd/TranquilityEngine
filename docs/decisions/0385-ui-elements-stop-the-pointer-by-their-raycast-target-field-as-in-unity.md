# 0385. UI elements stop the pointer by their `raycastTarget` field, as in Unity

- **Status:** Accepted
- **Date:** 2026-11-24
- **Deciders:** Chris Carlson
- **Supersedes:** — (amends 0069's pointer routing: "tested against interactable UI")
- **Related:** 0069, 0076, 0077, 0310, 0340

## Context

The UI core (`src/engine/ui/UICore.ts`, ADR 0076) routes the pointer before scripts run, but until now it tested
only buttons and input fields (0069: "the pointer is tested against interactable UI"). A HUD panel, a dialog's
backdrop, an image or a line of text let a press through to the game: a click on a pause dialog's dimmed backdrop
fired the gun behind it, and `Input.pointerOverUI` was false over a leaderboard. The review raised this as Q14. The
owner's answer: follow Unity, with a toggle per element.

In Unity's uGUI every `Graphic` (`Image`, `RawImage`, `Text`, TextMeshPro text) has `raycastTarget`, true by default.
The `GraphicRaycaster` returns the topmost graphic with it on. The event then goes to the nearest handler at or above
that graphic (a `Button` higher up gets the click from its label). A graphic with no handler still takes the hit, so
the click does nothing and `EventSystem.IsPointerOverGameObject()` is true. A RectTransform with no Graphic is never
hit. A transparent `Image` still blocks, which is the usual way to make an invisible click blocker.

## Decision

- **The field.** Every UI element (`UIPanel`, `UIText`, `UIImage`, `UIButton`, `UIInputField`; the shared
  `UIElement` base) has `@field(Boolean) raycastTarget = true`. It is public API on the components, so it appears in
  the inspector's generic field list. A UI document can set it with the `raycastTarget="false"` attribute (also
  `raycast-target`), and a stylesheet with `raycast-target: false`, like every other field (0077).
- **What counts as a graphic** (`elementKinds.ts`, a `graphic` entry in the kind table and `isRaycastTarget`):
  text, images, buttons and input fields always. A panel counts when it has a `backgroundColor` (any alpha, even 0)
  or `borderWidth > 0`. A panel with neither is a layout box, Unity's empty RectTransform, and is never hit, so a
  full-screen layout column doesn't swallow the game's clicks. Opacity doesn't matter, as in Unity. A hidden element
  (`visible: false`, `display: none`, inactive or disabled) is never hit.
- **The hit.** The core takes the topmost shown element that is a raycast target: screen canvases from the highest
  `sortOrder`, each in reverse draw order, then world canvases nearest first. Its *handler* is that element or its
  nearest button or input field ancestor (Unity's bubbling).
  - Any hit claims the pointer (`Input.pointerOverUI`; presses don't reach `Input`).
  - A handler is hovered, pressed, clicked and focused as before.
  - A hit with no handler does nothing, and a press there unfocuses, as a press elsewhere does.
  - `raycastTarget` off: the pointer passes through to what's behind, whether other UI or the game.
  - The field is per element (Unity's `Graphic`, not `CanvasGroup.blocksRaycasts`). A button with it off can still be
    pressed through a label that has it on.
- **Unchanged:** `interactable = false` still blocks without hovering, and the editor's scene view (non-interactive
  core) still doesn't route.

## Alternatives considered

- **Only interactive elements block (keep 0069).** The review's option (b). It's simpler, but games then have to
  check every HUD rectangle by hand, and Unity users expect panels to block.
- **Every panel blocks, background or not (strict "Panel is a graphic").** A full-screen layout panel, the usual root
  of a HUD, would swallow every game click. Unity's equivalent (an empty RectTransform) doesn't block either.
- **CSS `pointer-events: none | auto` as the field.** It's familiar from the web, but it's a second name for the same
  thing and isn't Unity's. The stylesheet already reaches the field as `raycast-target`.
- **A subtree switch (Unity's `CanvasGroup.blocksRaycasts`).** Useful, but it's a separate feature. It can come later
  without changing this field.

## Consequences

**Positive**
- Dialogs, HUD panels, images and text over the game stop clicks reaching the game, as Unity users expect, and
  `Input.pointerOverUI` is true over them.
- One field turns it off per element, from code, the inspector, markup or a stylesheet.

**Negative / costs**
- **Behaviour change for existing games (migration).** Clicks on text, images and panels with a background or
  border no longer reach the game, and `Input.pointerOverUI` is true over them. A game that relied on clicking
  through decoration has to set `raycastTarget = false` on it: markers, hint lines, crosshairs, a full-screen tint.
  The pirates sample's HUD does this for its edge markers, its edge and fog notes and its status lines.
  A screen-wide background panel now blocks the game. Remove its background, or turn its `raycastTarget` off.
- Hit testing walks every laid-out element of a canvas instead of only the interactive ones. That's linear in the
  element count, once per frame.

## Deprecates

0069's sentence "the pointer is tested against interactable UI" and the guide's "Panels, text and images don't block
it". Both now read as this record says.

## Open questions

- A subtree switch like `CanvasGroup.blocksRaycasts`/`interactable`, if games ask for it.
- Hit shapes other than the box (rounded corners, image alpha: Unity's `alphaHitTestMinimumThreshold`).

## References

- Unity manual, `UnityEngine.UI.Graphic.raycastTarget`, `GraphicRaycaster`, `EventSystem.IsPointerOverGameObject`.
- `src/engine/ui/components.ts` (`UIElement.raycastTarget`), `src/engine/ui/elementKinds.ts` (`isRaycastTarget`),
  `src/engine/ui/UICore.ts` (`hit`, `route`).
- Tests: `src/engine/tests/uiCore.test.ts` ("UICore raycast targets"), `src/engine/tests/uiDocument.test.ts`
  (attribute and stylesheet property).
- Guide: `docs/wiki/guide/ui.md`, "The pointer goes to UI first".

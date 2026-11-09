# 0142. Collider editing is a Physics viewport tool; plugins add Scene toolbar popovers, component header controls and selectable outlines

- **Status:** Accepted
- **Date:** 2026-11-08
- **Deciders:** Chris Carlson
- **Supersedes:** — (amends 0138's rules about `editingCollider`)
- **Related:** 0133, 0134, 0137 (the Physics editor half), 0138 (viewport tools), 0065 (navigation debug drawing), 0022 (the Scene toolbar, Edit Collider), 0039, 0045

## Context

ADR 0138 made viewport tools a contribution point and moved tile painting onto it, but left the collider, joint and navigation scene-view code in `src/editor/`, hand-installed by `session.ts` (its section 6 and open questions). ADR 0137 puts the collider and joint gizmos in the Physics plugin's editor half; ADR 0065's navigation tooling belongs in the Navigation plugin's. Moving them needs more than the viewport-tool context offers:

- **Collider editing is a mode outside the tool system.** `editingCollider` lives in core `state.ts`. The Inspector's Edit Collider button sets it; `gizmo.ts` hides the transform gizmo while it's set; `pickTool`, `activateViewportTool`, the viewport tool host and `session.ts` (tab switches) clear it. The collider gizmo listens to the canvas itself in the capture phase.
- **Viewport picking reads collider outlines.** `viewportSelection.ts` calls `colliderShapes(engine)`: a click inside a 2D collider's outline picks its node (smallest first), and the outlines count for the selection box and the Alt+click list.
- **The Edit Collider button** sits in the header of a collider's Inspector card (beside the enable checkbox, Open script, the Worlds menu and Remove), not under its fields where Inspector sections (0131) go. Remove clears `editingCollider` when the edited collider goes.
- **The Nav popover** is a hard-coded button in the Scene toolbar (`ui/SceneTools.tsx`) opening `ui/NavOverlayForm.tsx`.
- **The nav gizmo draws on the play Worlds too**, following `session.ts`'s `playing` signal; a plugin importing `session.ts` statically would form an import cycle (session → plugin application → the plugin list → the plugin → session).

## Decision

**1. Collider editing is the Physics plugin's viewport tool.** `myco.physics.colliders` (`src/plugins/physics/editor/colliderGizmo.ts`) draws every collider's outline (overlay kind `colliders`) and, while a collider is edited, its handles. `editingCollider` and `EditingCollider` move from `state.ts` into that module; a non-null value ⇔ the tool is active (setting it activates the tool; any other activation — a transform tool, Escape, play, painting — clears it), the way 0138 ties `brushTool` to the paint tool. Selecting another node, switching scenes, and uninstalling the tool also end it. Handle presses go through `onPress`; a drag is one undo group (closed on release and on cancel). Core loses `editingCollider` entirely: `activateViewportTool` no longer touches it, the host's collider effect goes, and `gizmo.ts` hides the transform gizmo only while a tool is active. Joints are `myco.physics.joints`, an always-on overlay (kind `colliders`, so the same toggle hides them).

**2. `ViewportToolContext.selectable(outlines)`.** A tool hands viewport picking outlines in world space (`SelectableOutline { node, points }`, each in its own XY plane), read on every click. `viewportSelection.ts` picks from `selectableOutlines(world)` (exported by the host, `src/editor/viewportTools.ts`) where it called `colliderShapes`; the point-in-polygon and area helpers stay in core (`src/editor/polygonMath.ts`). The collider tool registers its 2D outlines, so picking colliders works exactly as before while the Physics editor half is enabled.

**3. Scene toolbar items** (`SceneToolbarItemContribution`, registry `sceneToolbarItems`, `EditorPluginContext.registerSceneToolbarItem`): `{ id, label, buttonText, buttonClass, title, view }`, a toolbar button that opens a popover whose content (`view`, a `LoadComponent`) loads when first opened. Core renders them, in registration order, after Align and before Preview, with the toolbar's own popover (placement, outside click and Escape close it). The Navigation plugin registers its Nav popover with the same label, text, class and title.

**4. Component header actions** (`ComponentHeaderActionContribution`, registry `componentHeaderActions`, `EditorPluginContext.registerComponentHeaderAction`): `{ id, types, view, onRemove? }`. `view` renders in the header of cards whose Component type is in `types`, before the Worlds menu and Remove, with `{ scene, paths, info }`; `onRemove` runs before that card's Remove. The Physics plugin registers Edit Collider for the ten editable collider types (same class, `aria-pressed`, titles and label), ending editing when the edited collider is removed.

**5. `playing` moves to `state.ts`.** The running play session signal is declared in `state.ts` and re-exported by `session.ts` (its importers are unchanged), so the Navigation plugin's overlay tool follows the play Worlds without importing the session.

**6. What moves.** Physics editor half: `colliderGizmo.ts`, `jointGizmo.ts`, `colliderMath.ts`, `collider3dMath.ts`, `jointMath.ts`, the new `EditColliderButton.tsx`, and their tests. Navigation editor half: `navBake.ts`, `navBakeFiles.ts` (also imported by `src/nav-cli/`), `navBake.worker.ts`, `navGizmo.ts` (tool `myco.navigation.overlay`; the `window.navOverlay()` test hook is unchanged), `navPreviews.ts` (tool `myco.navigation.previews`), `NavOverlayForm.tsx` with `navOverlay.css`, and the navigation-only part of `navBake.css`. The bake-row rules the reflection probe Inspector shares (`.nav-chunk-bake`, `-row`, `-status`, `.nav-chunk-error`) stay in core as `editor/ui/bake.css`. Babylon overlay drawing stays in `src/engine/render/babylon/`.

All three new contribution points are internal tier (0133), like viewport tools: they expose editor internals (`OpenScene`, `ComponentInfo`, `GameObject`).

## Alternatives considered

- **Keep `editingCollider` in core and have the plugin read it.** Smallest diff, but the collider tool would be the only tool whose mode lives outside the tool system, and core would keep a Physics type list. Not chosen.
- **Edit Collider as an Inspector section** (0131, under the fields). No new contribution point, but the button would move from the header to the bottom of the card, which changes where users find it.
- **A selection-shape registry** (`registerSelectionShapes({ id, shapes(engine) })`) instead of `ViewportToolContext.selectable`. Equivalent; the context keeps scene-view behaviour together and disposes with the install.
- **A declarative toolbar entry on the viewport tool** (0138's open question `toolbar?: { label, icon, shortcut }`). The Nav popover isn't a tool mode, it's settings for an always-on overlay, so it is its own contribution.

## Consequences

**Positive**
- `session.ts` hand-installs no plugin scene-view code; disabling Physics or Navigation with a project open removes their gizmos, previews, Edit Collider button, collider picking and Nav popover.
- Collider editing gets the host's rules for free: play cancels a handle drag, Escape ends editing, it's exclusive with painting.

**Negative / costs**
- Behaviour changes: Escape now ends collider editing (the active tool); entering play ends it. Collider outlines are only selectable while the Physics editor half is enabled.
- Overlay ids change (`colliders` → `myco.physics.colliders`, `joints` → `myco.physics.joints`, the scene view's `navigation`/`navigation-selection` → `myco.navigation.overlay`/`myco.navigation.previews`); the play Worlds' id stays `navigation`. Nothing outside the moved code used them.
- Three more internal-tier contribution points to keep stable.

## Deprecates

`editingCollider`/`EditingCollider` in `src/editor/state.ts` (moved to the Physics editor half); 0138's "activating a tool clears `editingCollider`" and the host's collider-editing effect; the hand-installed `installColliderGizmo`, `installJointGizmo`, `installNavGizmo`, `installNavPreviews` in `session.ts`; the hard-coded Nav popover in `ui/SceneTools.tsx` and Edit Collider button in `ui/Inspector.tsx`; `src/editor/ui/navBake.css` (split into core `bake.css` and the plugin's `navBake.css`).

## Open questions

- Whether Scene toolbar items should also allow plain buttons and toggles (only popovers today).
- Physics Inspector sections (none exist yet besides the header button).
- A public scene-view API for third-party tools (0138's open question still applies to `selectable`).

## References

- `src/editor/sdk/contributions.ts`, `src/editor/sdk/plugins.ts`, `src/editor/viewportTools.ts`, `src/editor/viewportSelection.ts`, `src/editor/ui/SceneTools.tsx`, `src/editor/ui/Inspector.tsx`, `src/editor/state.ts`.
- `src/plugins/physics/editor/`, `src/plugins/navigation/editor/`.
- [0137](0137-physics-is-a-backend-neutral-plugin-plus-a-rapier-backend-plugin.md), [0138](0138-viewport-tools-are-an-editor-contribution-point-with-one-active-tool.md).

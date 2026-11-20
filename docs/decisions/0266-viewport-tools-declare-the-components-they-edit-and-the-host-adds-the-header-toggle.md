# 0266. Viewport tools declare the components they edit; the host adds the header toggle and owns "editing this card"

- **Status:** Accepted
- **Date:** 2026-11-20
- **Deciders:** Chris Carlson
- **Supersedes:** — (amends 0142: the Edit Collider header action is no longer the Physics plugin's own contribution)
- **Related:** 0142 (component header actions), 0231 (tool modes owned by the host), 0138 (viewport tools), 0162 (the reverb zone gizmo)

## Context

Two plugins edit one component at a time with scene-view handles: the Physics collider tool (`myco.physics.colliders`)
and the Audio reverb zone tool (`myco.audio.zones`). Each registers its own component header action (ADR 0142) with a
39-line button: `physics/editor/EditColliderButton.tsx` and `audio/editor/EditZoneButton.tsx`. Both decide whether
their card is the one being edited (node path key plus `info.index`), hide while several nodes are selected, show
`aria-pressed`, enter and leave the tool's mode through `editor.viewport` (ADR 0231), and leave it when their component
is removed. Both tools also declare `endsOnSelection: () => true`.

The copies already differ: the zone version doesn't compare the component type (its mode has no `type`), and it wears
the collider's class, `edit-collider`, which the shell's stylesheet and five e2e specs use. The next handle editors
(joints, nav links, occluders) would make a third and fourth copy.

## Decision

We will let a viewport tool declare the components it edits, and the host will do the rest.

- **`ViewportToolContribution.editsComponents`** (`src/editor/sdk/contributions.ts`): `{ types, label, hint, stopHint }`:
  the Component types it edits, the toggle's text ("Edit Collider"), its tooltip while off (a string, or one per type)
  and while on.
- **The mode is a `ComponentEditMode`** (`{ key, type, index }`: the node's path key, the Component type and which
  component of that type on the node). The collider's `EditingCollider` narrows `type`; the zone's `EditingZone` is a
  `ComponentEditMode` and so gains `type`.
- **The plugin context registers the toggle:** `registerViewportTool` of a tool with `editsComponents` also registers
  a component header action, `componentEditToggle(tool)` (`src/editor/componentEditToggle.tsx`), and removes both
  together. Plugins never register an editing toggle themselves.
- **The toggle owns "editing this card":** the tool's mode matches the card's active node key, Component type *and*
  index. It renders nothing while several nodes are selected; otherwise a button with class `edit-handles` (`active`
  while on), `aria-pressed`, the label and the hint, which enters the tool's mode with that card's
  `ComponentEditMode` or leaves it. Its `onRemove` leaves the mode when the removed card is the one being edited.
- **The host ends the mode on a selection change** for every tool with `editsComponents` (`viewportTools.ts`), so the
  two tools drop `endsOnSelection`; play, Escape, another tool and another scene end it as before (ADR 0231).
- **One neutral class:** `edit-handles` replaces `edit-collider` / `edit-zone` in `editor.css`,
  `inspector-fields.css` and the e2e specs.

## Alternatives considered

- **A shared `EditHandlesButton` component the plugins import** — removes the duplicate markup but still leaves each
  plugin registering its action and its removal rule, which is where the type check went missing.
- **The Inspector reads the viewport tool registry directly** — one less registration, but it would make the
  Inspector know about viewport tools; the header action contribution point already exists for exactly this.

## Consequences

**Positive**
- One "editing this card" rule, with the type match, tested once (`componentEditToggle.test.ts`) and through the
  collider story.
- A new handle editor gets the toggle, its single-selection guard and its removal rule by declaring four fields.

**Negative / costs**
- `ViewportToolContribution` grows a field whose meaning depends on the mode's shape (`ComponentEditMode`), which the
  type system doesn't enforce for the default `unknown` mode.

## Deprecates

`physics/editor/EditColliderButton.tsx`, `audio/editor/EditZoneButton.tsx` (removed, with `editColliderAction` and
`editZoneAction`), the `edit-collider` / `edit-zone` classes, and the collider and zone tools' `endsOnSelection`.

## Open questions

None.

## References

- `src/editor/componentEditToggle.tsx`, `src/editor/componentEditToggle.test.ts`, `src/editor/sdk/plugins.ts`,
  `src/editor/viewportTools.ts`
- Architecture review 2026-11-20, candidate 5

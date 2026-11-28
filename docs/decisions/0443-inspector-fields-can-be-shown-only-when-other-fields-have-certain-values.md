# 0443. Inspector fields can be shown only when other fields of the component have certain values

- **Status:** Accepted
- **Date:** 2026-11-26
- **Deciders:** Chris Carlson
- **Supersedes:** —
- **Related:** 0042, 0437

## Context

ADR 0437 gives `Tilemap` grid fields that mean something only for some grid shapes: `staggerAxis` and `staggerIndex`
for staggered and hexagonal grids, `hexSide` for hexagonal ones. `FieldOptions` (`core/registry.ts`, exported from
`myco`) could only hide a field always (`hidden`); the Inspector had no per-field condition, so every grid field showed
on every Tilemap. The same need comes up for scripts' own fields (a "radius" that only matters in one mode).
Accepted with 0437's build (the owner's acceptance of 0437 covers the Inspector behaviour it describes: "The Inspector
shows the stagger fields only for the shapes that use them").

## Decision

- `FieldOptions.shownWhen?: (values: Readonly<Record<string, unknown>>) => boolean`. The Inspector calls it with the
  component's field values by name (so it works for behaviours and data components alike) and shows the field only
  when it returns true.
- With several nodes selected, the field shows when the condition holds on any of them. A condition that throws
  shows the field. `hidden: true` wins over `shownWhen`.
- It is display only: the value is still stored, saved, animated and overridden as before. The live (play-mode)
  Inspector, which shows hidden fields as a debug view, ignores it.
- One function decides (`inspectorFields` in `src/editor/fieldVisibility.ts`), used by the Inspector's component card.
- `Tilemap` uses it for `staggerAxis`, `staggerIndex` and `hexSide`.

## Alternatives considered

- **A declarative form** (`{ field: "gridShape", in: ["hexagonal"] }`). Serializable, but field options already hold
  functions (`choices` can be a function of settings) and nothing serializes them; a function covers any condition.
- **A custom Tilemap inspector section.** Works for one component, not for scripts.

## Consequences

**Positive**
- Inspectors show only fields that matter for the current settings; scripts can use it too.

**Negative / costs**
- A field hidden by a condition can hold a stale value the user doesn't see (it still has no effect).

## Deprecates

Nothing.

## Open questions

None.

## References

- `src/engine/core/registry.ts`, `src/editor/fieldVisibility.ts`, `src/editor/ui/Inspector.tsx`,
  `src/plugins/tilemaps/runtime/Tilemap.ts`; tests in `src/editor/inspectorMetadata.test.ts`.

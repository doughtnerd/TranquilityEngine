# 0028. Prefab overrides can switch a component on or off

- **Status:** Accepted
- **Date:** 2026-11-01
- **Deciders:** Chris Carlson
- **Supersedes:** —
- **Related:** 0013, 0026

## Context

The editor's Inspector now lets a component be switched on or off through its header checkbox, as in Unity. On a plain node that's already in the scene format: a component entry can say `"enabled": false` (0013). On a prefab instance, every change is an override, and overrides (0013) can set a field, rename a node, set its active flag, or add or remove a component. None of them can enable or disable a component. `enabled` is a property of every component, not a declared `@field`, so a field override can't set it either.

## Decision

We will add one optional key to override entries: `enabled` (boolean). An override with `component` (and optionally `index`), no `field`, and `enabled` starts that component enabled or disabled:

```json
{ "target": ["top"], "component": "engine.BoxCollider2D", "enabled": false }
```

- The loader applies it in override order, like the other override kinds. A missing component is an error, as for field overrides.
- A component added by an `addComponent` override carries its own `enabled` in that entry instead.
- The editor writes the override only while the instance differs from the prefab. Switching the component back removes the override.
- Apply writes it into the prefab file as `"enabled": false` on the component entry, or removes the key when the value is `true`.
- Removing a component drops its `enabled` override, and renumbers those of later components of the same type, as for field overrides.

The format version stays `tranquility.scene@1`. The key is additive: older files load unchanged. A file that uses it fails to load in an engine build from before this record, since the loader there would treat the entry as a field override with no field. That only matters while builds are mixed.

## Alternatives considered

- **Treat `enabled` as a field in field overrides** (`"field": "enabled"`). It reads naturally, but `enabled` isn't a declared field. Every field-override path (type conversion, revert, the Inspector's field rows) would need a special case for it.
- **Leave it unsupported on instances** (disable the checkbox there). Simpler, but switching off part of a prefab per instance, such as one pipe's trigger, is a common need.

## Consequences

**Positive**
- The checkbox works the same on plain nodes, instances, and nodes inside instances.
- Apply can push it into the prefab like any other override.

**Negative / costs**
- One more override kind for tools that read scene files to understand.

## Deprecates

Nothing.

## Open questions

- Component order isn't expressible in overrides, so reordering stays a plain-node edit (do it in the prefab for instances).

## References

- `src/engine/scene/SceneLoader.ts` (`OverrideEntry.enabled`), `src/editor/componentEdits.ts`, `src/editor/prefabs.ts` (Apply)

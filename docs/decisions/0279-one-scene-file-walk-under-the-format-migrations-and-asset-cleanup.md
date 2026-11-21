# 0279. One scene-file walk under the format migrations and asset cleanup

- **Status:** Accepted, amended by 0280 (asset cleanup nulls node references only where `nodeReferences.ts` says one can sit)
- **Date:** 2026-11-21
- **Deciders:** Chris Carlson
- **Supersedes:** —
- **Related:** 0086, 0118, 0148, 0163, 0164

## Context

A component field value can sit in four places in a scene or prefab file: a node's component `data`, a prefab instance's field override (`{ component, field, value }`), an added component (`{ addComponent }`) and, recursively, any of these inside added nodes (`{ addNodes }`, ADR 0086). Four modules each hand-wrote the walk over them, and they drifted:

- `engine/scene/pivotMigration.ts` (format 1 → 2, ADR 0118) visited components and field overrides but skipped `addComponent` and `addNodes`, so a version 1 part reference (`asset:car.glb#Wheel`) added on a prefab instance wasn't pinned to model space and moved after loading.
- `rotationMigration.ts` (2 → 3, ADR 0163) and `handednessMigration.ts` (3 → 4, ADR 0164) each had their own `migrateComponent` / `migrateOverride` / `migrateNode`.
- `editor/assetRefValues.ts`' `sceneWithoutAsset` (ADR 0148) cleaned whole override objects with a generic value walk, so it also rewrote keys that aren't field values (a node `name` equal to the path would go) and, for an added node that instanced the deleted prefab, dropped only its `prefab` key and left a plain node behind.

## Decision

We will walk scene files in one module, `src/engine/scene/sceneFileWalk.ts`, and have each caller supply only its rule.

- **Interface.** `mapSceneFile(file, rule)` → a file; `rule.field(component, field, value)` sees every component field value in the file with its component type, wherever it sits, and returns the same value, a new one, or `REMOVE_FIELD` (a component field goes back to its default; an override goes, so the prefab's value shows). `rule.nodes(list)` sees every node list (the file's and each `addNodes` list) before its nodes are walked and may filter it.
- **Copy on change.** Only what changed is copied; a rule that changes nothing returns the very same file, so callers tell "changed" by identity.
- **Callers.** The three migrations are now their rule plus `mapSceneFile` (pin `mesh` of `engine.MeshRenderer` / `engine.MeshCollider`; Transform `rotation` to a quaternion; the handedness field table). `sceneWithoutAsset` is a `nodes` rule (drop instances of the deleted prefab and everything parented under them, in the file and in added-node lists) and a `field` rule (drop values naming the asset, clean nested ones, null `{ $node }` references to removed nodes). `SceneLoader` still registers the migrations by version.
- **Fix.** The pivot migration now pins part references in added components and added nodes.

## Alternatives considered

- **A visitor with one callback per placement** (`component`, `override`, `addComponent`, …) — every rule here treats a field value the same wherever it sits; the placements are the walk's business.
- **Patch the pivot migration alone** — fixes the bug, keeps four walks to drift again when an override shape is added.

## Consequences

**Positive**
- New override shapes are handled once; one fixture (`sceneFileWalk.test.ts`, a value in every placement) tests the walk.
- Old prefab-instance additions migrate like everything else.

**Negative / costs**
- Asset cleanup no longer rewrites override keys other than field values (`name`, `tags`); a reference there was never valid.

## Deprecates

Each migration's own `migrateComponent` / `migrateOverride` / `migrateNode`, and `sceneWithoutAsset`'s per-node override loop. `handednessMigration.ts`' `mirrorVector` and `mirrorRotation` are no longer exported (nothing outside used them).

## Open questions

- None.

## References

- `src/engine/scene/sceneFileWalk.ts`, `pivotMigration.ts`, `rotationMigration.ts`, `handednessMigration.ts`, `SceneLoader.ts`; `src/editor/assetRefValues.ts`
- Tests: `src/engine/tests/sceneFileWalk.test.ts`, `rotation.test.ts`; `src/editor/assetReferences.test.ts`

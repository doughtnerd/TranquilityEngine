# 0123. Components declare their own field migrations, and files record the component versions they were saved with

- **Status:** Proposed (not to be built yet: the user would rather treat renamed or retyped fields as a breaking change in an engine major version for now)
- **Date:** 2026-11-07
- **Deciders:** Chris Carlson
- **Supersedes:** —
- **Related:** 0013, 0017, 0026, 0028, 0086

## Context

ADR 0013 says "component field schemas can declare their own migrations for renamed or retyped fields". Only whole-file migrations exist: `registerSceneMigration(from, fn)` upgrades `myco.scene@N` to `N+1`, `migrateSceneFile` runs them on load (`SceneLoader.ts`), the editor's `SceneDocument` runs them when a file opens, and `npm run rewrite` (`src/rewrite-cli/`) rewrites files to the latest format. Renaming a `@field` today silently drops the old values: the loader warns "not a declared field" and ignores them, and the editor keeps the stale key in the file.

A component's data appears in several places, all of which a migration must reach:

- `components[].data` on plain nodes, in scenes and prefabs;
- field overrides (`{ component, index, field, value }`) on instances, which hold one field each, at any depth;
- `addComponent` entries and the nodes of `addNodes` overrides (ADR 0086).

Data components (`defineComponent`, ADR 0017) have schemas too and need the same.

During review the user said this should wait: renaming a field is a breaking change that belongs in a major engine version, which is already expected to break scripts. This record keeps the design ready for when it's wanted.

## Decision

If accepted, we will:

- **Declare a version and migrations with the component.** `@behavior("game.Player", { version: 2, migrate: { 1: (data) => { data.jumpForce = data.jump; delete data.jump; } } })`; `defineComponent(id, schema, { version, migrate })` takes the same. `migrate[n]` upgrades data from version `n` to `n + 1` in place (or returns a new object). A component with no `version` is version 1. Shorthand for a plain rename: `@field(Number, { formerly: "jump" })` moves `jump` to the field when the new key is absent, with no version bump.
- **Record versions per file.** A file gets an optional header map, `"versions": { "game.Player": 2 }`, giving the version of each component type its data was written with; a missing entry means 1. Everything in a file (its components, its overrides, its added components and nodes) is read at that file's versions, because that's when it was written. Saving (editor, rewrite CLI) writes the current version of each known type the file uses, and keeps the entries of types it doesn't know (a script that didn't load).
- **Migrate on load, after the format migrations.** `migrateSceneFile` walks the file once format migrations are done. Component data is migrated whole. Field overrides are grouped by instance, target, component and index, merged into one data object, migrated, and written back as one override per resulting key in the first one's place, so a migration that splits or merges fields works; keys the migration deletes drop their overrides. Files nothing needs migrating are returned as they are, and the result is cached per file object so a prefab instanced a hundred times migrates once.
- **Editor and CLI.** `SceneDocument` already runs `migrateSceneFile`, so an opened file shows migrated data and saves it upgraded. Apply and Create Prefab stamp versions on the prefab files they write. `npm run rewrite` compiles and loads the project's scripts the way `npm run export` does, so it sees game components' migrations, and rewrites any file with an outdated version entry.

## Alternatives considered

- **Treat renames as breaking changes in a major engine version** (the user's preference for now). No machinery, but old values are lost unless a whole-file migration is hand-written for each change.
- **A version on each component entry** (`{ "type": "game.Player", "v": 2, "data": ... }`). Precise, but overrides would need one too, and every entry in every file grows.
- **`registerFieldMigration(id, from, fn)` calls beside the class**, like `registerSceneMigration`. Keeps decorators small, but puts migrations away from the fields they describe.
- **Only `formerly` renames.** Covers the common case cheaply, but not retyped fields (a number becoming a vector).

## Consequences

**Positive**
- Renaming or retyping a field keeps the values in every scene, prefab and override.
- One rule (a file's versions) decides how to read everything in it.

**Negative / costs**
- Migrations are code that must stay until every file is rewritten; the rewrite CLI becomes the way to retire them.
- An override migrated in isolation only sees the fields that instance overrode; migrations must cope with partial data.
- The rewrite CLI gains a script compile step.

## Deprecates

Nothing.

## Open questions

- Whether to build this at all before an engine major version (the user's call, see Status).
- Whether migrations should also run on saved games' component data (ADR 0024).

## References

- `src/engine/scene/SceneLoader.ts` (`migrateSceneFile`), `src/engine/core/registry.ts`, `src/engine/core/data.ts`, `src/editor/document/SceneDocument.ts`, `src/rewrite-cli/rewrite.ts`
- Unity's `FormerlySerializedAs` attribute; Godot's `_set` / `_get` compatibility hooks

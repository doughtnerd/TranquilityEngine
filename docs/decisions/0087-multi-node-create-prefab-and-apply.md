# 0087. Create Prefab works on several sibling nodes, and Apply on several instances

- **Status:** Proposed
- **Date:** 2026-11-07
- **Deciders:** Chris Carlson
- **Supersedes:** —
- **Related:** 0013, 0022, 0026

## Context

Create Prefab and Apply acted on the one active node, though the selection is already a list.

## Decision

We will let Create Prefab take several nodes that share a parent: the prefab file's root is a new "Group" node (a Transform only) holding copies of them, and one instance replaces them where the first stood, as one undo step (`createPrefabFromNodes`). Nodes outside the selection may reference only the new root. With several instances selected, Apply writes each instance's overrides into its prefab (`applyOverridesTo`). Both are buttons on the multi-selection Inspector.

## Alternatives considered

- **One prefab per node** — not what "make these a prefab" means.
- **Several roots in one prefab** — 0013 requires a prefab to have one top-level node.

## Consequences

**Positive**
- Common "group these as a prefab" workflow works.

**Negative / costs**
- An extra Group node appears in the hierarchy.

## Deprecates

Nothing.

## Open questions

- Naming the prefab and Group node in a dialog (it is "Group" now).

## References

`src/editor/prefabs.ts`.

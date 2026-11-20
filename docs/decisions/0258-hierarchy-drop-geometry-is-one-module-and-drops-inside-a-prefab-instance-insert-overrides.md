# 0258. Hierarchy drop geometry is one module, and drops inside a prefab instance insert overrides

- **Status:** Accepted
- **Date:** 2026-11-20
- **Deciders:** Chris Carlson
- **Supersedes:** —
- **Related:** 0022, 0026, 0086, 0149, 0174, 0246 (amends 0246: answers its open question; amends 0149: `addAssets`' Hierarchy target carries an insertion place)

## Context

- **Geometry in the asset drag.** `assetDrag.ts`' `hierarchyDrop(doc, rowKey, fraction)` held the row-fraction rule (top quarter before, bottom quarter after, middle into) and returned a parent and index; `nodeDrag.ts` imported it, with `hierarchyTargetAt` and `overPrefabInsides`, from the asset drag.
- **Every inner row refused.** `hierarchyDrop` returned null for any row inside a prefab instance (`rowKey.includes("/")`), and both drags then read the DOM again (`overPrefabInsides`) to say "nodes inside a prefab can't take children here". Yet the node insertion (ADR 0246) already puts new and pasted nodes into an inner node as an `addNodes` override (ADR 0086); its open question asked for drops to do the same.

## Decision

We will put Hierarchy drop geometry in `src/editor/hierarchyDrop.ts`, and let drops inside an instance insert overrides.

- **Interface.** `hierarchyDrop(doc, rowKey, fraction)` → `HierarchyDrop | null` (null for a gone row): `mode` (`into`, `before`, `after`, `root`) and `row` (the row the indicator marks), `insert` (a node insertion place) and `move` (`{ parent, index? }` or `{ reason }`). `hierarchyDropAt(doc, x, y, window document)` finds the row under the pointer (ADR 0174); `dropRowName` names the marked row, inner rows included.
- **Scene rows** keep their geometry: into the row, or before or after it among its siblings; empty space and the scene header are the top level.
- **Inner rows.** The middle of a row inserts into that inner node (`{ kind: "into", key: "instance/id" }`, an `addNodes` override through the node insertion, as paste does). An override has no order, so a row's edges insert into its parent and the drop marks the parent: the inner parent, or the instance itself for a top-level inner row (which, like a drop into the instance row, adds a scene child of the instance).
- **Node moves into an instance are refused, with one reason:** "scene nodes can't move inside a prefab instance; copy and paste them there". The document could express a move as removing the node and adding an override, but references between scene nodes and an override's nodes can't be kept (an override's nodes resolve only inside the instance), so the move would silently break them. Moving inner nodes stays refused ("nodes inside a prefab are moved in the prefab").
- **Callers.** `assetDrag.ts` (`AssetDropTarget`'s hierarchy variant is `{ kind: "hierarchy", drop }`; problems come from `whyNotInsert` at `drop.insert`; the ghost says "(an override of its prefab instance)" inside one), `addAssets.ts` (the `slot` target becomes `{ kind: "hierarchy", place }`), `nodeDrag.ts` (moves to `drop.move`, refusals from it) and `ui/Hierarchy.tsx`' indicators.

## Alternatives considered

- **Keep refusing drops on inner rows** — paste and create already insert there; a drop is the same insertion with a different gesture.
- **Honour before/after inside an instance by writing an order** — overrides carry no order (ADR 0086), and inner nodes' order comes from the prefab file.
- **Move scene nodes into an instance as an override** — expressible, but it drops references to and from the moved nodes; copy and paste says so openly.

## Consequences

**Positive**
- One geometry for both drags, with its own tests (`hierarchyDrop.test.ts`); `assetDrag.ts` loses the Hierarchy code.
- Assets dropped on a node inside an instance land there, matching paste and the Create menu.

**Negative / costs**
- A drop on an inner row's edge lands at the end of its parent and highlights the parent, not a line, which may surprise at first.
- Node drags over inner rows now say why a move can't go there instead of "can't take children here".

## Deprecates

Removed from `assetDrag.ts`: `hierarchyDrop`, `hierarchyTargetAt`, `overPrefabInsides`, `PREFAB_INSIDES`; `addAssets`' `slot` target (replaced by `hierarchy`); `nodeDrag.ts`' `HierarchyTarget`.

## Open questions

- None.

## References

- `src/editor/hierarchyDrop.ts`, `src/editor/assetDrag.ts`, `src/editor/nodeDrag.ts`, `src/editor/nodeInsertion.ts`
- Tests: `src/editor/hierarchyDrop.test.ts`, `assetDrag.test.ts`; e2e `tests/e2e/dragdrop.spec.ts`, `hierarchy.spec.ts`

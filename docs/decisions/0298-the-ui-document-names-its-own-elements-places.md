# 0298. The UI document names its own elements' places

- **Status:** Superseded by 0419 (wave D retired UI documents; `ui/documentSource.ts` and the element paths went with them; Svelte UI is addressed by template location, 0419 wave C)
- **Date:** 2026-11-21
- **Deciders:** Chris Carlson
- **Supersedes:** —
- **Related:** 0077, 0242, 0247

## Context

ADR 0077 wave B lets the editor select and edit a UI document's elements and write the edits back to the markup files. Two facts make that work: an element's **static path** in the built tree (`""` for the root, then `/#id`, or `/Tag[n]` counted among same-tag siblings, and `/label` for a button's text content), which the editor's selection refs use; and an element's **markup place** (the file and the child indices from that file's root to its tag, with a used document's root sitting at its `<Use>` tag in the parent's file).

Before this record:

- The path rule was written three times: in `UIDocument.build`, in `collectReusable` (handles kept across a rebuild), and in `uiDocumentEdits.ts` `segment()`, which predicted the path an element would have after a rename, duplicate, move or create.
- The markup place was derived in the editor (`ownPlace`, `usePlace`, `sitePlace` in `uiDocumentEdits.ts`) by walking the engine's `@internal` markup records (`_markup.from`, `parent._markup.children.indexOf`).
- The editor read the element internals `_markup`, `_path`, `_synthetic` and the document's `_markupPath` about 44 times across `uiDocumentEdits.ts`, `uiDocuments.ts`, `uiHandleDrags.ts`, `uiElementDrag.ts`, `UIElementInspector.tsx` and `HierarchyMenu.tsx`, so it depended on the shape of the markup record.

## Decision

**One module answers where an element is written.** `src/engine/ui/documentSource.ts` is the UI document's authoring interface (not part of the game API: `myco` doesn't export it):

- `elementSource(el)` gives a built element's `UIElementSource`, or null for a list row (or anything inside one): `path`, `label` (a button's label made from its text content), `file`, `from`, `place` (its own tag), `usePlace` (its `<Use>` tag, for a used document's root), `sitePlace` (where it sits among its siblings: the `<Use>` tag or its own; null for the root and a label), `index` among the parent's written children, `childCount`, and what is written there: `attributes`, `text`, `span`, `openTagSpan`. A label's text, spans and place are its button's.
- `childPath(parent, at, tag, id, moving?)` gives the path a child will have once written at position `at` (with `moving`, one of the parent's children, left out first, for a move).
- `elementAtPath(doc, path)` and `documentFile(doc)` replace `UIDocument._elementAt` and `_markupPath`.

**One path rule.** The rule lives in `documentSource.ts`; `UIDocument.build` takes each child's path from it (`childPaths`, `labelPath`), and `collectReusable` reuses the paths the build stored instead of computing them again.

**The editor stops reading markup internals.** Its UI document files ask `elementSource`/`childPath` and keep only the text edits. The cascade-side editor members (`_resolveAt`, `_sheets`, `_boundFields`, `_resolved`, `_target`, `_elementOf`, `_onBuilt`) are out of this record's scope and stay as they are.

## Alternatives considered

- **Public methods on `UIDocument` (`placeOf(el)`, `childPath`)** — puts authoring facts on the game API that scripts never need; a module the editor imports keeps the game API as it is without leaning on `@internal` stripping.
- **More `@internal` members on `UIDocument`** — keeps the editor reading underscore members, which is what the review asked to end.
- **Store the place on each element at build time** — the place is cheap to derive on demand from the tree the build already keeps, and storing it would need care on every rebuild path.

## Consequences

**Positive**
- Locality: the path rule and the place rule are written once, beside the build that uses them.
- Leverage: the editor no longer depends on the markup record's shape; a change to it is made in one engine module.
- Tests: the path and place rules are tested through `elementSource`/`childPath` in `src/engine/tests/uiDocument.test.ts`, including that a predicted path is the one a rebuild gives.

**Negative / costs**
- The places are derived per call (a walk up the tree with `indexOf`), as before in the editor; fine at hierarchy sizes.

## Deprecates

`UIDocument._elementAt` and `_markupPath` (removed; `_builtFrom` is the engine-internal read `documentFile` uses), the editor's `ownPlace`/`usePlace`/`sitePlace`/`childIndex`/`segment`/`childRef` (removed), and the editor's reads of `_markup`, `_path`, `_synthetic`.

## Open questions

None.

## References

- `src/engine/ui/documentSource.ts`, `src/engine/ui/UIDocument.ts`
- `src/editor/uiDocumentEdits.ts`, `uiDocuments.ts`, `uiHandleDrags.ts`, `uiElementDrag.ts`, `ui/UIElementInspector.tsx`, `ui/HierarchyMenu.tsx`
- Architecture review 2026-11-21, card 4

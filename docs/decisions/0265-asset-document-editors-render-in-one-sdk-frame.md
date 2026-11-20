# 0265. Asset-document editors render in one SDK frame; each kind supplies only its body

- **Status:** Accepted
- **Date:** 2026-11-20
- **Deciders:** Chris Carlson
- **Supersedes:** —
- **Related:** 0134 (asset documents own editing), 0145 (the active history, `data-asset-document`), 0233 (the asset kind host reads and opens a kind's files), 0147 (the editor SDK and its internal tier), 0219 and 0235 (stories)

## Context

Five plugin editors that edit one asset document each hand-write the same frame around it: the root marked
`data-asset-document` so focus inside makes its document the active history (ADR 0145), a head with the kind and the
file name, the problems list, Undo and Redo bound to `doc.canUndo` / `doc.canRedo`, and a read-only notice. They are
the Material inspector (`materials/editor/MaterialInspector.tsx`), the Tileset inspector (`tilemaps/editor/TilesetInspector.tsx`),
the Formation inspector (`navigation/editor/FormationInspector.tsx`), the Sky panel (`sky/editor/SkyPanel.tsx`) and the
particle effect, sub-graph and block inspectors (`particles/editor/ui/ParticleInspector.tsx`).

The copies have drifted in ways users see:

- **Undo feedback:** Tileset and Formation call `editor.messages.info("Nothing to undo in this …")`, but only from a
  button that is disabled when there is nothing to undo, so the message never shows; Material and Sky say nothing.
- **Placement:** Undo and Redo sit in the head (Material), beside the preview (Sky) or in the body's first card
  (Tileset, Formation); the particle inspectors have none.
- **Focus:** only Tileset and Formation give the root `tabIndex={-1}`, so clicking a non-focusable part of the
  Material inspector or Sky panel doesn't make its document the active history.
- **Read-only:** Material says "This project is read-only.", Sky "`<name>` is read-only: changes aren't saved.",
  Tileset and Formation say nothing, and the particle inspectors test `!project.canSave` with their own hint, though
  they show the asset document the Particle Graph edits (`particleDocument`). Their problems list uses a class with no
  rule (`material-problems`), so it is unstyled.
- Four of the five import `editor/ui/assetInspector.css` from the shell: internal-tier exceptions in
  `src/plugins/plugins.test.ts`.

## Decision

We will give the editor SDK one frame bound to an asset document, and every one of these editors renders in it.

- **`AssetDocumentFrame`** (`src/editor/ui/AssetDocumentFrame.tsx`, exported from `myco/editor`), props `doc`
  (an `AssetDocument`), `kind` (the label in the head and the root's accessible name), optional `class` (the kind's
  own root classes, for its layout), optional `problems` (messages the kind adds, such as a compiled graph's) and
  `children`, the body.
- **What it renders:** a root `div.asset-document` with `data-asset-document={doc.path}` and `tabIndex={-1}`; the head
  (`asset-inspector-head`): kind, file name (the path as its tooltip) and Undo / Redo at its end; the problems list
  (the document's, then the kind's, without repeats); the read-only notice; then the body.
- **One undo behaviour:** Undo and Redo call `doc.undo()` / `doc.redo()`. They are disabled when there is nothing to
  step or the project is read-only, and their tooltip says which: `Undo <step> (Ctrl+Z)`, `Nothing to undo in this
  <kind>` or the read-only sentence. No status message: a disabled button can't send one, and the tooltip is where the
  reason belongs. Keyboard and Edit-menu undo still go through the active history.
- **One read-only rule:** the notice shows exactly when `doc.readOnly`, worded by `readOnlyMessage` ("`<name>` is
  read-only. Open a project folder (or copy the sample) to change `<file>`."), the sentence the document's refused
  edit already puts in the status bar.
- **It flushes** a pending coalesced edit when it unmounts or its document changes; the kinds' own `useEffect` flushes go.
- **It owns its stylesheet:** the frame module imports `assetInspector.css` (its head, problems and note rules, and
  the shared `import-row` rows the bodies use), so the four internal-tier CSS entries are removed.
- **Particles:** the effect, sub-graph and block inspectors are backed by the same asset document the Particle Graph
  edits, so they move onto the frame too: their read-only notice comes from `doc.readOnly`, their problems are the
  document's plus what compiling the effect reports, and they get Undo / Redo of that document's history. They still
  make no edits of their own.
- **Sky** keeps its two columns as the frame's body: the head spans the panel above the preview column and the form.

## Alternatives considered

- **Shared building blocks (a `<UndoRedo doc>` and a `<ProblemList>`), each kind keeping its root** — leaves the
  root marking, focus and read-only rule to each copy, which is where they drifted.
- **Keep the "Nothing to undo" info message and make the buttons always enabled** — a click that only reports it did
  nothing is noise, and a disabled button with a tooltip says the same before the click.
- **Leave the particle inspectors out (they don't edit)** — they show the document, so the read-only rule and the
  problems styling should match; leaving them out keeps the fifth copy.

## Consequences

**Positive**
- One behaviour for undo, focus and read-only in every asset-document editor; a new kind gets it by rendering the frame.
- The four internal-tier stylesheet exceptions go.
- The frame is tested once, through a story (`AssetDocumentFrame.stories.tsx`).

**Negative / costs**
- The Sky panel's Undo / Redo move from beside the preset menu to the head; the Tileset and Formation buttons move
  from their first card to the head.
- The particle inspectors open the effect's asset document whenever they show (they used to read the current value
  through `editor.assets.read`); the document is the one the Particle Graph would open, and it writes nothing until edited.

## Deprecates

The hand-written frames in the five editors, their `undo` / `redo` wrappers and `useEffect` flushes, the Tileset's
`.tileset-history` and the Formation's `.nav-formation-history` rows, the particle inspectors' `!project.canSave`
hint and `material-problems` list, and the four `assetInspector.css` entries in the internal tier.

## Open questions

- The shell's own inspectors that read without a document (images, audio, render textures, shader graph summaries)
  share the head and problems classes but not the frame; they could take a read-only variant later.

## References

- `src/editor/ui/AssetDocumentFrame.tsx`, `src/editor/ui/AssetDocumentFrame.stories.tsx`
- `src/plugins/plugins.test.ts` (the internal tier)
- Architecture review 2026-11-20, candidate 4

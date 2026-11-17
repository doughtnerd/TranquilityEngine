# 0228. One graph-document module owns the edits and shortcuts both graph editors share

- **Status:** Accepted; its `freeName` was replaced by 0232's `uniqueName` in pass 5's follow-ups
- **Date:** 2026-11-17
- **Deciders:** Chris Carlson
- **Supersedes:** part of 0060 (the shared graph layer held only the canvas; each panel kept its own node edits)
- **Related:** 0046, 0048, 0060, 0145, 0226

## Context

ADR 0060 factored the canvas (pan and zoom, box select, notes, the minimap, node search) out of the
Shader Graph panel into `src/editor/graph/`, and left everything specific to one graph with its panel.
In practice "specific" covered far more than it needed to. Both `shaderGraph/graphEdit.ts` and
`particleGraph/graphEdit.ts` wrote the same Blackboard property edits (add, rename,
`whyNotPropertyName`, remove, move, set value), the same group and note edits, the same copy, paste
and duplicate, and the same free-name helpers. `ShaderGraphPanel.tsx` and `GraphEditor.tsx` repeated
the same click-select, box select and keyboard block (Ctrl+D/A/C/X/V/G, Delete, Space, F, Escape).

The copies had drifted:

- a taken property name read "a property named "X"" in one and "a property called X" in the other;
- the Shader Graph's keys read the render-time `graph`, the Particle Graph's the document's latest
  (`live.current.graph`), so a second key pressed before a re-render in the Shader Graph worked on a
  stale graph;
- duplicate moved copies 30 units in one and 40 in the other.

Two kinds of graph now plug into the same edits, so the seam is real.

## Decision

We will keep the edits every graph makes the same way, and a graph panel's selection and shortcuts,
in the shared graph layer, exported through `myco/editor`:

- **`graphDocument(kind)`** (`src/editor/graph/document.ts`) returns a `GraphDocument`: `items`,
  `remove`, `addProperty`, `whyNotPropertyName`, `renameProperty`, `removeProperty`, `moveProperty`,
  `setPropertyValue`, `group`, `ungroup`, `setGroupTitle`, `addNote`, `updateNote`, `removeNote`,
  `copy`, `clipboardFromText`, `paste`, `duplicate`, and `clipboardFormat`. They are pure functions:
  none changes its input, and an edit that changes nothing returns the graph it was given. The module
  also exports `freeName` and `freeId`, and `DUPLICATE_OFFSET`.
- **A `GraphDocumentKind`** is what a plugin plugs in, and only that: its canvas items and how they're
  removed; new group and note ids; where its groups and notes are stored (`GraphListAccess`); its
  property labels, defaults and which nodes read a property; and its clipboard (format tag, what a
  copy holds, how a payload is checked, and how a paste gives the items new ids). The Shader Graph's
  kind (`shaderGraphEdits`) adds the properties and keywords copied nodes read. The Particle Graph's
  (`particleGraphEdits`) copies systems with their blocks, wires and events. Nodes, connections,
  keywords, sub-graph ports, systems and blocks stay in each plugin's `graphEdit.ts`.
- **`useGraphSelection(options)`** (`src/editor/graph/selection.ts`) is the panel's selection,
  box select, paste-event handling and keyboard block. Its handlers read the graph through `graph()`
  when they run. The panel plugs in its extras: a selected wire or block to delete first, what to
  clear on an item press, a pane press or Escape, and what Space opens. Each kind's last copy is kept
  in memory by clipboard format.
- The clipboard formats (`myco.shadergraph.clipboard@1`, `myco.particles.clipboard@1`) and their
  reading through `src/editor/clipboard.ts` (ADR 0226) are unchanged.

To end the drift, we chose one behaviour for each difference:

- **The message:** `there's already a property named "X"`, the Shader Graph's wording, which
  matches its keyword and port messages.
- **The graph the keys read:** the document's latest, as the Particle Graph did. This fixes the stale
  graph in the Shader Graph's keys, and its group, note and group-title edits now read it too.
- **Duplicate offset:** 40 units, the Particle Graph's. Duplicate is now copy and paste, so the Shader
  Graph's duplicate checks pasted wires as a paste does.
- **Focus on an item press:** the panel takes the keyboard unless a field was pressed, as the Particle
  Graph did.
- **A property edit that changes nothing** (removing a property that isn't there) returns the same
  graph, as the Particle Graph did.

## Alternatives considered

- **Keep the copies and fix the drift by hand.** They drift again with the next change, and a third
  graph editor would copy them a third time.
- **One shared graph data model.** Both formats would have to store groups, notes and ids the same
  way, which changes saved files. The kind's accessors bridge the two formats at no cost to the files.
- **A base class for the panels.** The panels are function components, and the hook gives the same
  sharing without inheritance.

## Consequences

**Positive**
- About 300 duplicated lines now live in one place, with one test suite (`document.test.ts`, run
  through a small graph kind of the test's own) instead of two near-identical ones.
- The next graph editor gets properties, groups, notes, the clipboard, selection and shortcuts by
  writing one kind.

**Negative / costs**
- `myco/editor` gains `graphDocument`, `useGraphSelection` and their types, which third-party
  plugins may now build on and which must stay compatible.
- The hook isn't covered by a unit test (Vitest here has no DOM). The graph panels' e2e specs cover it.

## Deprecates

The plugins' own `addProperty`, `whyNotPropertyName`, `renameProperty`, `removeProperty`,
`moveProperty`, `setPropertyValue`, group, note, copy, paste, duplicate and clipboard-reading
functions (`copyNodes`/`copyItems`, `pasteNodes`/`pasteItems`, `duplicateNodes`/`duplicateItems`,
`groupNodes`/`groupItems`, `graphClipboardFromText`/`particleClipboardFromText`) are removed. Callers
use `shaderGraphEdits` and `particleGraphEdits`. The panels' module-level clipboards are removed.

## Open questions

- Per-asset history and the Blackboard shell, which ADR 0060 also listed for the shared layer, are
  still each panel's own.

## References

- `src/editor/graph/document.ts`, `src/editor/graph/selection.ts`, `src/editor/graph/document.test.ts`
- `src/plugins/materials/editor/shaderGraph/graphEdit.ts`, `src/plugins/particles/editor/particleGraph/graphEdit.ts`

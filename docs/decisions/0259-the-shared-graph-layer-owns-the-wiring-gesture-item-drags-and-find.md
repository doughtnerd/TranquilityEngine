# 0259. The shared graph layer owns the wiring gesture, item drags and find

- **Status:** Accepted
- **Date:** 2026-11-20
- **Deciders:** Chris Carlson
- **Supersedes:** —
- **Related:** 0046, 0060, 0117 (amended: find moves into the graph layer and both graphs have it), 0219, 0228 (amended: the layer also runs the wiring gesture and item drags)

## Context

ADR 0228 moved the edits, selection and shortcuts both graph editors share into `src/editor/graph/`.
The wiring gesture stayed in each panel: `ShaderGraphPanel.tsx` (1192 lines) and the Particle Graph's
`GraphEditor.tsx` (868 lines) each had a `connectOptions` builder for xyflow's `startConnection`, an
`onPortDown` that picks a wire up from its input end by finding the source port element
(`querySelector('[data-id="${flowId}-…-source"]')`), `draft` and `detached` state, a drop in empty
space that opens the node search, a `flowId`, and copies of `startGroupDrag`, the node drag hooks with
their `dragging` state, `addNoteHere`, and the search's open/close state.

The copies had drifted:

- **Refusals:** the Particle Graph showed why a wire is refused (a tooltip at the wire's loose end, from
  `whyNotWire`); the Shader Graph called `whyNotConnect` and threw the reason away
  (`canConnect: … !whyNotConnect(…)`), so a refused wire just stayed dashed.
- **Find** (Ctrl+F, ADR 0117) existed only in the Shader Graph; its matcher (`graphSearch.ts`) read
  shader nodes, notes and groups directly.
- **Search popup:** the Particle Graph kept the popup inside the pane; the Shader Graph didn't.
- **Picking a wire up** read the render-time graph in the Shader Graph and the document's latest in
  the Particle Graph.

## Decision

We will run the wiring gesture, item drags and find in the shared graph layer, exported through
`myco/editor`. A panel plugs in its own edits and labels; the layer gives back what to draw.

- **`useGraphWiring(options)`** (`src/editor/graph/wiring.ts`): the panel supplies its wire edits as a
  `GraphWiringEdits<G>` (`sourceOf`, `whyNot`, `connect`, `disconnect`, `split`, pure functions like
  the graph document's), `graph()`, `commit`, and `onDropInSpace(at, port)`, what a new wire let go in
  empty space opens. The hook makes the `flowId` and returns `onPortDown` for the port elements, the
  `draft` wire, the `detached` input and the refusal `hint`. Its decisions are the pure
  `wireGesture(edits, graph, port)`: which port a press draws from (a wired input draws from its source
  output), which input is detached, the edit a landing makes (moving a picked-up wire is one edit), and
  the drop in space (a picked-up wire is removed; a new one calls the panel). A picked-up wire is judged
  on the graph without it, the graph the connect applies to. The kinds' adapters are `shaderWiring`
  and `particleWiring(resolve)`, beside their `graphEdit.ts`.
- **`WireRefusal`** (`canvas.tsx`) draws the hint beside the loose end (`.sg-refusal` in `graph.css`).
  Both graphs show it now.
- **`useGraphSearch<T>()`** (`canvas.tsx`) is the search's state: where it opened (`at`, where a picked
  node goes), where the popup is drawn (`popup`, kept inside the pane in both graphs), the panel's data
  (`T`), and `open`, `close` (keyboard back to the graph) and `dismiss`.
- **Item drags and notes in `useGraphSelection`:** it takes the kind's `move(graph, positions)` edit
  (`moveNodes`, `moveItems`) and returns `dragging`, the `drag` hooks a node or system element hands
  `useNodeDrag` (`canvas.tsx`, xyflow drags the selection together), `startGroupDrag(e, groupId)` (members
  from the graph document's new `groups(graph)` reader, positions from the canvas nodes) and
  `addNoteHere()`. A move commits with `drag: true`, so the Shader Graph coalesces quick moves as before.
- **Find:** `findInGraph(items, notes, groups, query)` (`graphFind.ts`) is the matcher moved out of
  the Shader Graph, with `cycleIndex`; notes and groups come from the graph document (`notes(graph)`,
  `groups(graph)`). Each graph supplies its `FindItem`s, the label drawn on the item and its searchable
  fields: `shaderFindItems` (node titles, types, property names, settings, Custom Function names) and
  `particleFindItems` (systems by name and block labels and types; nodes by the title drawn on them, a
  property node's property name, type and text settings). `useGraphFind` and `GraphFindBox`
  (`findBox.tsx`) are the box, its keys and going to a match. Ctrl/Cmd+F is in `useGraphSelection`'s
  key block (`openFind`), working from a field too as it did in the Shader Graph. The Particle Graph
  gets a Find toolbar button; going to a match there also expands a collapsed system.

## Alternatives considered

- **Keep each panel's gesture and copy the refusal hint and find across.** Fixes today's drift and
  keeps two copies to drift again; a third graph editor would copy them a third time.
- **Put the gesture into the graph document kind.** The kind is pure data edits used outside panels;
  wiring is a canvas gesture, so its edits are a separate small adapter (`GraphWiringEdits`) the hook
  takes.
- **One generic find over a shared node model.** The two graphs label items differently (a shader
  node's title comes from its type and settings, a particle system has a name and blocks); a list of
  `FindItem`s per graph keeps the matcher generic without a shared model.

## Consequences

**Positive**
- Both graphs show why a wire is refused and both have find; the search popup stays in the pane in both.
- `ShaderGraphPanel.tsx` loses about 155 lines and `GraphEditor.tsx` about 70; the Particle Graph's
  `DragHooks`/`useCanvasDrag` and the Shader Graph's `DragHooks` and per-node `createNodeDrag` effect go.
- The gesture's decisions are tested once (`wiring.test.ts`), the matcher once (`graphFind.test.ts`),
  and each graph's find items with its own plugin tests; the panels' stories drive the gesture and find
  in a browser (ADR 0219).

**Negative / costs**
- `myco/editor` gains `useGraphWiring`, `wireGesture`, `GraphWiringEdits`, `useGraphSearch`,
  `useNodeDrag`, `GraphDragHooks`, `WireRefusal`, `findInGraph`, `FindItem`, `useGraphFind`,
  `GraphFindBox`, and `GraphDocument.groups`/`notes`; `useGraphSelection` now needs `move` and `openFind`.
- The hooks have no Vitest unit test (Vitest here has no DOM); the story tests cover them.

## Deprecates

Each panel's `connectOptions`, `onPortDown`, `draft`/`detached`/`hint` state and `refusal` ref,
`flowId`, `startGroupDrag`, `addNoteHere`, `openSearch`/`closeSearch` and search state, node drag hooks
and `dragging` state, the Shader Graph's find state and box, and `searchGraph` in
`shaderGraph/graphSearch.ts` (the file now holds `shaderFindItems`). `.pg-refusal` becomes `.sg-refusal`
and the `.sg-find` styles move from `shaderGraph.css` to `graph.css`. All removed, not kept.

## Open questions

- Find doesn't yet reach a block inside a system (it frames the system) or a Blackboard property.

## References

- `src/editor/graph/wiring.ts`, `graphFind.ts`, `findBox.tsx`, `canvas.tsx`, `selection.ts`, `document.ts`
- Tests: `src/editor/graph/wiring.test.ts`, `graphFind.test.ts`; `shaderGraph/graphSearch.test.ts`;
  `particleGraph/search.test.ts`; stories `ShaderGraphPanel.stories.tsx`, `ParticleGraphPanel.stories.tsx`
  (`WiringGesture`, `FindInGraph`)

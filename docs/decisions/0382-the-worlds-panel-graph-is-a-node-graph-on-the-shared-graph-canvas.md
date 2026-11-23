# 0382. The Worlds panel's graph is a node graph on the shared graph canvas, with node positions kept by the editor

- **Status:** Accepted
- **Date:** 2026-11-23
- **Deciders:** Chris Carlson
- **Supersedes:** —
- **Related:** 0032, 0046, 0060, 0062, 0068, 0181, 0228, 0256, 0259, 0306

## Context

ADR 0032 says the Worlds panel shows the bootstrap's Worlds "as nodes, and links as edges". The panel drew a static picture: `worldsLayout.ts` placed every node in columns by link depth and routed orthogonal arrows between them, and `WorldsPanel.tsx` drew the result as absolutely positioned boxes over an SVG inside a horizontally scrolling strip. It couldn't be panned or zoomed, nodes couldn't be moved, and links could only be made and removed through the pickers in the Links list below it. Every other graph in the editor (Shader Graph, Particle Graph, the animation graphs) is built on the shared graph layer in `src/editor/graph/` over xyflow's `@xyflow/system` core (ADR 0046, 0060, 0228, 0259), which already does panning, zooming, node drags and wiring from ports.

The bootstrap in `project.json` (the runtime format) has no place for where a node is drawn, and shouldn't: the runtime never reads it, and it would make every rearrangement an edit to the game's configuration.

## Decision

We will draw the Worlds panel's graph on the shared graph canvas, and keep node positions as the editor's own data.

- **Canvas.** The graph is an `.sg-pane` from `useGraphCanvas`: wheel zoom, middle or right button pan (xyflow's), and a left drag on the empty canvas pans too (the graph has no box selection, since one World is selected at a time). F, or the Frame all button, frames every World. The pane is a fixed-height strip, resizable from its corner, above the selected World's settings and the Links list, which stay as they were.
- **Nodes.** Start-up and Spawnable Worlds are nodes (canvas ids `w<i>`, `t<i>`), drawn as before (tags, tick rate, badges, the ADR 0256 role, dashed for Spawnable Worlds). Clicking or pressing a node selects that World for the settings below, as before. Nodes are dragged with `useNodeDrag`.
- **Edges.** Links in `project.json`, the links the lobby makes (ADR 0068) and the live connections during play are arrows drawn with `wirePath` from the client's right edge to the server's left edge, with their label pill at the middle; arrows joining the same two Worlds fan out side by side. The DOM hooks the specs use stay: `.worlds-node[data-world|data-template]`, `.worlds-link[data-link-arrow|data-lobby-link|data-live-link]`, `[data-label-for]`.
- **Editing links.** When the project can be saved, each node has an out port (right) and an in port (left). Dragging from one World's port to another's adds a link, client → server, over `loopback` (`useGraphWiring`, with `sourceOf` always empty since a World takes any number of links); a link to itself or a second link between the same two Worlds in the same direction is refused with the reason beside the pointer. Clicking a link's arrow or pill picks it; Delete removes it. Both are ordinary edits of the Worlds section, so they're undone like every other edit (ADR 0181).
- **Positions are the editor's.** A World's position lives in the project folder's `.myco/worlds-graph.json` (`{ "format": "myco.worldsGraph@1", "positions": { "world:<name>": [x, y], "template:<key>": [x, y] } }`), read and written by `src/editor/worldsGraphPositions.ts`; never in `project.json`. A start-up World is keyed by its name and a Spawnable World by its template key, the panel's rename moves the entry, and a write keeps only the Worlds the graph has. A World with no entry sits where `worldsLayout.ts`'s auto layout puts it (now only for placement; its routes and label boxes are no longer drawn). The first time the user drags a node or draws a link, every World is stored where it is drawn, so later edits to the links don't rearrange Worlds the user has already seen placed; a World added afterwards starts where the auto layout puts it. Reads are lenient (ADR 0306). Moving a node isn't an undoable edit (it's layout, like pan and zoom) and works in a read-only project too, where it lasts for the session and isn't written.
- **Keys.** The pane carries the graph layer's key-owner marker (`KEY_OWNER`), so Delete and F inside it are the graph's, not the scene's; undo and redo still reach the Worlds history.

## Alternatives considered

- **Keep the static layout and add pan and zoom to it.** Less code, but a second canvas beside the shared one, and still no moving nodes or drawing links in the graph.
- **Store positions in `project.json`'s `bootstrap` (an `editor` key per World).** One file, but it's the runtime format: every rearrangement would be a configuration change, a diff in the game, and a key the engine has to ignore.
- **Positions only in memory, laid out afresh each session.** Nothing to store, but a user's arrangement would be lost on every reload.
- **The `useGraphSelection` and graph-document layer (ADR 0228).** Its selection, box select, copy, paste, groups and notes are built for asset graphs with a `GraphDocument`; the Worlds graph has one selected World and no clipboard, so it uses the canvas, drag and wiring pieces only.

## Consequences

**Positive**
- The world graph behaves like the editor's other graphs: pan, zoom, frame, move nodes, draw and delete links.
- Layout never touches `project.json`; arrangements persist per project folder.

**Negative / costs**
- Bezier arrows between freely placed nodes can cross nodes and each other; the auto layout's guarantee that no arrow or label passes over a node now holds only until the user moves a node.
- A rename made outside the panel (in the Code panel) loses that World's stored position; it falls back to the auto layout.
- The wheel over the graph zooms it instead of scrolling the panel body.

## Deprecates

- The static graph drawing in `WorldsPanel.tsx` (the scrolling `.worlds-graph`/`.worlds-canvas` strip): removed. `worldsLayout.ts` stays as the auto layout; its `links` routes and label boxes are no longer drawn by the panel.

## Open questions

- Whether to offer "Reset layout" (clear `.myco/worlds-graph.json`) and to spread several arrows into one node's port.

## References

- `src/editor/ui/WorldsPanel.tsx`, `src/editor/ui/worlds.css`, `src/editor/worldsGraphPositions.ts` (+ `.test.ts`), `src/editor/worldsLayout.ts`, `src/editor/graph/`.

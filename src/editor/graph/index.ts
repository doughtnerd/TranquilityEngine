// The shared graph-editor layer (ADR 0060), factored out of the Shader Graph panel so the
// Particle Graph panel is built on the same canvas. ADR 0060 kept each graph's node edits with its
// panel; ADR 0228 moved the edits every graph makes the same way (properties, groups, notes, copy,
// paste, duplicate) and the selection and shortcuts into this layer. What stays with a panel is
// what is its own: its node types and layout, ports, wires and colours, and its extra items (the
// Particle Graph's systems and blocks, the Shader Graph's keywords and sub-graph ports). ADR 0259
// moved the wiring gesture (connect, pick a wire up, drop in space, the refusal hint), item drags and
// find (ADR 0117) here too: a panel plugs in its wire edits, its find items and what a drop opens.
//
// - xyflow: the `@xyflow/system` adapter: pan and zoom, node drags, wiring from ports, wire curves.
// - canvas: `useGraphCanvas` (the pane and its view), `startBoxSelect` and `SelectionBox`,
//   `startPointerDrag` (group and note drags), `useNodeDrag`, `WireRefusal`, `NoteView`, `Minimap`,
//   `useGraphSearch` and `NodeSearchPopup`.
// - wiring: `useGraphWiring`, the wiring gesture, over `wireGesture`, its decisions as pure functions.
// - graphFind and findBox: `findInGraph` (the matcher), `useGraphFind` and `GraphFindBox`.
// - document: `graphDocument(kind)`, the generic edits, for a `GraphDocumentKind` a plugin plugs in.
// - selection: `useGraphSelection`, a panel's selection, box select, keyboard shortcuts and item drags.
// Copy and paste go through the editor's clipboard text (`../clipboard.ts`, ADR 0226), shared with the node clipboard.
// Styles are in graph.css (import it from the panel).
export * from "./xyflow";
export * from "./canvas";
export * from "./document";
export * from "./selection";
export * from "./wiring";
export * from "./graphFind";
export * from "./findBox";

// The shared graph-editor layer (ADR 0060), factored out of the Shader Graph panel so the
// Particle Graph panel is built on the same canvas. ADR 0060 kept each graph's node edits with its
// panel; ADR 0228 moved the edits every graph makes the same way (properties, groups, notes, copy,
// paste, duplicate) and the selection and shortcuts into this layer. What stays with a panel is
// what is its own: its node types and layout, ports, wires and colours, and its extra items (the
// Particle Graph's systems and blocks, the Shader Graph's keywords and sub-graph ports).
//
// - xyflow: the `@xyflow/system` adapter: pan and zoom, node drags, wiring from ports, wire curves.
// - canvas: `useGraphCanvas` (the pane and its view), `startBoxSelect` and `SelectionBox`,
//   `startPointerDrag` (group and note drags), `NoteView`, `Minimap` and `NodeSearchPopup`.
// - document: `graphDocument(kind)`, the generic edits, for a `GraphDocumentKind` a plugin plugs in.
// - selection: `useGraphSelection`, a panel's selection, box select and keyboard shortcuts.
// Copy and paste go through the editor's clipboard text (`../clipboard.ts`, ADR 0226), shared with the node clipboard.
// Styles are in graph.css (import it from the panel).
export * from "./xyflow";
export * from "./canvas";
export * from "./document";
export * from "./selection";

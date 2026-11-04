// The shared graph-editor layer (ADR 0060), factored out of the Shader Graph panel so the
// Particle Graph panel is built on the same canvas. Anything specific to one kind of graph (its
// node layout, edits, ports and colours) stays with that panel.
//
// - xyflow: the `@xyflow/system` adapter: pan and zoom, node drags, wiring from ports, wire curves.
// - canvas: `useGraphCanvas` (the pane and its view), `startBoxSelect` and `SelectionBox`,
//   `startPointerDrag` (group and note drags), `NoteView`, `Minimap` and `NodeSearchPopup`.
// - history: `createGraphHistory`, per-asset undo and redo of whole-graph snapshots.
// - clipboard: copying a tagged JSON payload through the system clipboard as text.
// Styles are in graph.css (import it from the panel).
export * from "./xyflow";
export * from "./canvas";
export * from "./history";
export * from "./clipboard";

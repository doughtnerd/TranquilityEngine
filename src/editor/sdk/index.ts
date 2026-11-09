// The editor SDK (ADR 0133): what `myco/editor` will resolve to for plugin editor halves.
// Experimental until v1.
export * from "./registry";
export * from "./contributions";
export * from "./plugins";
export { openAssetDocument, type AssetDocument, type EditOptions } from "../assetDocuments";
export type { InspectorSectionProps, InspectorSectionOptions } from "../ui/inspectorSections";
export { activeViewportTool, activateViewportTool } from "../state";
// Undo and Redo act on the active history (ADR 0143). An editor root marked `data-asset-document={doc.path}`
// makes its asset document the active history while focused; a panel with its own history registers it.
export { activeHistory, providePanelHistory, usePanelHistory, type ActiveHistory, type HistoryTree, type UndoHistory } from "../activeHistory";

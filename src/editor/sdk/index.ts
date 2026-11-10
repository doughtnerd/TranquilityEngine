// The editor SDK (ADR 0133): what `myco/editor` resolves to for plugin editor halves.
// Experimental until v1.
export * from "./registry";
export * from "./contributions";
export * from "./plugins";
export { openAssetDocument, type AssetDocument, type EditOptions } from "../assetDocuments";
export type { InspectorSectionProps, InspectorSectionOptions } from "../ui/inspectorSections";
export { activeViewportTool, activateViewportTool } from "../state";
// Undo and Redo act on the active history (ADR 0145). An editor root marked `data-asset-document={doc.path}`
// makes its asset document the active history while focused; a panel with its own history registers it.
export { activeHistory, providePanelHistory, usePanelHistory, type ActiveHistory, type HistoryTree, type UndoHistory } from "../activeHistory";

// The project and editor surface (ADR 0147): `editor.project`, `editor.assets`, `editor.messages`,
// `editor.scene` and `editor.showPanel`, over the shell's state, which plugins never import.
export { editor, type EditorSurface } from "./editor";
export type { ProjectSurface, AssetsSurface, CreateFileOptions, AssetImportSettings, AssetKind, EditorProject } from "./project";
export type { MessagesSurface, MessageAction } from "./messages";
export type { SceneSurface, SelectionSurface, PlayState, OpenScene } from "./scene";
// Editing scene documents (ADR 0026): node paths and entries, and the field command inspector sections push.
export { SetField, pathKey, type NodePath, type NodeEntry, type SceneDocument } from "../document";
// Building blocks for panels, inspectors and settings sections.
export { sectionField } from "../ui/inspectorSections";
export { LargePreview } from "../ui/AssetPreview";
export { NameList, NumberField, ProblemList, Row, TextField } from "../ui/settingsControls";
// ADR 0158 §7: the shared curve widget (particles, audio events, later animation) and its pure key helpers.
export { CurveEditor, CurvePreview, type CurveEditorProps } from "../ui/CurveEditor";
export { addKey as addCurveKey, moveKey as moveCurveKey, removeKey as removeCurveKey, setKeyInterp as setCurveKeyInterp, type Key as CurveEditKey } from "../ui/curveEdit";
export { setValue, type SettingsDraft, type SettingsProblem } from "../projectSettingsModel";
export { persisted } from "../preferences";
// The editor theme's tokens (ADR 0025): `theme.value` tracks the Settings > Appearance theme.
export { theme, mix, parseHex, viewportColors, type ThemeTokens } from "../theme";
// The shared graph view (ADR 0060): canvas, wires, notes, minimap, search popup and clipboard.
export * from "../graph";
// The Assets panel's selected entries (read it, don't set it): what an asset browser drag carries (ADR 0022), for
// plugin panels that take dropped assets (the Event editor).
export { selectedAssets } from "../assetSelection";
// Drop targets for assets dragged from the Assets panel (ADR 0022): a plugin panel registers an element, the drag's
// label shows its message over it and releasing calls it. `draggedAssets` is what a drag in progress carries.
export { registerAssetDropTarget, draggedAssets, type AssetDropTargetSpec, type AssetDropPoint } from "../assetDropTargets";

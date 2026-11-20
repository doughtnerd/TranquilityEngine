// The editor SDK (ADR 0133): what `myco/editor` resolves to for plugin editor halves.
// Experimental until v1.
export * from "./registry";
export * from "./contributions";
export * from "./plugins";
export { openAssetDocument, type AssetDocument, type AssetRead, type EditOptions } from "../assetDocuments";
export type { InspectorSectionProps, InspectorSectionOptions } from "../ui/inspectorSections";
// Undo and Redo act on the active history (ADR 0145). An editor root marked `data-asset-document={doc.path}`
// makes its asset document the active history while focused; a panel with its own history registers it.
export { activeHistory, providePanelHistory, usePanelHistory, type ActiveHistory, type HistoryTree, type UndoHistory } from "../activeHistory";

// The project and editor surface (ADR 0147): `editor.project`, `editor.assets`, `editor.messages`,
// `editor.scene`, `editor.viewport` (ADR 0231) and `editor.showPanel`, over the shell's state, which plugins never import.
export { editor, type EditorSurface } from "./editor";
export type { ProjectSurface, ProjectSettingsSurface, AssetsSurface, CreateFileOptions, CreateAssetOptions, SectionChange, AssetImportSettings, AssetKind, EditorProject } from "./project";
export type { MessagesSurface, MessageAction } from "./messages";
export type { SceneSurface, SelectionSurface, PlayState, OpenScene, UndoStep, ComponentPlace, DocumentComponent, LiveComponent, FieldDrag } from "./scene";
export type { ViewportSurface } from "./viewport";
// Reading scene documents (ADR 0026): node paths and entries. Fields are written with `editor.scene.writeField` (ADR 0257).
export { pathKey, type ComponentEntry, type NodePath, type NodeEntry, type SceneDocument } from "../document";
// A drag on an Inspector control as one undo step through the edit gate (ADR 0257).
export { useFieldDrag, type FieldDragHandlers } from "../ui/fieldDrag";
// Building blocks for panels, inspectors and settings sections.
// The frame every panel renders in, and its instance's own view state (ADR 0174).
export { Panel, usePanel, usePanelState, usePanelValue, PanelInstanceContext, type PanelInstance, type PanelProps } from "../ui/panel/Panel";
export { sectionField } from "../ui/inspectorSections";
export { LargePreview } from "../ui/AssetPreview";
export { NameList, NumberField, ProblemList, Row, TextField } from "../ui/settingsControls";
export { useDraftText, type DraftText, type DraftInputProps } from "../ui/draftText";
// ADR 0158 §7: the shared curve widget (particles, audio events, later animation) and its pure key helpers.
export { CurveEditor, CurvePreview, type CurveEditorProps } from "../ui/CurveEditor";
export { addKey as addCurveKey, moveKey as moveCurveKey, removeKey as removeCurveKey, setKeyInterp as setCurveKeyInterp, type Key as CurveEditKey } from "../ui/curveEdit";
// Menus and floating panels (ADR 0180): placed, dismissed and focused in the window they're in (ADR 0174).
export { openPopover, usePopover, type DismissReason, type Popover, type PopoverOptions, type PopoverPoint } from "../ui/popover";
export { setValue, type SettingsDraft, type SettingsProblem } from "../projectSettingsModel";
// One project.json key of the settings draft (ADR 0253): its lenient parse, defaults, set-by-path, reset and problems.
export { settingsSection, type SettingsSection, type SettingsSectionSpec } from "../settingsSection";
export { persisted } from "../preferences";
// The editor theme's tokens (ADR 0025): `theme.value` tracks the Settings > Appearance theme.
export { theme, mix, parseHex, viewportColors, type ThemeTokens } from "../theme";
// The shared graph view (ADR 0060): canvas, wires, notes, minimap and search popup.
export * from "../graph";
// The editor's clipboard text (ADR 0226): tagged JSON written to the system clipboard and read back by a paste.
export { clipboardForPaste, clipboardText, expectPaste, readClipboard, takePaste, writeClipboard, type ClipboardPayload } from "../clipboard";
// The Assets panel's selected entries (read it, don't set it): what an asset browser drag carries (ADR 0022), for
// plugin panels that take dropped assets (the Event editor).
export { selectedAssets } from "../assetSelection";
// Drop targets for assets dragged from the Assets panel (ADR 0022): a plugin panel registers an element, the drag's
// label shows its message over it and releasing calls it. `draggedAssets` is what a drag in progress carries.
export { registerAssetDropTarget, draggedAssets, type AssetDropTargetSpec, type AssetDropPoint } from "../assetDropTargets";

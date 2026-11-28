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
export type { SceneSurface, SelectionSurface, SelectedBone, PlayState, OpenScene, UndoStep, ComponentPlace, DocumentComponent, LiveComponent, FieldDrag } from "./scene";
export type { ViewportSurface } from "./viewport";
// Reading scene documents (ADR 0026): node paths and entries. Fields are written with `editor.scene.writeField` (ADR 0257).
export { pathKey, type ComponentEntry, type NodePath, type NodeEntry, type SceneDocument } from "../document";
// A drag on an Inspector control as one undo step through the edit gate (ADR 0257).
export { useFieldDrag, type FieldDragHandlers } from "../ui/fieldDrag";
// Building blocks for panels, inspectors and settings sections.
// The frame every panel renders in, and its instance's own view state (ADR 0174).
export { Panel, usePanel, usePanelState, usePanelValue, PanelInstanceContext, type PanelInstance, type PanelProps } from "../ui/panel/Panel";
export { sectionField } from "../ui/inspectorSections";
export { LargePreview, type LargePreviewProps } from "../ui/AssetPreview";
// ADR 0373 (T18b): posed live previews: the nodes an asset adds to a scene, and the content a LargePreview poses.
export { assetNodesFor, type PosedPreview } from "../posedPreview";
// The frame every asset document editor renders in (ADR 0265): head, Undo / Redo, problems, read-only notice; the kind gives the body.
export { AssetDocumentFrame, type AssetDocumentFrameProps } from "../ui/AssetDocumentFrame";
export { NameList, NumberField, ProblemList, Row, TextField } from "../ui/settingsControls";
export { useDraftText, type DraftText, type DraftInputProps } from "../ui/draftText";
// ADR 0346: the one shared curve editor (a dialog over lanes, curves in units) and the inline curve field that opens
// it (particles, audio, the Studio); ADR 0158 §7's generic key-list helpers (curves, gradients).
export { CurveEditorDialog, type CurveEditorDialogProps } from "../ui/curves/CurveEditorDialog";
export { openCurveEditorDialog, type OpenCurveEditor } from "../ui/curves/openCurveEditorDialog";
export type { CurveEditorKind, CurveEditorResult, CurveEditorSpec, CurveInput, CurveLane, KeyShape } from "../ui/curves/curveEditorModel";
export type { WaveformFn as CurveWaveform } from "../ui/curves/CurvePlot";
export { CurveField, CurvePreview, type CurveFieldProps } from "../ui/curves/CurveField";
export { addKey as addCurveKey, moveKey as moveCurveKey, removeKey as removeCurveKey, setKeyInterp as setCurveKeyInterp, type Key as CurveEditKey } from "../ui/curves/keyList";
// ADR 0373: the dope sheet's grid (ruler, rows of keys, box select) and the key-list edits of several keys at once, shared
// by the curve editor's dope sheet and the Animation window.
// ADR 0468: the editor's one selection rule (Shift adds, Ctrl/Cmd toggles, a plain press on a selected item keeps the selection).
export { combineSelection, pressSelection, selectModeFor, type SelectMode } from "../selectMode";
export { DopeSheetGrid, type DopeBar, type DopeBarPart, type DopeKey, type DopeRow, type DopeSelectMode, type DopeSheetGridProps, type DopeSpan } from "../ui/curves/DopeSheetGrid";
export { copyKeysAt, fitYRange, pasteKeys, removeKeys, rippleKeys, scaleKeys, shiftKeys, SAME_X, type CopiedKeys, type KeysEdit } from "../ui/curves/keyList";
export { withEnds as withCurveEnds } from "../ui/curves/curveEditorModel";
// ADR 0396: the shared gradient field (colour stops under the bar, alpha stops above) and its pure key edits (particles, lines).
export { GradientField, GradientPreview, type GradientFieldProps } from "../ui/gradients/GradientField";
export { addAlphaKey as addGradientAlphaKey, addColorKey as addGradientColorKey, moveAlphaKey as moveGradientAlphaKey, moveColorKey as moveGradientColorKey, removeAlphaKey as removeGradientAlphaKey, removeColorKey as removeGradientColorKey, setColorKey as setGradientColorKey } from "../ui/gradients/gradientKeys";
/** What a component field holds in its scene document (or on the live node), in scene-file JSON (ADR 0373: the Animation window's record mode). */
export { storedFieldValue } from "../componentField";
/** @deprecated ADR 0346: use `CurveField` (the inline field) or `CurveEditorDialog`. Kept for one release. */
export { CurveField as CurveEditor, type CurveFieldProps as CurveEditorProps } from "../ui/curves/CurveField";
// Menus and floating panels (ADR 0180): placed, dismissed and focused in the window they're in (ADR 0174).
export { openPopover, usePopover, type DismissReason, type Popover, type PopoverOptions, type PopoverPoint } from "../ui/popover";
export { setValue, type SettingsDraft, type SettingsProblem } from "../projectSettingsModel";
// One project.json key of the settings draft (ADR 0253): its lenient parse, defaults, set-by-path, reset and problems.
export { settingsSection, type SettingsSection, type SettingsSectionSpec } from "../settingsSection";
export { persisted } from "../preferences";
// The debug link (ADR 0376): builds connected to this editor, and the one the live debuggers read (`active`).
export { editorDebugLink } from "../debugLink/link";
export type { ConnectedBuild, EditorDebugLink, ListenState } from "../debugLink/editorLink";
// The editor theme's tokens (ADR 0025): `theme.value` tracks the Settings > Appearance theme.
export { theme, mix, parseHex, viewportColors, type ThemeTokens } from "../theme";
// The shared graph view (ADR 0060): canvas, wires, notes, minimap and search popup.
export * from "../graph";
// The editor's clipboard text (ADR 0226): tagged JSON written to the system clipboard and read back by a paste.
export { clipboardForPaste, clipboardText, expectPaste, readClipboard, takePaste, writeClipboard, type ClipboardPayload } from "../clipboard";
// The Assets panel's selected entries (read it, don't set it): what an asset browser drag carries (ADR 0022), for
// plugin panels that take dropped assets (the Event editor).
export { selectedAssets } from "../assetSelection";
// Asset reference strings (ADR 0459): the project path a reference names (`assetRefTarget` keeps a `#slice` or
// sub-asset, `assetRefPath` drops it) and the split form, all on the engine's one rule (`engine/scene/assetPath.ts`).
export { assetRefPath, assetRefTarget, parseAssetRef, type AssetRef } from "../assetRefValues";
// Drop targets for assets dragged from the Assets panel (ADR 0022): a plugin panel registers an element, the drag's
// label shows its message over it and releasing calls it. `draggedAssets` is what a drag in progress carries.
export { registerAssetDropTarget, draggedAssets, type AssetDropTargetSpec, type AssetDropPoint } from "../assetDropTargets";
// One control per kind of value slot (ADR 0282): an asset picker over field kinds (listing, labels, the `asset:`
// prefix, built-ins, the missing state), and a slider and a colour field that report drags by one commit rule.
export { AssetPicker, type AssetPickerProps } from "../ui/AssetPicker";
export { ColorField, SliderField, type ColorFieldProps, type SliderFieldProps, type ValueReport } from "../ui/valueControls";
// The generic kit (ADR 0349), shared by the scene editor and the Audio Studio: empty states, undo toasts, context menus,
// the Move to… folder picker, segmented controls, chips, the History popover and the keyboard shortcuts dialog.
export { EmptyState, type EmptyStateProps } from "../ui/EmptyState";
export { UndoToasts, createToastQueue, UNDO_TOAST_MS, type Toast, type ToastQueue, type ToastRequest } from "../ui/UndoToast";
export { ContextMenu, SEPARATOR, tidyEntries, type ContextMenuProps, type MenuEntry, type MenuItem } from "../ui/ContextMenu";
export { MoveToDialog, type MoveToDialogProps, type MovingItem } from "../ui/MoveToDialog";
// The kit's dialog frame (header with × close, body, footer with summary and buttons), for a plugin's own dialogs (ADR 0438's import dialog).
export { KitDialog, type KitDialogProps } from "../ui/KitDialog";
export { SegmentedControl, type SegmentedControlProps, type SegmentOption } from "../ui/SegmentedControl";
export { Chip, type ChipProps, type ChipTone } from "../ui/Chip";
export { HistoryPopover, type HistoryPopoverProps } from "../ui/HistoryPopover";
export { KeyboardShortcutsDialog, type KeyboardShortcutsDialogProps, type ShortcutEntry, type ShortcutGroup } from "../ui/KeyboardShortcutsDialog";
// The 3D shape kit (ADR 0295): pose maths, wireframes, the face, radius and blend-shell handle rules and the axis drag
// that 3D handle gizmos build their shape tables from.
export * as shapeKit3d from "../shapeKit3d";
// Point editing for polygons (ADR 0439): handles, hit tests and what a press does, shared by outline and collision editors.
export { hitHandle, insidePolygon, pointHandles, pointIndex, pressPoints, type PointPress, type V2 } from "../polygonEdit";
// One refused-or-next result and the one place it is applied (ADR 0307, 0313); one parameter list and its cards (ADR 0304).
export { accept, refuse, refusalOf, mapEdit, placeEdit, applyEdit, applyToDocument, applyToSettings, type EditResult } from "./editResult";
export { parameterList, type ParameterHolder, type ParameterKind, type ParameterList, type ParameterRangePatch } from "./parameterList";
export { ParameterCards } from "./ParameterCard";

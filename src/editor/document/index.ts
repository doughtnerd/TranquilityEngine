// Headless editor model (ADR 0026): the scene document, undoable commands, the undo stack, and
// the sync that keeps an Editor World showing the document. No UI here.
export { SceneDocument, pathKey, sameTarget, type NodePath, type NodeReference, type ComponentEntry, type NodeEntry, type OverrideEntry, type SceneFile } from "./SceneDocument";
export {
  SetScenePreload,
  AddComponent,
  AddNode,
  CommandGroup,
  RemoveComponent,
  SetComponentEnabled,
  MoveComponent,
  SetComponents,
  ReplaceDocument,
  RemoveNode,
  RenameNode,
  ReparentNode,
  SetActive,
  SetField,
  WriteFiles,
  type AddNodeOptions,
  type Change,
  type Command,
  type FileWrite,
  type SetFieldOptions,
} from "./commands";
export { CommandStack, type StackEvent, type StackListener, type TextFileHost } from "./CommandStack";
export { HISTORY_LIMIT, HistoryTree, cleanPruneDays, type AgeOptions, type HistoryFile, type HistoryMove, type HistoryState, type LoadOptions, type StepAdapter } from "./HistoryTree";
export { applyFilePatch, diffText, type FilePatch } from "./textPatch";
export { TextHistory } from "./TextHistory";
export { applyPatch, changesBetween, diffFiles, hashFile, hashText, type DocPatch } from "./patch";
export { WorldSync } from "./WorldSync";
export { RebuildInstances, RevertOverrides, SetOverrides } from "./prefabCommands";
export { SetComponentWorlds, SetTags } from "./nodeCommands";

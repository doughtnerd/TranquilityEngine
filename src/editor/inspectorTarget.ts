// What the Inspector shows (ADR 0162), and the rule that keeps the selections behind it apart.
// Three selections can take the Inspector: the scene's nodes (`selectedKeys`), the Assets panel's
// entries (`selectedAssets`) and a UI document element (`selectedUIElement`, ADR 0077). Their
// signals stay where they are (state.ts, assetSelection.ts) as storage; every selection source
// writes them through the functions here, which apply the rule, and `inspectorTarget` answers
// what the Inspector shows. A live World of the running game (ADR 0022, 0124) is an overlay, not a
// selection: while one is picked it wins (runtimeInspect.ts).
import { batch, computed } from "@preact/signals";
import type { GameObject } from "../engine";
import { assetKind, folderOf } from "./assetBrowser";
import { isSliceEntry, splitSliceEntry } from "./assetEntry";
import { hasImportSettings } from "./assetImport";
import { kindInspector } from "./assetKindLookup";
import { openFolder, selectedAssets, setPanelSelection } from "./assetSelection";
import type { NodePath } from "./document";
import { inspectedWorld, liveInspecting, liveSelection } from "./runtimeInspect";
import { docVersion, openScene, selectedKeys, selectedUIElement, type OpenScene } from "./state";
import { findInner } from "./prefabs";
import { parseUIRefKey, uiRefKey, type UIElementRef } from "./uiDocuments";

/** What the Inspector shows, highest priority first. */
export type InspectorTarget =
  /** Playing, with a live World picked in the Hierarchy: its selected node, if any. */
  | { readonly kind: "live"; readonly world: string; readonly node: GameObject | null }
  /** One asset selected in the Assets panel that has an Inspector view (a selected slice shows its image). */
  | { readonly kind: "asset"; readonly path: string }
  /** An element of a UI document. */
  | { readonly kind: "uiElement"; readonly ref: UIElementRef }
  /** The selected nodes that still exist (an undo may have removed some), active last. */
  | { readonly kind: "nodes"; readonly scene: OpenScene; readonly paths: readonly NodePath[] }
  /** Nothing selected: the open scene's settings. */
  | { readonly kind: "sceneSettings"; readonly scene: OpenScene }
  /** No scene open. */
  | { readonly kind: "nothing" };

/** The file the Inspector shows for an Assets panel entry (a slice shows its image), or null if it has no Inspector view. */
export function inspectableAsset(entry: string): string | null {
  const file = isSliceEntry(entry) ? splitSliceEntry(entry).image : entry;
  // Its kind's own Inspector view, or its import settings (ADR 0133, 0143).
  return kindInspector(assetKind(file)) !== undefined || hasImportSettings(file) ? file : null;
}

/** The asset a selection of Assets panel entries puts in the Inspector: the one entry's file, or null. */
const assetOf = (entries: readonly string[]): string | null => (entries.length === 1 ? inspectableAsset(entries[0]) : null);

/** What the Inspector shows now. Tracks the selections, play mode and the open document. */
export const inspectorTarget = computed<InspectorTarget>(() => {
  if (liveInspecting()) return { kind: "live", world: inspectedWorld.value!, node: liveSelection.value };
  // The rule below keeps these apart; the order only matters if an asset became inspectable after
  // it was selected (a plugin loaded) while nodes or an element stayed selected.
  const keys = selectedKeys.value;
  const asset = keys.length === 0 ? assetOf(selectedAssets.value) : null;
  if (asset !== null) return { kind: "asset", path: asset };
  const element = selectedUIElement.value;
  const ref = element !== null ? parseUIRefKey(element) : null;
  if (ref) return { kind: "uiElement", ref };
  docVersion.value;
  const scene = openScene.value;
  if (!scene) return { kind: "nothing" };
  const paths = keys.map((k) => k.split("/") as NodePath).filter((p) => scene.doc.has(p[0]) && (p.length === 1 || findInner(scene.doc, p)));
  return paths.length > 0 ? { kind: "nodes", scene, paths } : { kind: "sceneSettings", scene };
});

/**
 * Select scene nodes (`keys`, duplicates dropped); `active`, if among them, becomes the active
 * node. Clears the selected UI element; selecting any node also clears the Assets panel's entries.
 */
export function select(keys: Iterable<string>, active?: string | null): void {
  const next = [...new Set(keys)];
  if (active != null && next.includes(active)) next.push(next.splice(next.indexOf(active), 1)[0]);
  const current = selectedKeys.peek();
  const same = next.length === current.length && next.every((k, i) => k === current[i]);
  batch(() => {
    if (selectedUIElement.peek() !== null) selectedUIElement.value = null;
    if (same) return;
    selectedKeys.value = next;
    if (next.length > 0 && selectedAssets.peek().length > 0) setPanelSelection([]);
  });
}

/**
 * Select Assets panel entries; the panel's cursor and Shift anchor go to `focus` (the last entry by
 * default). One entry the Inspector can show takes it: the nodes and UI element are cleared.
 * Anything else (several entries, a scene, a script, a folder) leaves them selected.
 */
export function selectAssets(entries: readonly string[], focus: string | null = entries.at(-1) ?? null, anchor: string | null = focus): void {
  batch(() => {
    setPanelSelection(entries, focus, anchor);
    if (assetOf(entries) === null) return;
    if (selectedKeys.peek().length > 0) selectedKeys.value = [];
    if (selectedUIElement.peek() !== null) selectedUIElement.value = null;
  });
}

/** Select a UI document element (null clears it). Clears the nodes and the Assets panel's entries. */
export function selectUIElement(ref: UIElementRef | null): void {
  batch(() => {
    if (selectedKeys.peek().length > 0) selectedKeys.value = [];
    if (selectedAssets.peek().length > 0) setPanelSelection([]);
    selectedUIElement.value = ref ? uiRefKey(ref) : null;
  });
}

/** Show the open scene's settings: clear every selection. */
export function showSceneSettings(): void {
  selectUIElement(null);
}

/** Show `path` in the Assets panel (opening its folder) and select it alone, so the Inspector shows it. */
export function showAsset(path: string): void {
  openFolder(folderOf(path));
  selectAssets([path]);
}

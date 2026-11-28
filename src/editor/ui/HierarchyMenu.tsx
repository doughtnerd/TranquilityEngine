// The Hierarchy's menus (ADR 0022, 0383): the "+" Create menu in its header and the right-click menu on rows and
// empty space. What they create is the Create tree (`createMenuTree.ts`: Empty and Camera, then a submenu per
// category), the same one the menu bar's Create menu draws; they're drawn as the shared context menu (`PanelMenu`).
import { openPrefabFrom } from "../prefabTabs";
import { signal } from "@preact/signals";
import { deleteSelected } from "../deleteSelection";
import { copySelection, createNodeAt, cutSelection, duplicateSelection, nodeClipboard, pasteClipboardAt, whyNotPasteAt } from "../hierarchyActions";
import { nodeCreateTree } from "../createMenuTree";
import type { MenuEntry } from "../menuBar";
import { whyNotInsert, type InsertPlace } from "../nodeInsertion";
import { isHidden, isLocked, nodeFlags, setHidden, setLocked } from "../nodeVisibility";
import { isInnerKey, keyExists, parseKey, rootOf } from "../nodeKey";
import { openScene, selectedKeys, selection, type OpenScene } from "../state";
import { whyNotEdit } from "../editGate";
import { resolveUIViewElement, selectedUIViewRef, uiViewRefKey, viewsOn, type UIViewRef } from "../uiViews";
import { createUIViewElement, deleteUIViewElement, duplicateUIViewElement, NEW_VIEW_ELEMENTS, whyNotEditViewElement, type UIViewAt } from "../uiViewEdits";
import { renameRow } from "./TreeView";
import { PanelMenu } from "./PanelMenu";

/** A menu item: a label, a shortcut, why it's unavailable, a submenu (the menu bar's shape). */
type MenuItem = MenuEntry;

/** The tree name the scene Hierarchy's rows are renamed under (`renameRow`, ADR 0278). */
export const HIERARCHY_TREE = "hierarchy";

/** A UI element row's key in the Hierarchy's tree: its ref key, set apart from scene nodes' path keys. */
export const uiTreeKey = (refKey: string) => `ui:${refKey}`;

/**
 * The open menu: where, its items, and the Hierarchy panel that opened it (`owner`): with two Hierarchy panels,
 * each draws only its own menus, so the other's popover doesn't take a press in the menu for one outside it and
 * close it before the item runs. No owner: every panel draws it.
 */
export const hierarchyMenu = signal<{ x: number; y: number; items: MenuItem[]; owner?: object } | null>(null);

const SEPARATOR: MenuItem = { label: "", separator: true };

/** The Create tree (ADR 0383), each kind adding at `place`. */
function createTree(scene: OpenScene, place: InsertPlace): MenuItem[] {
  return nodeCreateTree((k, label) => ({ label, disabled: whyNotInsert(scene, { kind: "new", node: k.kind }, place), run: () => void createNodeAt(k.kind, place) }));
}

/** A submenu `label` of HTML tags (ADR 0423 wave C) to insert into a view's component source at `at` (an element, or the view's top level). */
function uiViewElementSubmenu(label: string, at: UIViewRef | UIViewAt): MenuItem {
  const scene = openScene.value;
  const reason = "file" in at ? whyNotEditViewElement(scene, at) : whyNotEdit({ kind: "ui" }, "edit Svelte UI");
  const tags = Object.keys(NEW_VIEW_ELEMENTS).sort((a, b) => NEW_VIEW_ELEMENTS[a].label.localeCompare(NEW_VIEW_ELEMENTS[b].label));
  return { label, submenu: tags.map((tag) => ({ label: NEW_VIEW_ELEMENTS[tag].label, disabled: reason, run: () => void createUIViewElement(tag, at) })) };
}

/** Where the Create menu adds Svelte elements: the selected view element, or the selected node's (first) UIView. */
function uiViewCreateTarget(scene: OpenScene): UIViewRef | UIViewAt | null {
  const ref = selectedUIViewRef();
  if (ref) return ref;
  const active = selection.value;
  const node = active ? scene.sync.nodeFor(active) : null;
  return node && viewsOn(node).length > 0 ? { host: active!, index: 0 } : null;
}

/**
 * The "+" menu (and the menu bar's Create menu): the Create tree adding at the top level, then the same tree under
 * Child of Selection for the active selected node, if there is one; first, elements into the selected view's
 * component (ADR 0423 wave C).
 */
export function createMenuItems(scene: OpenScene): MenuItem[] {
  const active = selection.value;
  const view = uiViewCreateTarget(scene);
  const items: MenuItem[] = view ? [uiViewElementSubmenu("Element in Svelte Component", view), SEPARATOR] : [];
  items.push(...createTree(scene, { kind: "into", key: null }));
  if (active && keyExists(scene.doc, active)) items.push(SEPARATOR, { label: "Child of Selection", submenu: createTree(scene, { kind: "into", key: active }) });
  return items;
}

/** The right-click menu for an element a UIView rendered (ADR 0423 wave C): create inside it, rename, duplicate, delete; view-only ones say why. */
function uiViewElementMenuItems(scene: OpenScene, ref: UIViewRef, owner?: object): MenuItem[] {
  const el = resolveUIViewElement(scene.sync, ref);
  const reason = el ? whyNotEditViewElement(scene, ref) : "it's gone";
  return [
    uiViewElementSubmenu("Create Element", ref),
    SEPARATOR,
    { label: "Rename", shortcut: "F2", disabled: reason, run: () => renameRow(HIERARCHY_TREE, uiTreeKey(uiViewRefKey(ref)), owner) },
    { label: "Duplicate", shortcut: "Ctrl+D", disabled: reason, run: () => void duplicateUIViewElement(ref) },
    { label: "Delete", shortcut: "Del", disabled: reason, run: () => void deleteUIViewElement(ref) },
  ];
}

/** Open the right-click menu for a view element row, in the panel `owner`. */
export function openUIViewElementMenu(x: number, y: number, ref: UIViewRef, owner?: object): void {
  const scene = openScene.value;
  if (scene) hierarchyMenu.value = { x, y, items: uiViewElementMenuItems(scene, ref, owner), owner };
}

/**
 * The right-click menu for the row `key`: Create and Create Child (the Create tree beside it and in it), the
 * clipboard, Rename, Duplicate and Delete, Open Prefab, then the Scene view's visibility and picking. For empty space
 * (null): the Create tree at the top level, then Paste.
 */
function rowMenuItems(scene: OpenScene, key: string | null, owner?: object): MenuItem[] {
  const pasteItem = (asChild: boolean): MenuItem => ({
    label: asChild ? "Paste as Child" : "Paste",
    shortcut: asChild ? "Ctrl+Shift+V" : "Ctrl+V",
    disabled: nodeClipboard.value ? whyNotPasteAt(key, asChild) : "nothing copied",
    run: () => void pasteClipboardAt(key, asChild),
  });
  if (key === null) return [...createTree(scene, { kind: "into", key: null }), SEPARATOR, pasteItem(false)];
  const keys = selectedKeys.value;
  const inner = keys.some(isInnerKey) ? "nodes inside a prefab are edited in the prefab (Open Prefab)" : null;
  const editing = whyNotEdit({ kind: "scene", scene });
  const hiddenOwn = nodeFlags.value.hidden.has(key), lockedOwn = nodeFlags.value.locked.has(key);
  return [
    { label: "Create", submenu: createTree(scene, { kind: "after", key }) },
    { label: "Create Child", submenu: createTree(scene, { kind: "into", key }) },
    SEPARATOR,
    { label: "Cut", shortcut: "Ctrl+X", disabled: editing ?? inner, run: () => void cutSelection() },
    { label: "Copy", shortcut: "Ctrl+C", disabled: inner, run: () => void copySelection() },
    pasteItem(false),
    pasteItem(true),
    SEPARATOR,
    { label: "Rename", shortcut: "F2", disabled: editing, run: () => renameRow(HIERARCHY_TREE, key, owner) },
    { label: "Duplicate", shortcut: "Ctrl+D", disabled: editing ?? inner, run: () => void duplicateSelection() },
    { label: "Delete", shortcut: "Del", disabled: editing ?? (keys.some(isInnerKey) && !keys.every(isInnerKey) ? "can't delete nodes inside a prefab together with others" : null), run: () => void deleteSelected() },
    ...(scene.doc.has(rootOf(key)) && scene.doc.isPrefabInstance(rootOf(key))
      ? [SEPARATOR, { label: "Open Prefab", run: () => void openPrefabFrom(parseKey(key)) }]
      : []),
    SEPARATOR,
    {
      label: hiddenOwn ? "Show in Scene View" : "Hide in Scene View",
      disabled: !hiddenOwn && isHidden(scene.doc, key) ? "a parent is hidden" : null,
      run: () => setHidden(key, !hiddenOwn),
    },
    {
      label: lockedOwn ? "Unlock Picking" : "Lock Picking",
      disabled: !lockedOwn && isLocked(scene.doc, key) ? "a parent is locked" : null,
      run: () => setLocked(key, !lockedOwn),
    },
  ];
}

/** Open the right-click menu at a page point, in the panel `owner`. */
export function openHierarchyMenu(x: number, y: number, key: string | null, owner?: object): void {
  const scene = openScene.value;
  if (scene) hierarchyMenu.value = { x, y, items: rowMenuItems(scene, key, owner), owner };
}

/** Open the "+" menu under its button, in the panel `owner`. */
export function openCreateMenu(button: HTMLElement, owner?: object): void {
  const scene = openScene.value;
  if (!scene) return;
  const r = button.getBoundingClientRect();
  hierarchyMenu.value = { x: r.left, y: r.bottom + 2, items: createMenuItems(scene), owner };
}

/** The open menu, drawn in the panel that opened it (`owner`: that panel's view state), in that panel's window. */
export function HierarchyMenu(props: { owner?: object }) {
  const open = hierarchyMenu.value;
  const m = open && (open.owner === undefined || open.owner === props.owner) ? open : null;
  return <PanelMenu menu={m} label="Hierarchy menu" class="hierarchy-menu" onClose={() => (hierarchyMenu.value = null)} />;
}

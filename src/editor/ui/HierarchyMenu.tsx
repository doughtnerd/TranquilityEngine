// The Hierarchy's menus (ADR 0022): the "+" Create menu in its header and the right-click menu on
// rows and empty space. Same look and keys as the Assets panel's menu (`.context-menu`).
import { openPrefabFrom } from "../prefabTabs";
import { signal } from "@preact/signals";
import { useRef } from "preact/hooks";
import { deleteSelected } from "../deleteSelection";
import { copySelection, createNodeAt, cutSelection, duplicateSelection, nodeClipboard, pasteClipboardAt, whyNotPasteAt } from "../hierarchyActions";
import { newNodeKinds } from "../nodeKinds";
import { whyNotInsert, type InsertPlace } from "../nodeInsertion";
import { isHidden, isLocked, nodeFlags, setHidden, setLocked } from "../nodeVisibility";
import { isInsidePrefab } from "../hierarchyEdit";
import { openScene, playState, selectedKeys, selection, type OpenScene } from "../state";
import { createUIElement, deleteUIElement, duplicateUIElement, NEW_ELEMENTS, whyNotEditableUI } from "../uiDocumentEdits";
import { documentsOn, resolveUIElement, selectedUIRef, uiRefKey, type UIElementRef } from "../uiDocuments";
import { renamingUIElement } from "../uiElementDrag";
import { usePopover } from "./popover";

interface MenuItem {
  label: string;
  shortcut?: string;
  /** Why it's unavailable, or null/false/undefined when it is. */
  disabled?: string | false | null;
  run?: () => void;
  separator?: boolean;
}

/** The open menu: where, and its items. */
export const hierarchyMenu = signal<{ x: number; y: number; items: MenuItem[] } | null>(null);

const SEPARATOR: MenuItem = { label: "", separator: true };

/** "Create X" items adding at `place` (`suffix` tells child variants apart). */
function createItems(scene: OpenScene, place: InsertPlace, suffix: string): MenuItem[] {
  return newNodeKinds().map((k) => ({ label: `Create ${k.label}${suffix}`, disabled: whyNotInsert(scene, { kind: "new", node: k.kind }, place), run: () => void createNodeAt(k.kind, place) }));
}

const ELEMENT_LABELS: Readonly<Record<keyof typeof NEW_ELEMENTS, string>> = { Panel: "Panel", Text: "Text", Image: "Image", Button: "Button", InputField: "Input Field" };

/** "Create X in Document" items adding UI document elements (ADR 0077) into `at` (an element, or a document's root). */
function uiElementItems(at: UIElementRef | { host: string; index: number }): MenuItem[] {
  const reason = whyNotEditableUI();
  return (Object.keys(NEW_ELEMENTS) as (keyof typeof NEW_ELEMENTS)[]).map((tag) => ({ label: `Create ${ELEMENT_LABELS[tag]} in Document`, disabled: reason, run: () => void createUIElement(tag, at) }));
}

/** Where the Create menu adds UI document elements: the selected element, or the selected node's (first) document. */
function uiCreateTarget(scene: OpenScene): UIElementRef | { host: string; index: number } | null {
  const ref = selectedUIRef();
  if (ref) return ref;
  const active = selection.value;
  const node = active ? scene.sync.nodeFor(active) : null;
  return node && documentsOn(node).length > 0 ? { host: active!, index: 0 } : null;
}

/** The "+" menu: new nodes at the top level, and under the active selected node if there is one; UI elements into the selected document. */
export function createMenuItems(scene: OpenScene): MenuItem[] {
  const active = selection.value;
  const ui = uiCreateTarget(scene);
  const items = ui ? [...uiElementItems(ui), SEPARATOR] : [];
  items.push(...createItems(scene, { kind: "into", key: null }, ""));
  if (active && scene.doc.has(active.split("/")[0])) items.push(SEPARATOR, ...createItems(scene, { kind: "into", key: active }, " Child"));
  return items;
}

/** The right-click menu for a UI document element row (ADR 0077): create inside it, rename, duplicate, delete. */
function uiElementMenuItems(scene: OpenScene, ref: UIElementRef): MenuItem[] {
  const el = resolveUIElement(scene.sync, ref);
  const reason = whyNotEditableUI() ?? (el ? null : "it's gone");
  const label = el?._synthetic ? "a button's label is its text content" : null;
  const root = el && !el.parent ? "it's the document's root" : null;
  return [
    ...uiElementItems(ref),
    SEPARATOR,
    { label: "Rename", shortcut: "F2", disabled: reason ?? label, run: () => (renamingUIElement.value = uiRefKey(ref)) },
    { label: "Duplicate", shortcut: "Ctrl+D", disabled: reason ?? label ?? root, run: () => void duplicateUIElement(ref) },
    { label: "Delete", shortcut: "Del", disabled: reason ?? root, run: () => void deleteUIElement(ref) },
  ];
}

/** Open the right-click menu for a UI document element row. */
export function openUIElementMenu(x: number, y: number, ref: UIElementRef): void {
  const scene = openScene.value;
  if (scene) hierarchyMenu.value = { x, y, items: uiElementMenuItems(scene, ref) };
}

/** The right-click menu for the row `key`, or for empty space (null). */
function rowMenuItems(scene: OpenScene, key: string | null): MenuItem[] {
  const pasteItem = (asChild: boolean): MenuItem => ({
    label: asChild ? "Paste as Child" : "Paste",
    shortcut: asChild ? "Ctrl+Shift+V" : "Ctrl+V",
    disabled: nodeClipboard.value ? whyNotPasteAt(key, asChild) : "nothing copied",
    run: () => void pasteClipboardAt(key, asChild),
  });
  if (key === null) return [...createItems(scene, { kind: "into", key: null }, ""), SEPARATOR, pasteItem(false)];
  const keys = selectedKeys.value;
  const inner = keys.some(isInsidePrefab) ? "nodes inside a prefab are edited in the prefab (Open Prefab)" : null;
  const editing = playState.value !== "edit" ? "stop playing to edit the scene" : null;
  const hiddenOwn = nodeFlags.value.hidden.has(key), lockedOwn = nodeFlags.value.locked.has(key);
  return [
    ...createItems(scene, { kind: "after", key }, ""),
    SEPARATOR,
    ...createItems(scene, { kind: "into", key }, " Child"),
    SEPARATOR,
    { label: "Cut", shortcut: "Ctrl+X", disabled: editing ?? inner, run: () => void cutSelection() },
    { label: "Copy", shortcut: "Ctrl+C", disabled: inner, run: () => void copySelection() },
    pasteItem(false),
    pasteItem(true),
    { label: "Duplicate", shortcut: "Ctrl+D", disabled: editing ?? inner, run: () => void duplicateSelection() },
    { label: "Delete", shortcut: "Del", disabled: editing ?? (keys.some(isInsidePrefab) && !keys.every(isInsidePrefab) ? "can't delete nodes inside a prefab together with others" : null), run: () => void deleteSelected() },
    ...(scene.doc.has(key.split("/")[0]) && scene.doc.isPrefabInstance(key.split("/")[0])
      ? [SEPARATOR, { label: "Open Prefab", run: () => void openPrefabFrom(key.split("/")) }]
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

/** Open the right-click menu at a page point. */
export function openHierarchyMenu(x: number, y: number, key: string | null): void {
  const scene = openScene.value;
  if (scene) hierarchyMenu.value = { x, y, items: rowMenuItems(scene, key) };
}

/** Open the "+" menu under its button. */
export function openCreateMenu(button: HTMLElement): void {
  const scene = openScene.value;
  if (!scene) return;
  const r = button.getBoundingClientRect();
  hierarchyMenu.value = { x: r.left, y: r.bottom + 2, items: createMenuItems(scene) };
}

export function HierarchyMenu() {
  const m = hierarchyMenu.value;
  const el = useRef<HTMLDivElement>(null);
  // In its own window (a detached panel window, ADR 0174), measured to stay on screen.
  usePopover(el, !!m, { anchor: m, key: m, focusFirst: true, onDismiss: () => (hierarchyMenu.value = null) });
  if (!m) return null;
  return (
    <div ref={el} class="context-menu hierarchy-menu" role="menu">
      {m.items.map((item, i) =>
        item.separator ? (
          <div key={i} class="context-sep" role="separator" />
        ) : (
          <button
            key={i}
            role="menuitem"
            disabled={!!item.disabled}
            title={item.disabled || undefined}
            onClick={() => {
              hierarchyMenu.value = null;
              item.run?.();
            }}
          >
            <span>{item.label}</span>
            {item.shortcut && <span class="context-key">{item.shortcut}</span>}
          </button>
        ),
      )}
    </div>
  );
}

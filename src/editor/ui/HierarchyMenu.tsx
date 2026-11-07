// The Hierarchy's menus (ADR 0022): the "+" Create menu in its header and the right-click menu on
// rows and empty space. Same look and keys as the Assets panel's menu (`.context-menu`).
import { signal } from "@preact/signals";
import { useEffect, useLayoutEffect, useRef } from "preact/hooks";
import { deleteSelected } from "../deleteSelection";
import { copySelection, createNodeIn, cutSelection, duplicateSelection, nodeClipboard, pasteClipboardAt, whyNotPasteAt } from "../hierarchyActions";
import { NEW_NODE_KINDS, whyNotCreatable } from "../nodeCreate";
import { isHidden, isLocked, nodeFlags, setHidden, setLocked } from "../nodeVisibility";
import { isInsidePrefab } from "../hierarchyEdit";
import { openScene, playState, selectedKeys, selection, type OpenScene } from "../state";
import { createUIElement, deleteUIElement, duplicateUIElement, NEW_ELEMENTS, whyNotEditableUI } from "../uiDocumentEdits";
import { documentsOn, resolveUIElement, selectedUIRef, uiRefKey, type UIElementRef } from "../uiDocuments";
import { renamingUIElement } from "../uiElementDrag";

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

/** "Create X" items adding under `parent` at `index` (`suffix` tells child variants apart). */
function createItems(scene: OpenScene, parent: string | null, index: number | undefined, suffix: string): MenuItem[] {
  const reason = playState.value !== "edit" ? "stop playing to edit the scene" : whyNotCreatable(scene.doc, parent);
  return NEW_NODE_KINDS.map((k) => ({ label: `Create ${k.label}${suffix}`, disabled: reason, run: () => void createNodeIn(k.kind, parent, index) }));
}

/** Where a new sibling of the row `key` goes: right after it (after its instance, inside a prefab). */
function besideRow(scene: OpenScene, key: string): { parent: string | null; index: number } {
  const id = key.split("/")[0];
  const parent = scene.doc.parentOf(id);
  return { parent, index: scene.doc.children(parent).indexOf(id) + 1 };
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
  items.push(...createItems(scene, null, undefined, ""));
  if (active && scene.doc.has(active.split("/")[0])) items.push(SEPARATOR, ...createItems(scene, active, undefined, " Child"));
  return items;
}

/** The right-click menu for a UI document element row (ADR 0077): create inside it, rename, duplicate, delete. */
export function uiElementMenuItems(scene: OpenScene, ref: UIElementRef): MenuItem[] {
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
export function rowMenuItems(scene: OpenScene, key: string | null): MenuItem[] {
  const pasteItem = (asChild: boolean): MenuItem => ({
    label: asChild ? "Paste as Child" : "Paste",
    shortcut: asChild ? "Ctrl+Shift+V" : "Ctrl+V",
    disabled: nodeClipboard.value ? whyNotPasteAt(key, asChild) : "nothing copied",
    run: () => void pasteClipboardAt(key, asChild),
  });
  if (key === null) return [...createItems(scene, null, undefined, ""), SEPARATOR, pasteItem(false)];
  const beside = besideRow(scene, key);
  const keys = selectedKeys.value;
  const inner = keys.some(isInsidePrefab) ? "nodes inside a prefab are edited in the prefab" : null;
  const editing = playState.value !== "edit" ? "stop playing to edit the scene" : null;
  const hiddenOwn = nodeFlags.value.hidden.has(key), lockedOwn = nodeFlags.value.locked.has(key);
  return [
    ...createItems(scene, beside.parent, beside.index, ""),
    SEPARATOR,
    ...createItems(scene, key, undefined, " Child"),
    SEPARATOR,
    { label: "Cut", shortcut: "Ctrl+X", disabled: editing ?? inner, run: () => void cutSelection() },
    { label: "Copy", shortcut: "Ctrl+C", disabled: inner, run: () => void copySelection() },
    pasteItem(false),
    pasteItem(true),
    { label: "Duplicate", shortcut: "Ctrl+D", disabled: editing ?? inner, run: () => void duplicateSelection() },
    { label: "Delete", shortcut: "Del", disabled: editing ?? (keys.some(isInsidePrefab) && !keys.every(isInsidePrefab) ? "can't delete nodes inside a prefab together with others" : null), run: () => void deleteSelected() },
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
  useEffect(() => {
    if (!m) return;
    const close = (e: Event) => {
      if (e instanceof KeyboardEvent && e.key !== "Escape") return;
      if (e.type === "pointerdown" && el.current?.contains(e.target as Node)) return;
      if (e instanceof KeyboardEvent) e.stopPropagation();
      hierarchyMenu.value = null;
    };
    window.addEventListener("pointerdown", close, true);
    window.addEventListener("keydown", close, true);
    window.addEventListener("blur", close);
    el.current?.querySelector<HTMLButtonElement>("button:not(:disabled)")?.focus();
    return () => {
      window.removeEventListener("pointerdown", close, true);
      window.removeEventListener("keydown", close, true);
      window.removeEventListener("blur", close);
    };
  }, [m]);
  // Keep it on screen: measured once drawn, moved up to fit, and scrolling when taller than the window.
  useLayoutEffect(() => {
    const menu = el.current;
    if (!menu) return;
    const r = menu.getBoundingClientRect();
    if (r.bottom > window.innerHeight - 4) menu.style.top = `${Math.max(4, window.innerHeight - r.height - 4)}px`;
  }, [m]);
  if (!m) return null;
  // A first guess before it's measured.
  const rows = m.items.filter((i) => !i.separator).length, seps = m.items.length - rows;
  const x = Math.min(m.x, window.innerWidth - 230), y = Math.min(m.y, window.innerHeight - rows * 24 - seps * 9 - 12);
  return (
    <div ref={el} class="context-menu hierarchy-menu" role="menu" style={{ left: `${Math.max(0, x)}px`, top: `${Math.max(0, y)}px` }}>
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

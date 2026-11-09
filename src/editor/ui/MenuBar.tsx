// The editor's menu bar (File, Edit, Create, Window, Help). The items are data (menuBar.ts); this
// reads the live state into them and draws them with the `.context-menu` look.
import { signal } from "@preact/signals";
import { useEffect, useLayoutEffect, useRef, useState } from "preact/hooks";
import { isTauri } from "../../engine/platform/FileSystem";
import { activeHistory, redo, undo } from "../activeHistory";
import { panelTarget, runAsset, whyNotAsset, type AssetCommandId } from "../assetActions";
import { deleteSelected } from "../deleteSelection";
import { copySelection, cutSelection, duplicateSelection, nodeClipboard, pasteClipboard, whyNotPasteHere } from "../hierarchyActions";
import { isInsidePrefab } from "../hierarchyEdit";
import { layout, resetLayout, showPanel } from "../layout/store";
import type { PanelId } from "../layout/model";
import { buildMenus, DOCS_URL, SEPARATOR, type AssetClipboardReasons, type Menu, type MenuActions, type MenuEntry, type MenuState } from "../menuBar";
import { logOpen, unseenErrors } from "../messages";
import { createScene } from "../newScene";
import { canOpenFolders } from "../projectFs";
import { recentProjects, recentVersion } from "../recentProjects";
import { closeProject, openProjectFolder, openRecentProject, reloadScripts, save } from "../session";
import { isEditable } from "../shortcuts";
import { currentProject, docVersion, openScene, playState, selectedKeys, selectedUIElement } from "../state";
import { aboutOpen } from "./AboutDialog";
import { exportOpen, settingsOpen } from "./dialogState";
import { createMenuItems } from "./HierarchyMenu";
import { openNewProjectDialog } from "./NewProjectDialog";
import "./menubar.css";

const RECENT_IN_MENU = 5;

/** Whether a menu is open, so other Escape handlers (the message log) leave Escape to it. */
export const menuOpen = signal(false);

/** A modal dialog is open: the menu bar does nothing then, as the global shortcuts don't (shortcuts.ts). */
const dialogOpen = () => !!document.querySelector(".dialog");

/** Where the focus was before the menu bar took it (Alt, or opening a menu); it goes back there after. */
let returnTo: HTMLElement | null = null;

function rememberFocus(root: HTMLElement | null): void {
  const active = document.activeElement as HTMLElement | null;
  if (active && active !== document.body && !root?.contains(active)) returnTo = active;
}

/** Give the focus back to where it was before the menu bar took it. True if it went somewhere. */
function restoreFocus(): boolean {
  const el = returnTo;
  returnTo = null;
  if (!el?.isConnected) return false;
  el.focus();
  return true;
}

/** The focus is in the Assets panel, whose own keys copy, paste and delete files. */
const inAssets = () => !!(document.activeElement as Element | null)?.closest?.(".asset-browser");

/**
 * Run a clipboard command where its shortcut would go: in the Assets panel, the Assets command on
 * the panel's selection (ADR 0157), otherwise on the Hierarchy's nodes.
 */
function clipboardAction(command: AssetCommandId, nodes: () => void): () => void {
  return () => {
    const target = inAssets() ? panelTarget() : null;
    if (target) void runAsset(command, target);
    else nodes();
  };
}

/** Why Edit's clipboard items can't act on the Assets panel's selection (the panel's own rules). */
function assetReasons(): AssetClipboardReasons | null {
  const target = panelTarget();
  if (!target) return null;
  return {
    cut: whyNotAsset("cut", target),
    copy: whyNotAsset("copy", target),
    paste: whyNotAsset("paste", target),
    duplicate: whyNotAsset("duplicate", target),
    delete: whyNotAsset("delete", target),
  };
}

async function openDocs(): Promise<void> {
  if (isTauri()) {
    try {
      const opener = await import("@tauri-apps/plugin-opener");
      await opener.openUrl(DOCS_URL);
      return;
    } catch (err) {
      console.error(err);
    }
  }
  window.open(DOCS_URL, "_blank", "noopener");
}

async function exit(): Promise<void> {
  const { getCurrentWindow } = await import("@tauri-apps/api/window");
  await getCurrentWindow().close(); // the close guard asks about unsaved changes
}

const ACTIONS: MenuActions = {
  newProject: openNewProjectDialog,
  openProject: () => void openProjectFolder(),
  openRecent: (id) => {
    const entry = recentProjects().list().find((e) => e.id === id);
    if (entry) void openRecentProject(entry);
  },
  save: () => void save(),
  newScene: () => void createScene(),
  reloadScripts: () => void reloadScripts(),
  exportBuild: () => (exportOpen.value = true),
  showPanel,
  resetLayout,
  closeProject: () => void closeProject(),
  exit: () => void exit(),
  undo: () => void undo(),
  redo: () => void redo(),
  cut: clipboardAction("cut", () => void cutSelection()),
  copy: clipboardAction("copy", () => void copySelection()),
  paste: clipboardAction("paste", () => void pasteClipboard(false)),
  duplicate: clipboardAction("duplicate", () => void duplicateSelection()),
  remove: clipboardAction("delete", () => void deleteSelected()),
  openSettings: () => (settingsOpen.value = true),
  openDocs: () => void openDocs(),
  openLog: () => {
    logOpen.value = true;
    unseenErrors.value = 0;
  },
  openAbout: () => (aboutOpen.value = true),
};

/** The panels showing now: the active tab of each group, in docks that aren't collapsed. */
function visiblePanels(): Set<PanelId> {
  const visible = new Set<PanelId>();
  for (const dock of layout.value.docks) if (!dock.collapsed) for (const g of dock.groups) visible.add(g.active);
  return visible;
}

/** Hierarchy "Create X" items as menu entries: "X" (and "X Child" under the selection). */
function createEntries(): readonly MenuEntry[] {
  const scene = openScene.value;
  if (!scene) return [];
  return createMenuItems(scene).map((i) =>
    i.separator ? SEPARATOR : { label: i.label.replace(/^Create /, ""), disabled: i.disabled, run: i.run },
  );
}

/** The menus for the editor's state right now (reads signals, so the bar redraws when they change). */
function liveMenus(): Menu[] {
  docVersion.value; // the undo stack and dirty flag change without a new scene
  recentVersion.value;
  nodeClipboard.value;
  const project = currentProject.value;
  const scene = openScene.value;
  const stack = scene?.stack;
  const history = activeHistory.value?.history;
  const folders = canOpenFolders();
  const state: MenuState = {
    project: project ? { name: project.name, canSave: project.canSave, hasRoot: project.root != null } : null,
    scene: scene && stack ? { path: scene.path, dirty: stack.dirty } : null,
    history: history ? { undoLabel: history.undoLabel ?? null, redoLabel: history.redoLabel ?? null, canUndo: history.canUndo, canRedo: history.canRedo } : null,
    playing: playState.value !== "edit",
    canOpenFolders: folders,
    isDesktop: isTauri(),
    recent: folders
      ? recentProjects()
          .list()
          .filter((e) => e.path !== project?.root)
          .slice(0, RECENT_IN_MENU)
          .map((e) => ({ id: e.id, name: e.name, path: e.path }))
      : [],
    visiblePanels: visiblePanels(),
    pasteBlocked: nodeClipboard.value ? whyNotPasteHere() : "nothing copied",
    selectionInPrefab: selectedKeys.value.some(isInsidePrefab),
    hasSelection: selectedKeys.value.length > 0 || selectedUIElement.value !== null,
    assets: returnTo?.closest(".asset-browser") ? assetReasons() : null,
    createItems: createEntries(),
  };
  return buildMenus(state, ACTIONS);
}

/** The enabled item buttons directly inside a menu element. */
const itemButtons = (menu: HTMLElement): HTMLButtonElement[] => Array.from(menu.querySelectorAll<HTMLButtonElement>(":scope > .menubar-entry > button:not(:disabled)"));

type Focus = "first" | "last" | null;

/** A drop-down (or a submenu beside its item), fixed in place and kept on screen. */
function Popup({ items, anchor, side, focus, close, closeAll }: { items: readonly MenuEntry[]; anchor: () => HTMLElement | null; side: boolean; focus: Focus; close: () => void; closeAll: () => void }) {
  const el = useRef<HTMLDivElement>(null);
  const [sub, setSub] = useState<{ index: number; focus: Focus } | null>(null);
  const checks = items.some((i) => i.checked !== undefined);

  useLayoutEffect(() => {
    const menu = el.current, from = anchor();
    if (!menu || !from) return;
    const a = from.getBoundingClientRect();
    const width = window.innerWidth, height = window.innerHeight;
    menu.style.maxHeight = `${height - 8}px`;
    const r = menu.getBoundingClientRect();
    let x = side ? a.right - 2 : a.left;
    let y = side ? a.top - 4 : a.bottom;
    if (x + r.width > width - 4) x = side ? Math.max(4, a.left - r.width + 2) : Math.max(4, width - r.width - 4);
    if (y + r.height > height - 4) y = Math.max(4, height - r.height - 4);
    menu.style.left = `${x}px`;
    menu.style.top = `${y}px`;
  }, [items]);

  useEffect(() => {
    if (!focus || !el.current) return;
    const buttons = itemButtons(el.current);
    (focus === "first" ? buttons[0] : buttons[buttons.length - 1])?.focus();
  }, [focus]);

  const onKeyDown = (e: KeyboardEvent) => {
    const menu = el.current;
    const target = e.target as HTMLElement;
    if (!menu || target.closest('[role="menu"]') !== menu) return; // a submenu's own keys
    const buttons = itemButtons(menu);
    const at = buttons.indexOf(target as HTMLButtonElement);
    const move = (to: number) => {
      e.preventDefault();
      e.stopPropagation();
      buttons[(to + buttons.length) % buttons.length]?.focus();
    };
    if (e.key === "ArrowDown") move(at + 1);
    else if (e.key === "ArrowUp") move(at < 0 ? -1 : at - 1);
    else if (e.key === "Home") move(0);
    else if (e.key === "End") move(-1);
    else if (e.key === "ArrowRight") {
      const index = Number(target.dataset.index);
      if (items[index]?.submenu && !items[index].disabled) {
        e.preventDefault();
        e.stopPropagation();
        setSub({ index, focus: "first" });
      }
    } else if ((e.key === "ArrowLeft" || e.key === "Escape") && side) {
      e.preventDefault();
      e.stopPropagation();
      close();
    }
  };

  return (
    <div ref={el} class="context-menu menubar-menu" role="menu" onKeyDown={onKeyDown}>
      {items.map((item, i) => {
        if (item.separator) return <div key={i} class="context-sep" role="separator" />;
        const open = sub?.index === i;
        const role = item.checked !== undefined ? "menuitemcheckbox" : "menuitem";
        return (
          <div key={i} class="menubar-entry" onPointerEnter={() => setSub(item.submenu && !item.disabled ? { index: i, focus: null } : null)}>
            <button
              role={role}
              data-index={i}
              tabIndex={-1}
              aria-checked={item.checked === undefined ? undefined : item.checked}
              aria-haspopup={item.submenu ? "menu" : undefined}
              aria-expanded={item.submenu ? open : undefined}
              disabled={!!item.disabled}
              title={item.disabled || item.title || undefined}
              onClick={() => {
                if (item.submenu) return setSub({ index: i, focus: null }); // (hovering already opened it)
                closeAll();
                restoreFocus(); // first, so actions that go where the focus is (the clipboard's) go to the right place
                item.run?.();
              }}
            >
              <span class="menubar-label">
                {checks && <span class="menubar-check" aria-hidden="true">{item.checked ? "✓" : ""}</span>}
                {item.label}
              </span>
              {item.submenu ? <span class="context-key" aria-hidden="true">▸</span> : item.shortcut && <span class="context-key">{item.shortcut}</span>}
            </button>
            {open && item.submenu && (
              <Popup
                items={item.submenu}
                side
                focus={sub.focus}
                anchor={() => el.current?.querySelector<HTMLElement>(`:scope > .menubar-entry > button[data-index="${i}"]`)?.closest<HTMLElement>(".menubar-entry") ?? null}
                close={() => {
                  setSub(null);
                  el.current?.querySelector<HTMLButtonElement>(`:scope > .menubar-entry > button[data-index="${i}"]`)?.focus();
                }}
                closeAll={closeAll}
              />
            )}
          </div>
        );
      })}
    </div>
  );
}

/** The menu titles and the drop-down of the open one. */
export function MenuBar() {
  const menus = liveMenus();
  const root = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState<{ index: number; focus: Focus } | null>(null);
  const titles = () => Array.from(root.current?.querySelectorAll<HTMLButtonElement>(":scope > .menubar-slot > .menubar-title") ?? []);

  useEffect(() => {
    menuOpen.value = open !== null;
  }, [open !== null]);

  useEffect(() => {
    if (!open) return;
    const away = (e: PointerEvent) => !root.current?.contains(e.target as Node) && setOpen(null);
    const blur = () => setOpen(null);
    window.addEventListener("pointerdown", away, true);
    window.addEventListener("blur", blur);
    return () => {
      window.removeEventListener("pointerdown", away, true);
      window.removeEventListener("blur", blur);
    };
  }, [open !== null]);

  // Alt pressed and released on its own moves focus to the first title. Anything else while it's
  // held (another key, a click such as the scene view's Alt+click, the wheel) makes it a modifier.
  useEffect(() => {
    let alone = false;
    const down = (e: KeyboardEvent) => (alone = e.key === "Alt" && !e.repeat && !e.ctrlKey && !e.metaKey && !e.shiftKey);
    const used = () => (alone = false);
    const up = (e: KeyboardEvent) => {
      if (e.key !== "Alt" || !alone) return;
      alone = false;
      // Not over a dialog, in a text field or in the Code panel's editor, which keep their own keys.
      const target = e.target as Element | null;
      if (dialogOpen() || isEditable(target) || target?.closest?.(".monaco-editor")) return;
      e.preventDefault(); // not the system menu
      rememberFocus(root.current);
      titles()[0]?.focus();
    };
    window.addEventListener("keydown", down, true);
    window.addEventListener("keyup", up, true);
    window.addEventListener("pointerdown", used, true);
    window.addEventListener("wheel", used, true);
    return () => {
      window.removeEventListener("keydown", down, true);
      window.removeEventListener("keyup", up, true);
      window.removeEventListener("pointerdown", used, true);
      window.removeEventListener("wheel", used, true);
    };
  }, []);

  const closeAll = () => setOpen(null);
  const goTo = (index: number, keepOpen: boolean) => {
    const all = titles();
    const next = (index + all.length) % all.length;
    if (keepOpen) setOpen({ index: next, focus: "first" });
    else all[next]?.focus();
  };

  const onKeyDown = (e: KeyboardEvent) => {
    if (dialogOpen()) return;
    const target = e.target as HTMLElement;
    const all = titles();
    const inMenu = !!target.closest('[role="menu"]');
    const current = inMenu ? (open?.index ?? 0) : all.indexOf(target as HTMLButtonElement);
    if (current < 0) return;
    if (e.key === "ArrowRight" || e.key === "ArrowLeft") {
      e.preventDefault();
      goTo(current + (e.key === "ArrowRight" ? 1 : -1), open !== null);
    } else if (!inMenu && (e.key === "ArrowDown" || e.key === "ArrowUp")) {
      e.preventDefault();
      setOpen({ index: current, focus: e.key === "ArrowDown" ? "first" : "last" });
    } else if (e.key === "Escape") {
      // Close the menu (if one is open) and give the focus back to where it was.
      e.preventDefault();
      setOpen(null);
      if (!restoreFocus() && open) all[current]?.focus();
    } else if (e.key === "Tab") {
      setOpen(null);
    }
  };

  return (
    <div class="menubar" ref={root} role="menubar" aria-label="Main menu" onKeyDown={onKeyDown}>
      {menus.map((menu, i) => (
        <div class="menubar-slot" key={menu.id}>
          <button
            class="menubar-title"
            role="menuitem"
            aria-haspopup="menu"
            aria-expanded={open?.index === i}
            tabIndex={i === 0 ? 0 : -1}
            onPointerDown={() => rememberFocus(root.current)}
            onClick={(e) => {
              if (dialogOpen()) return;
              // Enter or Space (a click with no pointer) opens it with the first item focused.
              setOpen(open?.index === i ? null : { index: i, focus: e.detail === 0 ? "first" : null });
            }}
            onPointerEnter={() => open && open.index !== i && !dialogOpen() && setOpen({ index: i, focus: null })}
            onFocus={(e) => {
              for (const t of titles()) t.tabIndex = t === e.currentTarget ? 0 : -1;
            }}
          >
            {menu.label}
          </button>
          {open?.index === i && (
            <Popup
              key={menu.id}
              items={menu.items}
              side={false}
              focus={open.focus}
              anchor={() => titles()[i] ?? null}
              close={closeAll}
              closeAll={closeAll}
            />
          )}
        </div>
      ))}
    </div>
  );
}

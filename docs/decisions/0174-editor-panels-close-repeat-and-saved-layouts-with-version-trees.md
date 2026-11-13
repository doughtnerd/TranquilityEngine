# 0174. Editor panels can be closed, added and repeated; layouts are saved by name with a version tree, per user or per project

- **Status:** Proposed
- **Date:** 2026-11-13
- **Deciders:** Chris Carlson
- **Supersedes:** —
- **Related:** 0025, 0027, 0063 (amended: the Window menu), 0083, 0133, 0134, 0151

## Context

The editor's docking (`src/editor/layout/model.ts`, `DockLayout.tsx`, `store.ts`) has docks, tab groups, drag-to-move, resize, collapse and tab overflow. What it lacks:

- **Panels can't be closed.** ADR 0063 says so ("panels can't be closed, so there's nothing to toggle off"); the Window menu only brings a panel to the front.
- **One instance per panel.** A `TabGroup.panels` entry is a `PanelId`, which is both the panel's type and its identity, and `parseLayout` rejects a layout naming one twice.
- **One layout.** The arrangement lives in `localStorage` under `myco.editor.layout`. Reset Layout is the only other layout there is.
- **Plugin panels vanish.** `parseLayout` drops panels that are neither built in nor registered, so turning a plugin off (ADR 0133) silently removes its panels from the layout, and turning it on puts them back wherever `beside` says, not where the user had them. Nothing records which plugin a panel came from (`registerPanel` in `sdk/plugins.ts` doesn't keep the owner).
- **No detached windows.** Everything renders in the one editor window.

Some panels keep module-level state (`Hierarchy.tsx`: `collapsed`, `expanded`, `hierarchyQuery`; `Assets.tsx`: the current folder and menu). Two mounted copies of such a panel show the same state. The Scene panel owns the engine's viewport element and WebGL context (`viewportElements()` in `ScenePanel.tsx`), so there can only be one.

## Decision

### Panel instances

- **Instance ids.** A layout entry is a *panel instance id*: the panel's type id for the first instance (`"hierarchy"`, so every saved layout stays valid) and `type#n` for more (`"hierarchy#2"`). `panelType(id)` strips the suffix; `panelTitle`, `isKnownPanel`, `panelBeside`, `isOnDemand` and `PANEL_VIEWS` look up by type. A second instance is titled "Hierarchy 2". `parseLayout` still rejects the same *instance* id twice.
- **Shared data.** Instances of a type render the same component and share its data (selection, scene, project). Module-level view state (the Hierarchy's expanded rows, the Assets panel's folder) is shared too in this record; making it per instance is a per-panel follow-up, not a framework change.
- **Single-instance panels.** `PanelContribution` gains `single?: boolean`. The Scene panel is single (one viewport and WebGL context). The Add Panel dialog offers a single panel only when it is not open.
- **Closing.** Each expanded group header shows a red **×** (`var(--danger)`) at its right end, after the tabs and before the dock's collapse chevron; it closes the group's showing panel (`closePanel(layout, id)` in `model.ts`, then `normalize` drops an emptied group or dock). The × is not drawn on collapsed strips. The Scene panel has no ×. A panel's unmount is the only cleanup: panels already tolerate unmounting when their tab is hidden.
- **Adding.** `addPanel(layout, type, target?)` creates the next free instance id and puts it in `target` (a group id) or, without one, where `activatePanel` puts an on-demand panel today (beside its `beside` neighbour, else with the Inspector, else the first group). Two entry points:
  - **Window menu.** One item per panel type, ticked when an instance is visible. Picking a type with no instance adds one; with instances, it brings the first to the front (as today). Then **Add Panel…** (the dialog, adding to the default place) and Reset Layout. This amends ADR 0063's Window menu.
  - **Header context menu.** Right-clicking a group header (tabs or empty space) opens a menu: **Add Panel…** (the dialog, adding to *this* group), **Close** (the tab under the pointer, or the showing one), and, once the detach phase is built, **Detach**.
  - **The Add Panel dialog** (`ui/AddPanelDialog.tsx`, lazy like the other dialogs, ADR 0083): a checklist of every available panel type with its title; types already open say "open (adds another)". OK adds one instance of each ticked type, the last one showing.

### Saved layouts

- **A saved layout** is `{ id, name, versions, head }`. `versions` is a tree: `{ seq, parent, savedAt, layout }`, `parent` 0 for the first. `head` is the version the layout currently means. It reuses the History panel's tree drawing (`layoutHistory` in `historyLayout.ts`), which only needs `seq` and `parent`.
- **Overwrite** ("Save Layout") adds the current arrangement as a child of `head` and moves `head` to it; nothing is deleted. **Restore** (in Manage Layouts) moves `head` to any older version and applies it; the next overwrite branches from there, as editing after undo does in the scene history (ADR 0027). Versions past 50 per layout are pruned oldest-first, never `head` or its ancestors.
- **Where layouts live.** Each layout is saved to the user, the project, or both, chosen when saving and changeable later:
  - **User:** `localStorage` key `myco.editor.layouts` (`{ format: "myco.layouts@1", layouts: [...] }`), like the other per-user preferences (`preferences.ts`). The Tauri webview keeps its `localStorage` between runs.
  - **Project:** `project.json` key `layouts` (same shape), written through `queueProjectFileWrite` (ADR 0151) so it never races the settings panels. It's the shared, committed place: a team can ship a layout with the project. Read-only projects (samples, browser projects without a folder) can't save there; the option is disabled with the reason.
  - **Both:** the same `id` in both stores. The Layouts menu lists it once with the newer `head`. Saving writes the new version to both trees.
- **The Default layout** is `defaultLayout()`, built in, always listed first, and can't be overwritten, renamed or deleted (Save Layout As… makes an own copy).
- **The working layout** stays what it is: `myco.editor.layout` in `localStorage`, saved on every change. Alongside it, `myco.editor.activeLayout` remembers which saved layout (and scope) it came from, so the menu can tick it and mark it modified ("●") when the arrangement differs from its `head` (`shape()` comparison, sizes ignored).
- **Layouts menu** (between Window and Help): Default, then the saved layouts (radio items, each with its scope: "User", "Project" or "User + Project"); then **Save Layout** (overwrite the active one; disabled for Default and for a project layout in a read-only project, with the reason), **Save Layout As…** (name and scope), **Manage Layouts…**. Picking a layout applies its `head` at once; unsaved changes to the working layout are dropped without a prompt, as in Unity.
- **Manage Layouts** (`ui/LayoutsDialog.tsx`): the list of saved layouts; for the selected one, rename, change scope (User / Project / both), delete (confirm), and its version tree (newest first, one row per version with its time, `head` marked) with **Apply** (show this version without moving `head`) and **Restore** (make it `head`).
- **Module.** `src/editor/layout/saved.ts` (pure: the version tree, merge of the two stores, prune, panel rewrite for plugin removal) and `src/editor/layout/savedStore.ts` (the signals, `localStorage` and `project.json` I/O). Unit-tested like `model.ts`.

### Plugin panels

- **Owners.** `activatePlugin` records the owning plugin of each panel it registers (`panelOwner(type)` → plugin name, in `sdk/plugins.ts`); the panel registry itself is unchanged.
- **What a layout remembers.** Every layout (working and saved) carries `panelInfo: Record<type, { title, plugin, pluginTitle }>` for the plugin panels it holds, refreshed whenever it is saved while the plugin is on. `Layout.version` becomes 2; version-1 layouts read as before with empty `panelInfo`.
- **Unavailable panels stay.** `parseLayout` no longer drops unknown panels. A panel whose type isn't registered (plugin off, plugin removed from the project, or a third-party plugin that failed to load) keeps its place, title (`panelInfo`, else its id) and × and can be moved, closed and collapsed like any other. Its body is `UnavailablePanel`: "*Sky* isn't available. It comes from the plugin *Sky* (myco.sky), which is turned off for this project. Turn it on in Project Settings > Plugins to bring this panel back." with a button that opens that category; for a plugin that isn't installed or failed to load, the text says so instead. When the plugin comes back, the panel renders again in place.
- **Confirming.** When turning plugins off in Project Settings > Plugins (`PluginsSection.tsx`, after the existing dependents confirmation, and covering those dependents), the editor looks for their panels in the working layout and in every saved layout's `head`. If any are found, a dialog lists the layouts and panels and offers:
  - **Keep as unavailable panels** (the default): nothing changes in the layouts.
  - **Remove from layouts:** the panels are closed in the working layout, and each affected saved layout gets a new version without them (so the old arrangement is one Restore away). Project layouts in a read-only project are left alone, and the dialog says so.
  - **Cancel:** the plugin stays on.

### Detached windows (second phase)

- **What.** A header context menu's **Detach** moves the panel into a new window holding its own dock layout (the same `model.ts` rules: more panels can be added, moved, split and collapsed inside it). Closing it closes its panels (they can be re-added). Closing the main window quits the app, closing its sub-windows too.
- **How.** The sub-window is a blank same-origin page opened with `window.open`. The main window renders a `DockLayout` into it with a Preact portal and copies the editor's stylesheets and theme variables into it, so the panels run in the main window's JavaScript and read the same signals: no state sync. On desktop, the main webview's `on_new_window` handler (Tauri 2) creates the child as a Tauri window with the opener's features, keeping `window.opener` and same-origin scripting; the browser does the same natively. The main window's `pagehide` closes its children.
- **Layouts include windows.** `Layout` gains `windows?: { id, bounds, layout }[]`; saved layouts save and reopen them. Browsers block pop-ups not started by a click, so at start-up a layout's windows open from a "Reopen 2 detached windows" banner rather than by themselves; picking a layout from the menu opens them directly.
- **Limits.** The Scene panel can't be detached (its WebGL context belongs to the main document). Dragging a panel between windows isn't supported; the header menu has **Move to ▸** (Main window or another window) instead. Panels that listen on the global `window` or `document` (menus closing on outside clicks, keyboard shortcuts) need to use their element's `ownerDocument`; the shell's global shortcuts are forwarded from sub-windows. This is why it's a separate phase.

## Alternatives considered

- **Per-instance state for every panel now.** Gives two independent Hierarchies or Assets folders, but every panel with module-level view state would change at once. Shared state first; per-instance state per panel when someone wants it.
- **A layout library (dockview, Golden Layout, FlexLayout).** They bring their own docking model and DOM; ours is small, tested and Preact-native (ADR 0025's one-UI-library rule). Closing, instances and saving are a few functions on top of it.
- **Saved layouts in `.myco/layouts.json`.** Keeps `project.json` lean, but `.myco/` is git-ignored except thumbnails, so a team couldn't share layouts. `project.json` is where project settings already live.
- **Overwrite in place, no history.** Simpler, but the request asks for an undo-tree, and it is what makes "Remove from layouts" safe.
- **Drop plugin panels and put them back by `beside` (today).** Loses the user's arrangement on every plugin toggle.
- **Detached windows as separate Tauri webviews with state synced over IPC.** Each window would need its own copy of the project, scene and engine state; far more work and drift-prone than rendering from the opener.

## Consequences

**Positive**
- Users can tidy the editor down to what they use, keep task-specific layouts (scripting, level design, audio) and share them through the project.
- Turning a plugin off no longer scrambles the layout, and the user is told what will happen.
- Layouts made before this record keep working unchanged (type id = first instance id; version 1 reads as 2).

**Negative / costs**
- Two instances of a panel mirror each other's view state until a panel opts into per-instance state; a second Assets panel is of little use until then.
- `project.json` grows by the project layouts' versions (about 1–2 KB each; at most 50 per layout).
- A "both" layout can diverge between users (a teammate's newer project version against a local user version); the menu shows the newer one and the dialog shows both trees.
- The detach phase touches every panel that uses the global `window`/`document`, and depends on Tauri's `on_new_window` keeping the opener link on each desktop platform; it needs checking on Windows (WebView2), macOS (WKWebView) and Linux (WebKitGTK).

## Deprecates

- ADR 0063's "panels can't be closed" and its show-only Window menu: amended as above.
- `parseLayout` dropping unregistered panels: replaced by unavailable panels.

## Open questions

- Should Layouts also be offered per scene or per play state (a play-mode layout, as Unity has)? Not in this record.
- Keyboard: a shortcut to close the focused panel (Ctrl+W is taken by browsers in the web editor).

## References

- `src/editor/layout/model.ts`, `DockLayout.tsx`, `store.ts`; `src/editor/ui/panels.tsx`; `src/editor/menuBar.ts`; `src/editor/sdk/plugins.ts`, `contributions.ts`; `src/editor/ui/PluginsSection.tsx`; `src/editor/historyLayout.ts`; `src/editor/projectFile.ts`.
- [Editor guide: docks and panels](../guide/editor.md#docks-and-panels).
- Tauri 2 `WebviewWindowBuilder::on_new_window` / `NewWindowResponse::Create` for linked child windows.

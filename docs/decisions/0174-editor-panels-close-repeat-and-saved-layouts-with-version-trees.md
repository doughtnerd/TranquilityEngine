# 0174. Editor panels share one Panel component, can be closed, added and repeated with per-instance view state; layouts are `.layout.json` files with a version tree, per user or per project

- **Status:** Accepted
- **Date:** 2026-11-13
- **Deciders:** Chris Carlson
- **Supersedes:** —
- **Related:** 0025, 0027, 0063 (amended: the Window menu), 0083, 0133, 0134, 0145

## Context

The editor's docking (`src/editor/layout/model.ts`, `DockLayout.tsx`, `store.ts`) has docks, tab groups, drag-to-move, resize, collapse and tab overflow. What it lacks:

- **Panels can't be closed.** ADR 0063 says so ("panels can't be closed, so there's nothing to toggle off"); the Window menu only brings a panel to the front.
- **One instance per panel.** A `TabGroup.panels` entry is a `PanelId`, which is both the panel's type and its identity, and `parseLayout` rejects a layout naming one twice.
- **One layout.** The arrangement lives in `localStorage` under `myco.editor.layout`. Reset Layout is the only other layout there is.
- **Plugin panels vanish.** `parseLayout` drops panels that are neither built in nor registered, so turning a plugin off (ADR 0133) silently removes its panels from the layout, and turning it on puts them back wherever `beside` says, not where the user had them. Nothing records which plugin a panel came from (`registerPanel` in `sdk/plugins.ts` doesn't keep the owner).
- **No detached windows.** Everything renders in the one editor window.
- **No shared panel frame.** Each panel component draws its own body; the header (tabs, chevron) is inline in `DockLayout.tsx`, and the undo-tree drawing is inline in `HistoryPanel.tsx`.

Some panels keep module-level state (`Hierarchy.tsx`: `collapsed`, `expanded`, `hierarchyQuery`; `Assets.tsx`: the current folder and menu). Two mounted copies of such a panel show the same state. The Scene panel owns the engine's viewport element and WebGL context (`viewportElements()` in `ScenePanel.tsx`), so there can only be one.

## Decision

### Reusable components

- **`Panel`** (`src/editor/ui/panel/Panel.tsx`): the frame every panel type renders its content in. It gives the body (an optional toolbar row, the scrolling content area, an empty-state message), and through `usePanel()` the instance it is drawn for: `{ id, type, title, close() }` and the instance's view state (below). Every built-in panel (Hierarchy, Inspector, Assets, History, Code, Worlds, Network, Project) and every plugin panel's `view` renders `<Panel>` with its own content; plugins get it from the editor SDK (`myco/editor`). The unavailable-plugin placeholder is a `Panel` too.
- **`PanelHeader`** (`src/editor/layout/PanelHeader.tsx`): one panel's tab, and nothing else: its title, the red × at its right end, pressing to show it, dragging to move it, and right-clicking for the header menu. `DockLayout.tsx` keeps the group chrome around the tabs (the tab strip, its overflow button and menu, the collapse chevron) and draws a `PanelHeader` per tab; a group holding one panel draws one `PanelHeader` as its title. The overflow menu lists hidden panels by title and doesn't use it.
- **`UndoTree`** (`src/editor/ui/undoTree/UndoTree.tsx`): the tree drawing now inside `HistoryPanel.tsx` (gutter of branches, one row per state, current and marked states, relative times, click to pick), as a component over `{ seq, parent, label, time }[]`, `current`, an optional `marked` (the History panel's "saved"), and `onPick`. The History panel and the layout version tree (Manage Layouts) both consume it; `layoutHistory` (`historyLayout.ts`) stays its pure layout.

### Panel instances

- **Instance ids are UUIDs.** A tab group lists *instance ids* (`crypto.randomUUID()`), and the layout maps each to its type: `Layout.instances: Record<uuid, { type }>`. Every instance, the first included, gets a UUID; nothing is numbered. Version-1 layouts (which list type ids) are migrated on read: each entry gets a UUID and an `instances` record. `panelTitle`, `isKnownPanel`, `panelBeside`, `isOnDemand` and `PANEL_VIEWS` take the type. A second instance shows the type's title like the first ("Hierarchy"); the tab's tooltip says "Hierarchy (2 open)".
- **Data is shared, view state is per instance.** What the editor edits and the editor-wide selection (scene, project, selected nodes and assets, which drive the Inspector) are the same for every instance. *View state* belongs to one instance: the Hierarchy's expanded and collapsed rows and its search text, the Assets panel's current folder, view mode and expanded images, scroll positions, and the like. Changing it in one instance never changes another.
- **Default view state.** A panel type declares its initial view state, and a new instance (a second copy, a re-added panel, a panel in a newly applied layout) starts from that default rather than copying another instance. The Hierarchy's default has every scene node expanded; prefab instances' inner nodes and UI documents' element rows start closed, as today, because they can hold hundreds of rows. The Assets panel's default is the project root in its saved view mode.
- **How.** `usePanelState(key, initial)` (from `Panel`) returns a signal stored under the instance id; the store drops an instance's state when the instance is closed. The module-level view signals in `Hierarchy.tsx` (`collapsed`, `expanded`, `uiExpanded`, `hierarchyQuery`, the Shift-click anchor) and `Assets.tsx` (folder, view mode, expanded images, the marquee and its context menu) move into it; other panels move theirs when they're built on `Panel`. View state lives for the session and is not written into layout files.
- **Single-instance panels.** `PanelContribution` gains `single?: boolean`. The Scene panel is single (it owns the one viewport and WebGL context, `viewportElements()`). The Add Panel dialog offers a single panel only when none is open.
- **Closing.** Each panel's tab (`PanelHeader`) shows a red **×** (`var(--danger)`) at its right end; it closes that instance (`closePanel(layout, id)` in `model.ts`; `normalize` then drops an emptied group or dock, and the instance's view state is dropped). The × is not drawn while the panel's dock is collapsed (its tab is then in the collapsed strip). The Scene panel's tab has no ×.
- **Adding.** `addPanel(layout, type, target?)` makes a new instance (UUID, default view state) and puts it in `target` (a group id) or, without one, as the tab after an open copy of the same type, else where `activatePanel` puts an on-demand panel today (beside its `beside` neighbour, else with the Inspector, else the first group). Two entry points:
  - **Window menu.** One item per panel type, ticked when an instance is visible. Picking a type with no instance adds one; with instances, it brings the first to the front (as today). Then **Add Panel…** (the dialog, adding to the default place) and Reset Layout. This amends ADR 0063's Window menu.
  - **Header context menu.** Right-clicking a tab or the empty part of a group's header opens a menu: **Add Panel…** (the dialog, adding to *this* group), **Close** (the tab under the pointer, or the showing one), and, once the detach phase is built, **Detach**.
  - **The Add Panel dialog** (`ui/AddPanelDialog.tsx`, lazy like the other dialogs, ADR 0083): a checklist of every available panel type with its title; types already open say "open (adds another)". OK adds one instance of each ticked type, the last one showing.

### Saved layouts

- **One layout per file, like an asset.** A layout is a `<slug>.layout.json` file (`{ format: "myco.layout@1", name, head, versions }`; "Custom" → `custom.layout.json`, a number added on a clash). The file name follows the name on rename.
- **Project layouts** are in `<project>/.layouts/`. Dot-folders are already skipped by the asset listing (`listAssetFiles` in `projects.ts`), so the folder never shows in the Assets panel, and game exports skip hidden folders, so layouts never ship. It is not git-ignored (a new project's `.gitignore` only ignores `.myco/`), so a team commits and shares them. Writes go through the platform's temp-file-then-rename write. Read-only projects (samples, browser projects without a folder) can't save project layouts; the option is disabled with the reason.
- **User layouts** are the same files in per-user storage, where per-user history already goes (`historyPersistence.ts`: app data under Tauri, IndexedDB in browsers): namespace `layouts`, key `<slug>.layout.json`, one entry per layout.
- **Both:** a layout can be saved to the user, the project, or both, chosen when saving and changeable later. "Both" is the same file name in both places, and every write from the editor writes the same file to both (mirrored). The copies only differ after an outside change (a teammate's version pulled in); the Layouts menu then lists the layout once with the newer `head`, and the next save writes that copy, with the new version, to both.
- **The version tree.** `versions` is `{ seq, parent, savedAt, layout }[]` (`parent` 0 for the first); `head` is the version the layout currently means. **Overwrite** ("Save Layout") adds the current arrangement as a child of `head` and moves `head` to it; nothing is deleted. **Restore** (in Manage Layouts) moves `head` to any older version and applies it; the next overwrite branches from there, as editing after undo does in the scene history (ADR 0027). Versions past 50 per file are pruned oldest-first, never `head`: old branches off head's line go before head's own older versions. A version's `layout` stores the arrangement and instance types, not view state.
- **The Default layout** is `defaultLayout()`, built in, always listed first, and can't be overwritten, renamed or deleted (Save Layout As… makes an own copy).
- **The working layout** stays what it is: `myco.editor.layout` in `localStorage`, saved on every change. Alongside it, `myco.editor.activeLayout` remembers which layout file (and scope) it came from, so the menu can tick it and mark it modified ("●") when the arrangement differs from its `head` (sizes and instance UUIDs ignored).
- **Layouts menu** (between Window and Help): Default, then the saved layouts (radio items, each with its scope: "User", "Project" or "User + Project"); then **Save Layout** (overwrite the active one; disabled for Default and for a project layout in a read-only project, with the reason), **Save Layout As…** (name and scope), **Manage Layouts…**. Picking a layout applies its `head` at once; unsaved changes to the working layout are dropped without a prompt, as in Unity.
- **Manage Layouts** (`ui/LayoutsDialog.tsx`): the list of saved layouts; for the selected one, rename, change scope (User / Project / both), delete (confirm), and its version tree drawn by `UndoTree` (newest first, one row per version with its time, `head` as the current state) with **Apply** (show this version without moving `head`) and **Restore** (make it `head`).
- **Outside changes.** Layout files are read again when a project opens and whenever the editor window regains focus, so a `git pull` shows in the menu.
- **Module.** `src/editor/layout/saved.ts` (pure: the file format, version tree, merge of the two places, prune, panel removal for plugins) and `src/editor/layout/savedStore.ts` (the signals and the file and per-user-storage I/O). Unit-tested like `model.ts`.

### Plugin panels

- **Owners.** `activatePlugin` records the owning plugin of each panel it registers (`panelOwner(type)` → plugin name, in `sdk/plugins.ts`); the panel registry itself is unchanged.
- **What a layout remembers.** Every layout (working and saved) carries `panelInfo: Record<type, { title, plugin, pluginTitle }>` for the plugin panels it holds, refreshed whenever it is saved while the plugin is on. With `instances`, this makes `Layout.version` 2; version-1 layouts are migrated on read with empty `panelInfo`.
- **Unavailable panels stay.** `parseLayout` no longer drops unknown panels. A panel whose type isn't registered (plugin off, plugin removed from the project, or a third-party plugin that failed to load) keeps its place, title (`panelInfo`, else its id) and × and can be moved, closed and collapsed like any other. Its body is `UnavailablePanel`: "*Sky* isn't available. It comes from the plugin *Sky* (myco.sky), which is turned off for this project. Turn it on in Project Settings > Plugins to bring this panel back." with a button that opens that category; for a plugin that isn't installed or failed to load, the text says so instead. When the plugin comes back, the panel renders again in place.
- **Confirming.** When turning plugins off in Project Settings > Plugins (`PluginsSection.tsx`, after the existing dependents confirmation, and covering those dependents), the editor looks for their panels in the working layout and in every saved layout's `head`. If any are found, a dialog lists the layouts and panels and offers:
  - **Keep as unavailable panels** (the default): nothing changes in the layouts.
  - **Remove from layouts:** the panels are closed in the working layout, and each affected saved layout file gets a new version without them (so the old arrangement is one Restore away). Project layouts in a read-only project are left alone, and the dialog says so.
  - **Cancel:** the plugin stays on.

### Detached windows (second phase)

- **What.** A header context menu's **Detach** moves the panel into a new window holding its own dock layout (the same `model.ts` rules: more panels can be added, moved, split and collapsed inside it). Closing it closes its panels (they can be re-added). Closing the main window quits the app, closing its sub-windows too.
- **How.** The sub-window is a blank same-origin page opened with `window.open`. The main window renders a `DockLayout` into it with a Preact portal and copies the editor's stylesheets and theme variables into it, so the panels run in the main window's JavaScript and read the same signals: no state sync. On desktop, the main webview's `on_new_window` handler (Tauri 2) creates the child as a Tauri window with the opener's features, keeping `window.opener` and same-origin scripting; the browser does the same natively. The main window's `pagehide` closes its children.
- **Layouts include windows.** `Layout` gains `windows?: { id, bounds, docks }[]` (instances stay in the one `instances` map); layout files save and reopen them. Panels in a sub-window keep their per-instance view state like any other instance. Browsers block pop-ups not started by a click, so at start-up a layout's windows open from a "Reopen 2 detached windows" banner rather than by themselves; picking a layout from the menu opens them directly.
- **Limits.** The Scene panel can't be detached (its WebGL context belongs to the main document). Dragging a panel between windows isn't supported; the header menu has **Move to ▸** (Main window or another window) instead. Panels that listen on the global `window` or `document` (menus closing on outside clicks, keyboard shortcuts) need to use their element's `ownerDocument`; the shell's global shortcuts are forwarded from sub-windows. This is why it's a separate phase.

## Alternatives considered

- **Shared view state between instances.** Least work, but two Hierarchies that expand together are pointless.
- **A new instance copies the existing one's view state.** Allowed by the request; a declared default is simpler to reason about and test (the owner's preference).
- **Numbered instance ids (`hierarchy#2`).** Readable, but renumbering on close and merging layouts make collisions easy; UUIDs never clash.
- **A layout library (dockview, Golden Layout, FlexLayout).** They bring their own docking model and DOM; ours is small, tested and Preact-native (ADR 0025's one-UI-library rule). Closing, instances and saving are a few functions on top of it.
- **All layouts in one file, or in `project.json`.** One file per layout diffs and merges better in git, lets teams add a layout without touching others, and matches how assets are stored; `project.json` would grow with every version.
- **`.myco/layouts/`.** Already hidden, but `.myco/` is git-ignored except thumbnails, so a team couldn't share layouts.
- **Overwrite in place, no history.** Simpler, but the request asks for an undo-tree, and it is what makes "Remove from layouts" safe.
- **Drop plugin panels and put them back by `beside` (today).** Loses the user's arrangement on every plugin toggle.
- **Detached windows as separate Tauri webviews with state synced over IPC.** Each window would need its own copy of the project, scene and engine state; far more work and drift-prone than rendering from the opener.

## Consequences

**Positive**
- Users can tidy the editor down to what they use, keep task-specific layouts (scripting, level design, audio) and share them through the project.
- Turning a plugin off no longer scrambles the layout, and the user is told what will happen.
- Layouts made before this record keep working (version-1 layouts are migrated on read).
- One panel frame and one undo-tree component instead of copies.

**Negative / costs**
- Every panel moves onto `Panel`, and the Hierarchy and Assets panels move their view signals into per-instance state: a broad (if mechanical) change across `src/editor/ui/`, and plugin panels need the same (the first-party plugins are moved in this work).
- Layout files grow with versions (about 1–2 KB each; at most 50 per file).
- A "both" layout can diverge after an outside change (a teammate's newer project file against a local user copy); the newer copy wins and the next save mirrors it, so the older copy's later versions are dropped.
- View state isn't kept across restarts (a reloaded Hierarchy starts from its default).
- The detach phase touches every panel that uses the global `window`/`document`, and depends on Tauri's `on_new_window` keeping the opener link on each desktop platform; it needs checking on Windows (WebView2), macOS (WKWebView) and Linux (WebKitGTK).

## Deprecates

- ADR 0063's "panels can't be closed" and its show-only Window menu: amended as above.
- `parseLayout` dropping unregistered panels: replaced by unavailable panels.

## Open questions

- Should Layouts also be offered per scene or per play state (a play-mode layout, as Unity has)? Not in this record.
- Keyboard: a shortcut to close the focused panel (Ctrl+W is taken by browsers in the web editor).
- Should view state be saved with the working layout so it survives a restart? Not in this record.

## References

- `src/editor/layout/model.ts`, `DockLayout.tsx`, `store.ts`; `src/editor/ui/panels.tsx`; `src/editor/menuBar.ts`; `src/editor/sdk/plugins.ts`, `contributions.ts`; `src/editor/ui/PluginsSection.tsx`; `src/editor/historyLayout.ts`, `ui/HistoryPanel.tsx`; `src/editor/projects.ts` (`listAssetFiles` skips dot-folders); `src/editor/historyPersistence.ts` (per-user storage).
- [Editor guide: docks and panels](../guide/editor.md#docks-and-panels).
- Tauri 2 `WebviewWindowBuilder::on_new_window` / `NewWindowResponse::Create` for linked child windows.

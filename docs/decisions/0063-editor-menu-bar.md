# 0063. The editor's commands live in a menu bar below the system title bar

- **Status:** Accepted
- **Date:** 2026-11-04
- **Deciders:** Chris Carlson
- **Supersedes:** —
- **Amends:** 0038 (the toolbar's Project menu and `addProjectMenuItem`)
- **Related:** 0022, 0025, 0026, 0030, 0038, 0041, 0059

## Context

The editor's toolbar had grown to a row of a dozen buttons: a Project ▾ menu (ADR 0038), Save, New Scene, Reload Scripts, Export…, Close, the project name, Play, Pause, Step, Undo, Redo, Reset Layout and Settings. The owner found it messy. Other features added to the Project menu through `addProjectMenuItem` (ADR 0038); Export was its only user. The editor window keeps its system title bar (window snapping and native controls matter more than the saved height).

## Decision

- **One row below the system title bar:** the logo (About), then the menus File, Edit, Create, Window and Help; Play, Pause and Step in the centre; the project's name, an unsaved-changes dot and a read-only badge on the right.
- **Menus:**
  - **File:** New Project…, Open Project…, Open Recent ▸, Save, New Scene, Reload Scripts (folder projects), Build and Export…, Project Settings, Close Project, and Exit on desktop.
  - **Edit:** Undo and Redo, labelled with what they undo; Cut, Copy, Paste, Duplicate and Delete, routed as their shortcuts are (to the Assets panel when it has focus, else the Hierarchy); Settings….
  - **Create:** the Hierarchy's Create menu, at the top level, sharing its code.
  - **Window:** a "show" item per panel, ticked when the panel is showing (panels can't be closed, so there's nothing to toggle off), and Reset Layout.
  - **Help:** Documentation, Log, About.
- **Behaviour:**
  - Items show their shortcuts. Disabled items say why.
  - The menus follow desktop conventions: click to open, hover to switch, Alt alone focuses the bar, arrow keys move, and Escape closes and returns focus.
  - The bar does nothing while a modal dialog is open, as the global shortcuts don't.
- **Menus as data:** they're defined in `src/editor/menuBar.ts` (unit-tested) and drawn by `ui/MenuBar.tsx`. Features add items by adding entries there.
- **Removed:** the toolbar buttons and ADR 0038's Project menu with `addProjectMenuItem`; ExportDialog's entry moved into File.

## Alternatives considered

- **Merge the bar into a custom title bar** (VS Code, JetBrains' new UI). Saves about 30 px, but loses Windows 11 snap layouts and native window controls; the owner chose to keep the system title bar.
- **Floating action buttons or a radial menu.** Suited to touch and canvas apps; in a desktop editor they hide commands, fight keyboard use and cover the viewport.
- **Keep the toolbar and tidy it.** Doesn't scale: each feature adds a button.

## Consequences

**Positive**
- A short, conventional row; every command is discoverable with its shortcut; new features add menu entries instead of buttons.

**Negative / costs**
- Frequent commands that were one click (Save, Undo) are now two, or their shortcut.
- The e2e specs click menus through a helper (`tests/e2e/menus.ts`) instead of buttons.

## Deprecates

ADR 0038's toolbar Project menu and `addProjectMenuItem` are removed; the rest of 0038 stands.

## Open questions

- Recent scenes in File, and a Scene menu if scene commands grow.

## References

- `src/editor/menuBar.ts`, `src/editor/ui/MenuBar.tsx`, `src/editor/ui/App.tsx`, `tests/e2e/menus.ts`, `docs/plans/2026-11-editor-ux-pass.md` (item 4).

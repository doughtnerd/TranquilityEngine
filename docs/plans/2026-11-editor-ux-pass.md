# Editor UX pass (November 2026)

Six editor changes agreed with the owner on 2026-11-04. Two need decision records: [0061](../decisions/0061-asset-previews-and-the-thumbnail-cache.md) (asset previews and the thumbnail cache) and [0062](../decisions/0062-links-to-spawnable-worlds.md) (links to Spawnable Worlds). The rest are editor-only and need none.

## The six items

1. **Borderless Projects window.** The start screen is already its own window, the Projects window (ADR 0059), so only that window changes:
   - no system title bar (`decorations: false`), sized to its panel and resized to follow the panel's height;
   - dragged by the banner (`data-tauri-drag-region`), with small minimise and close buttons in the panel's top-right corner;
   - Windows 11 gives it rounded corners and a shadow;
   - New Project… either fits inside the card or grows the window while it's open.
   - The editor window keeps its system title bar.
2. **Collapsing docks.** Whole docks collapse to their edge:
   - bottom docks to their header row, side docks to a narrow strip with vertical tab titles;
   - toggled by double-clicking the dock's border (a grip mark shows where) or a chevron in its header;
   - clicking a tab in a collapsed dock opens it; dragging the border, or dropping a panel on the dock, expands it;
   - saved with the layout; Reset Layout expands everything; no animation; the filling (Scene) dock never collapses;
   - double-clicking a header stays free for maximise later.
3. **Tab overflow.**
   - Tabs shrink very slightly, then the ones that don't fit go behind a "» N" button at the end of the header.
   - The active tab always stays visible: picking a hidden tab swaps it in.
   - Menu items can be dragged out like tabs. The collapsed side strip from item 2 uses the same button.
   - The fit is a pure, unit-tested function in `src/editor/layout/model.ts`.
4. **Menu bar.** The toolbar becomes one row below the system title bar:
   - **Menus:** File, Edit, Create (top-level, the Hierarchy's node list), Window (panel toggles, Reset Layout) and Help.
   - **Centre:** Play, Pause and Step. **Right:** project name, unsaved dot and read-only badge.
   - Undo and Redo are in Edit only. Shortcuts keep working and show in the menus. Alt opens the bar and the arrow keys move.
5. **Asset previews** (ADR 0061):
   - rendered thumbnails for models, materials and shader graphs, environments, particle effects and prefabs, but not scenes;
   - icons for other kinds; hover animation on one tile at a time;
   - a content-hashed WebP cache in `.myco/thumbnails/`, committed by default in new projects;
   - Inspector previews;
   - audio waveforms on tiles, play on hover, an Inspector player and an optional auto-play.
6. **Worlds panel** (ADR 0062):
   - templates shown as "Spawnable Worlds", with the creating code and where each is mentioned;
   - links that name Spawnable Worlds and apply when both Worlds exist;
   - an explanatory empty Links section;
   - live connections drawn in the graph during Play;
   - the Arena sample declares its links.

## Waves

Each wave's tasks touch disjoint files and run in parallel; each wave ends with a review and the full test suites (`npm test`, `npm run typecheck`, `npm run test:e2e`) before the next starts.

**Wave 1** (after 0061 and 0062 are accepted)

| Task | Item | Files | Model |
| --- | --- | --- | --- |
| A | 1 | `src-tauri/tauri.conf.json`, `src-tauri/capabilities/`, `src/editor/launcher/`, `src/editor/ui/StartScreen.tsx` (window controls slot) | Sonnet |
| B | 2 and 3 | `src/editor/layout/` (model, tests, `DockLayout.tsx`, CSS) | Opus |
| C | 6 | `src/engine/core/{bootstrap,Engine,worlds}.ts`, engine tests, `src/editor/worldsConfig.ts`, `src/editor/ui/WorldsPanel.tsx`, `samples/arena/` | Opus |
| D | 5 (engine side) | `src/engine/render/ThumbnailRenderer.ts`, `src/engine/editor/index.ts`, `src/editor/thumbnails/` (hashing, cache, queue, pruning), `src/editor/newProject.ts` (`.gitignore`), export exclusion | Opus |

**Wave 2**

| Task | Item | Files | Model |
| --- | --- | --- | --- |
| E | 4 | `src/editor/ui/App.tsx` toolbar, a new `MenuBar.tsx`, `ProjectMenu.tsx`, e2e specs that click toolbar buttons | Sonnet, with the menu model specified by Opus |
| F | 5 (editor side) | `src/editor/ui/Assets.tsx` tiles, hover animation, `AssetInspector.tsx` previews and the audio player, preferences (auto-play) | Opus |

E and F share no files. E's spec updates are mechanical (menu path or shortcut instead of a toolbar button).

**Wave 3:** fixes from the wave 2 review, docs (`implementation-status.md` rows for 0061 and 0062, the guide pages for the Worlds panel and assets), and a full e2e run on Chromium and WebKit.

## Verification

- **Unit tests:** tab fitting, dock collapse in the layout model, thumbnail keys and dependency hashing, link application on `createWorld`, bootstrap validation of links to templates.
- **e2e:**
  - collapse and expand a dock; overflowed tabs are reachable from the menu; the menu bar opens and runs Save, Undo and Reset Layout;
  - an asset folder shows rendered thumbnails, and a reopened project reads them from `.myco/thumbnails/`;
  - an audio tile plays;
  - Arena's Host connects through the declared link, and the Worlds panel draws the live connection.
- **Desktop by hand** (Tauri, not covered by Playwright): the borderless Projects window drags, minimises and closes, and New Project fits.

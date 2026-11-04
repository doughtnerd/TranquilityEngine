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

## Wave 1 results (2026-11-04)

Built: A (borderless Projects window), B (collapsing docks, tab overflow), C (ADR 0062 links and the Worlds panel), D (ADR 0061 renderer and cache, not yet wired into tiles). Verified: typecheck, 1135 unit tests, 321 e2e tests on Chromium and WebKit. The borderless window is unverified in Tauri (check by hand: size, drag, minimise, close, New Project).

Review findings, all fixed:

- **Thumbnails:**
  - stale textures could be baked into committed thumbnails (the texture cache is now keyed by URL and cleared per project, and a render whose files changed while queued isn't stored);
  - particle batches leaked GPU buffers;
  - one aborted caller cancelled a shared render;
  - pruning could delete thumbnails after a failed read (it now skips the pass);
  - object URLs leaked after a project switch.
- **Links:**
  - a server destroyed and re-created in one frame never re-linked (links are deferred until the old connection closes);
  - the start-up loop could connect a pair twice;
  - the code line used the World name instead of the template key;
  - live arrows were missing for Play's renamed Host Worlds;
  - `_linkedServer` gave wrong answers after reconnects and during an async listen.
- **Window and docks:**
  - the window controls were unreadable on the black banner (the banner's fixed colours are now named in `brand.css`);
  - a scrollbar could cover the Close button on short screens, and the status line overlapped the card;
  - the window wasn't re-centred after sizing;
  - the overflow button and collapsed strips ignored the UI scale, and the active tab could render 0 px wide;
  - two overflow menus could be open at once;
  - collapsed strips marked only one group's active tab.
- **Found in e2e:** the About dialog's Escape handler was registered after paint, so a keypress right after it opened was lost. It's now a layout effect.

## Wave 2 results (2026-11-04)

Built:
- **E, the menu bar** (ADR 0063, Accepted, amends 0038's Project menu): File, Edit, Create, Window and Help, with the play controls centred and the project status on the right. The Window items show panels (the editor can't close panels, so they don't toggle).
- **F, asset previews:**
  - thumbnails in Asset tiles, with hover animation and icons for other kinds;
  - audio waveforms with a ▶ button on tiles, an Inspector clip player and an auto-play preference;
  - larger Inspector previews for models, materials and shader graphs.
  - Not done: orbitable previews (they need new renderer API); Inspector previews for environments, prefabs and particle effects.

Verified: typecheck, 1152 unit tests, 349 e2e tests on Chromium and WebKit.

Review findings, all fixed:
- **Menu bar:**
  - Alt after an Alt+click or Alt+drag focused File (found in e2e: it broke the scene view's Alt+click list);
  - the bar worked behind modal dialogs;
  - the message log swallowed Escape before an open menu, and focus wasn't returned;
  - Edit items were enabled with nothing selected and ignored the Assets panel's focus;
  - the opener scope was all of GitHub;
  - dead Project-menu CSS, stale comments and docs.
- **Previews:**
  - thumbnails re-requested and were aborted on every document change;
  - old object URLs and images piled up as assets changed;
  - a closed project's service wasn't disposed;
  - every audio tile re-rendered four times a second during playback, a rewritten clip played the old file, and playback outlived its asset;
  - the Inspector could show the previous asset's picture.

## Wave 3 results (2026-11-04)

Built:
- **G, docs:** `docs/guide/editor.md` (the Projects window, menu bar, docks and tab overflow, asset previews, `.myco/`), the guide index, and status rows for 0061 and 0063.
- **H, live previews:**
  - live, orbitable Inspector previews (`ThumbnailRenderer.preview`: drag, wheel, double-click) for models, materials, shader graphs, environments, prefabs and particle effects, sharing the one WebGL context;
  - Inspector pages for environments and prefabs.

Verified: typecheck, 1156 unit tests, 357 e2e tests on Chromium and WebKit.

Review findings, all fixed:
- **Live previews:**
  - the preview never updated after an edit, and kept the previous project's asset (it's now re-prepared when the asset's content key changes);
  - the picture stretched above 768 px;
  - a failed preview blocked hover animations;
  - the particle Inspector made a WebGL context per selection, which could exhaust the browser's limit (it now uses the shared preview, the Particle Graph's preview frees its context, and the thumbnail renderer rebuilds after a lost context);
  - the particle preview restarted on unrelated re-renders;
  - the drawing buffer was reallocated on every switch between the preview and thumbnails;
  - preview errors went unhandled.
- **Docs** that contradicted the code.

The plan is complete. Still open: camera-view scene thumbnails (ADR 0061), and checking the borderless Projects window by hand in Tauri.

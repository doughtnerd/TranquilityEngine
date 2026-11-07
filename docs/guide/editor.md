# The editor

The scene editor is in `src/editor/` (page: `editor.html`). It runs in a browser (`npm run dev`, then `/editor.html`) and as a desktop app (`npm run tauri:dev`). This guide covers its layout and everyday UI. The designs are in [ADR 0059](../decisions/0059-projects-window-and-faster-editor-start.md) (Projects window), [0061](../decisions/0061-asset-previews-and-the-thumbnail-cache.md) (previews and the thumbnail cache) and [0063](../decisions/0063-editor-menu-bar.md) (menu bar). For the Worlds panel, see [Worlds](worlds.md).

## The Projects window

**Desktop.** The editor opens on the **Projects window**: New Project…, Open Project…, recent projects and the samples. It's a separate small window with no system title bar, and the editor loads hidden behind it. Picking a project hands it to the editor window, which shows itself while the Projects window hides.

- **Move it** by dragging the black banner at the top.
- **Minimise and close** are the two small buttons in the card's top-right corner.
- **Size.** The window follows the card's height. New Project… either fits inside the card or makes the window taller while it's open.
- **Close Project** in the editor (File menu) hides the editor and shows the Projects window again.
- **Closing windows.** Closing the editor quits the app (after the unsaved-changes prompt). Closing the Projects window quits only while the editor is hidden.
- The editor window keeps its system title bar.

**Browser.** There is no second window: the same start screen shows over the editor until a project is open. Open Project… needs File System Access (Chromium browsers); without it, the folder items are disabled and say why.

## The menu bar

One row under the title bar: the logo (click for About), the menus, **Play**, **Pause** and **Step** in the middle, and on the right the project's name, a dot while the open scene has unsaved changes, and a **Read-only** badge for projects that can't be saved.

- **File:** New Project…, Open Project…, Open Recent ▸ (the last five other projects), **Save** (Ctrl+S), New Scene, Reload Scripts (folder projects only), Build and Export…, Project Settings (shows the Project panel), Close Project, and Exit on desktop.
- **Edit:** Undo and Redo (Ctrl+Z, Ctrl+Shift+Z), named for what they undo; Cut, Copy, Paste, Duplicate and Delete (Ctrl+X, C, V, D, Del); Settings….
  - The clipboard items act on the Assets panel's files when that panel had the focus before you opened the menu, and on the Hierarchy's nodes otherwise, as the shortcuts do.
- **Create:** the Hierarchy's Create menu, at the top level (with a Child variant of each item under the selection).
- **Window:** one item per panel; picking it brings the panel to the front of its tab group, and the ticks show which panels are visible now. Panels can't be closed, so nothing here hides one. **Reset Layout** is at the bottom.
- **Help:** Documentation (opens the guide on GitHub), Log (the message log), About.

Disabled items say why in their tooltip ("nothing selected", "stop playing to edit the scene", "this project is read-only; open a project folder to save").

**Play shortcuts.** Ctrl+P plays and stops. Ctrl+Shift+P pauses and resumes; F10 or Ctrl+Alt+P steps one frame (Cmd instead of Ctrl on macOS).

**Keyboard.** Press and release **Alt** on its own to focus the first menu. Then:

- Left and Right move between menus (and switch the open one).
- Down and Up open a menu, and move through its items with Home and End; Right opens a submenu, Left closes it.
- Enter or Space opens a menu or runs an item.
- Escape closes the menu and puts the focus back where it was.
- Alt held with another key or a click (the scene view's Alt+click, for one) is just a modifier and doesn't focus the bar.
- Alt does nothing in a text field or the Code panel's editor.

**Under dialogs.** While a modal dialog is open the bar is inert: menus don't open and Alt does nothing, as with the global shortcuts.

## Docks and panels

The editor is a set of **docks** (strips along the left, right and bottom edges) around the Scene view, which fills what's left. A dock holds one or more **tab groups**; each group shows one panel and has the others as tabs.

- **Move a panel** by dragging its tab or header. A highlight shows where it will land; drop elsewhere or press Escape to leave everything as it was.
- **Resize** by dragging the handles between panels and docks.
- **Collapse a dock** by double-clicking its border (a small grip mark shows where) or clicking the chevron in its header.
  - A collapsed bottom dock shrinks to its header row. A collapsed side dock becomes a narrow strip with **vertical titles**.
  - Clicking a tab in a collapsed dock opens it. Dragging the border or dropping a panel on the dock expands it too.
  - The Scene dock never collapses. There is no animation.
- **Tab overflow.** When a header is too narrow, tabs shrink slightly and then the rest go behind a **» N** button at its end (N is how many are hidden). The open panel's tab always stays visible: picking a hidden one swaps it in. You can drag a panel out of that menu like a tab. A collapsed side strip uses the same button.
- **Reset Layout** (Window menu) puts every panel back where it started and expands every dock.
- **Layouts are saved** in the browser's or app's local storage (`myco.editor.layout`), collapsed docks included. If storage is blocked, the layout just isn't remembered.

## Asset previews

The Assets panel shows tiles (or rows, in list view). Tiles that scroll into view get a picture; tiles out of view ask for nothing.

**What gets a rendered thumbnail:**

| Asset | Picture |
| --- | --- |
| Models (`.obj`, `.fbx`, `.gltf`, `.glb`) | the model, framed from three-quarters above |
| Materials (`.material.json`), shader graphs (`.shadergraph.json`) | a sphere |
| Environments (`.hdr`, `.exr`) | a chrome sphere |
| Particle effects (`.particles.json`) | the effect about one second in |
| Prefabs (`.prefab.json`) | their meshes and sprites |
| Audio (`.mp3`, `.ogg`, `.wav`) | the clip's waveform |

Images and sprite slices show as they are. Scenes and everything else get an icon for their kind, and every tile keeps the kind as a small badge. Thumbnails are transparent 256 px stills from one offscreen renderer, a couple per frame, so a big folder fills in over a moment.

**Hover.** Hold the pointer over a particle effect, or a material or shader graph that uses Time, and its tile animates (one tile at a time). While the Inspector shows a live preview (a model, material, environment, prefab or particle effect is selected), tiles stay still: the preview has the renderer.

**Audio tiles.** A **▶** button appears on hover and plays the clip; click again to pause. Only one clip plays at a time anywhere in the editor, and it stops when you switch projects or the file goes away.

**In the Inspector.** Selecting a model, material, shader graph, environment map, prefab or particle effect shows a live preview: drag to turn it, use the wheel to zoom, double-click to reset. It updates as you edit the asset or anything it uses. (The Particle Graph panel keeps its own preview, with play, pause and speed.) Selecting an audio clip shows a player: a waveform you click to seek, Play/Pause, Stop, Loop, Volume, and the clip's length, channels and sample rate. **Auto-play on select** (off by default) plays a clip as soon as you select it; it's a per-user preference.

## Models

**Formats.** `.obj` (with its `.mtl`), `.fbx`, `.gltf` and `.glb` files are models. A `.gltf` finds its `.bin` buffers and images beside it, by the paths it names. Draco- and meshopt-compressed glTF files load too; KTX2 textures need Babylon's transcoder, which it downloads from its CDN the first time. Skins, animations, morph targets, cameras and lights in a file aren't imported yet: skinned meshes show their bind pose, and the console says once what was left out.

**Adding one to a scene.** Drag it into the scene view or the Hierarchy (or press **+**). A model of one mesh becomes one node; a model of several becomes the file's node tree, each mesh on its own node. Every part sits at the model's origin, so parts turn about the model's origin, not their own pivot.

**Import settings.** Select the model: the Inspector shows **Scale**, **Up Axis** and **Normals**, and its **Materials**, one row per material in the file. Put a material asset in a row to draw it wherever the model is used; leave it empty for the model's own. **Extract Materials** writes each of the model's materials as a material asset in a `<model> Materials` folder beside it (textures stored inside the model are written as images there) and fills in the rows; the status bar says what a material asset couldn't keep (for example a glTF occlusion map). **Apply** saves the settings beside the file as `<model>.meta.json`.

**Per renderer.** A MeshRenderer's **material** replaces every material it draws. Its **materials** list replaces one slot each: the slots are the model's materials in the order its meshes first use them (a built-in mesh has one slot).

**In game builds.** Build / Export (and `npm run export`) bakes each model into `<model>.mycomesh` beside it, which the game loads without parsing the model.

## The `.myco/` folder

The editor keeps its own files in `.myco/` at the project's root:

- **`.myco/history/`**: the edit history of each scene, so undo survives a restart. Where it goes is a setting (Edit > Settings…): the project folder (the default) or per-user storage outside the project. Read-only projects always use per-user storage.
- **`.myco/thumbnails/`**: the cache behind asset previews. Each file is named by a hash of the asset and the files its picture depends on (textures, materials, import settings…), so a changed asset is drawn again and an unchanged one is read back without rendering. Audio waveforms are cached beside them (`<key>.peaks.json`). Thumbnails nothing refers to any more are deleted a few seconds after a project opens.
- **`.myco/types/`**: the engine's `.d.ts` files for scripting, written when the project opens.

Read-only projects (and samples served beside the editor) keep thumbnails in memory for the session instead.

**What to commit.** A new project's `.gitignore` keeps thumbnails and ignores the rest of `.myco/`:

```
.myco/*
!.myco/thumbnails/
```

Committing them means a teammate, or a fresh checkout, sees previews at once instead of rendering every one. To keep thumbnails local too, ignore all of `.myco/` (delete the second line). Only new projects get this `.gitignore`; for an older project, add the lines yourself.

**Exports.** A game build leaves `.myco/` out (hidden folders are skipped), so history and thumbnails never ship.

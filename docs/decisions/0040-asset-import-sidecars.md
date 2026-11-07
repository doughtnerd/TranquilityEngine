# 0040. Per-asset import settings live in sidecar files beside each asset

- **Status:** Accepted, extended by 0115 (proposed: 9-slice fill, sprite editor undo, per-platform import settings) and 0119 (proposed: exports apply `maxSize`/`compression`)
- **Date:** 2026-11-02
- **Deciders:** Chris Carlson
- **Supersedes:** —
- **Related:** 0004, 0010, 0013, 0014, 0022, 0031

## Context

Every image was drawn the same way: linear filtering with mipmaps, clamped, centred, sized by the SpriteRenderer's or the project's pixels per unit (0014). Pixel art needs point filtering, sprite sheets need named sub-rectangles with their own pivots, and a tiling background needs to repeat. Unity keeps such settings in a `.meta` file beside each asset; Godot keeps them in `.import` files. Assets are referenced by path (0013), with no asset database or stable ids, so whatever holds the settings has to be found from the asset's path, by the editor, the dedicated server's project reader, Vite's glob in games, and future game builds alike.

The user chose sidecar files.

## Decision

**Sidecars.** An asset's import settings live in `<asset path>.meta.json` beside it: `images/player.png` → `images/player.png.meta.json`. A missing sidecar means the defaults, so existing projects need nothing. Sidecars are JSON assets like any other, served by the same asset sources (`Assets.addSource`), so a game's `import.meta.glob("./**/*.{png,mp3,json}")`, the editor's project reader and the server's `readProject` carry them without changes. The engine reads them with `Assets.importSettings(path)`.

**Format** (`src/engine/scene/importSettings.ts`), versioned like scenes:

```jsonc
{
  "format": "myco.import@1",
  // Images
  "pixelsPerUnit": 16,     // > 0 overrides the project's; a SpriteRenderer's own pixelsPerUnit wins over both
  "filter": "point",       // "linear" (default) | "point"
  "wrap": "clamp",         // "clamp" (default) | "repeat" | "mirror"
  "mipmaps": false,        // default true
  "pivot": [0.5, 0],       // the whole image's pivot (default [0.5, 0.5])
  "sprites": [             // slices: named rectangles of the image
    { "name": "walk_0", "rect": [0, 0, 16, 16], "pivot": [0.5, 0], "border": [2, 2, 2, 2] }
  ],
  // Audio
  "volume": 0.8,           // multiplies every playback's volume (default 1)
  "stream": true           // play through HTML5 audio rather than decoding up front (default false)
}
```

- `rect` is `[x, y, width, height]` in whole pixels from the image's **top-left**, as image editors and the Sprite Editor show it.
- `pivot` is 0..1 across the image or slice from its **bottom-left** (y up, like the world): `[0.5, 0]` is bottom-centre. The node's origin sits on the pivot, and flips mirror about it.
- `border` is `[left, bottom, right, top]` in pixels for 9-slice drawing. It's stored and edited but not drawn yet.
- Slice names are unique per image and can't contain `#`, `/`, `\` or quotes.
- The editor writes only the format and values that differ from the defaults, one slice per line. Unknown or invalid values are skipped with a warning (a bad sidecar never stops an asset loading); another `format` is refused with the defaults used.

**Slice references.** A slice is referenced as `asset:<image path>#<slice name>`, e.g. `"sprite": "asset:images/hero.png#walk_0"`. `#` is therefore reserved in asset paths. A SpriteRenderer with a slice reference draws that rectangle of the texture, sized `rect / pixelsPerUnit`, about the slice's pivot. A reference to a slice the sidecar doesn't have draws the whole image and warns once. Scene preloading loads the slice's image.

**Asset operations carry sidecars** (editor): renaming, moving, duplicating, copying and pasting, and deleting a file do the same to its sidecar (`EditorProject.move`, `copyFile`, `deleteFile`); a stray sidecar already at the destination name (one with no file) is replaced. The Assets panel doesn't list sidecars. Slice references are updated on renames and moves like other references (`withMovedAssets`), renaming a slice in the Sprite Editor updates references to it, and deleting an image warns about and removes references to its slices. Tools that copy a project (game export) copy `*.meta.json` files with everything else.

**Atlases: slices on a sheet, not runtime packing.** We don't add an atlas asset that packs separate images into one texture at load time. A sprite sheet with slices already gives one texture for many sprites, and the Sprite Editor slices sheets by grid (cell count or size, with offset and padding, optionally skipping empty cells) and automatically (bounding boxes of islands of opaque pixels, overlaps merged, small ones dropped). Packing at load time would add a packer, name mapping and a second way to refer to sprites, for no gain yet: sprites are one draw call each either way until sprite batching exists (0014's "no per-atlas instancing"). An atlas asset can be added later as another sidecar-described asset kind if batching makes it worthwhile.

**Editor.**
- The **Asset Inspector** (`ui/AssetInspector.tsx`) shows in the Inspector panel when one image or audio file (or a slice, showing its image) is selected in the Assets panel and no node is. A plain click on such a file clears the node selection. Edits are a draft until Apply writes the sidecar; Revert drops them.
- The **Sprite Editor** (`ui/SpriteEditor.tsx`, logic in `spriteSlicing.ts`) opens from the Asset Inspector, by double-clicking an image, or from its right-click menu. Drag on the image to draw a slice, drag a slice to move it, drag its handles to resize it; slice by grid or automatically; edit the selected slice's name, rectangle, pivot (presets or custom) and border. Apply writes the sidecar.
- An image with slices has a toggle on its tile that lists the slices after it (`<image>#<name>` entries, kind "sprite"); they drag into the viewport or hierarchy, or are added with +, as sprite nodes named after the slice.

Three.js stays inside the render backend (0010): sampling settings become texture parameters there, and a slice becomes per-sprite UVs on its own quad.

## Alternatives considered

- **Settings inside the referencing component** (filter and rect fields on SpriteRenderer). Every use of an image repeats them, and they can't describe the image itself (one filter per texture).
- **One project-wide import database** (`import.json` keyed by path). One file to merge-conflict, and every rename has to rewrite it; sidecars move with their files.
- **Stable asset ids in sidecars** (Unity's GUIDs). Would make renames free of reference rewriting, but 0013 chose paths for v1 and the editor already rewrites references. Sidecars leave room to add an id later.
- **A packed atlas asset** (`*.atlas.json` listing images). Rejected for now, see above.

## Consequences

**Positive**
- Pixel art, sprite sheets and tiling textures work without code; existing projects are unchanged.
- Every consumer of asset sources gets sidecars for free (games, editor, server, samples).

**Negative / costs**
- Twice the files in asset folders on disk (hidden in the editor), and tools outside the editor must move them together.
- `#` can't appear in asset file names used as sprites.
- A sidecar change in the editor re-samples textures, but Howls already created keep their stream setting until play mode restarts.

## Deprecates

Nothing.

## Open questions

- Drawing 9-slice borders (a SpriteRenderer draw mode).
- Per-platform overrides and compression (with a game build step, O14): answered by 0115 and 0119.
- Sprite animation clips over slices.
- Stable asset ids, which would also stop slice references breaking on slice renames made outside the editor.

## References

- `src/engine/scene/importSettings.ts`, `src/engine/render/spriteFrame.ts`, `src/editor/assetImport.ts`, `src/editor/spriteSlicing.ts`
- Unity: Sprite Editor, texture import settings and `.meta` files; Godot: `.import` files.

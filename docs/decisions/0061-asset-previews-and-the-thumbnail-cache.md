# 0061. Asset previews are rendered in the editor and cached by content in the project's `.myco/thumbnails/`

- **Status:** Accepted
- **Date:** 2026-11-04
- **Deciders:** Chris Carlson
- **Supersedes:** —
- **Related:** 0006, 0010, 0022, 0040, 0041, 0043, 0044, 0047, 0053, 0057, 0060

## Context

The Assets panel shows thumbnails for images and sprite slices only. Everything else is a text badge ("MODEL", "MATERIAL", "JSON"), so a folder of models, materials or particle effects is a column of identical tiles, and an audio file can't be heard without placing it in a scene and pressing Play.

Rendering a 3D thumbnail is cheap (one small frame), but a project has hundreds of assets. Re-rendering them on every open wastes seconds of GPU time. A browser also caps how many WebGL contexts a page may hold (about 16), so tiles can't each have their own canvas. The owner wants the cache to travel with the project between machines, so it isn't rebuilt on each one.

The project folder already has `.myco/`, which the editor owns: `.myco/history/` holds edit history (ADR 0038). New projects' `.gitignore` ignores the whole of `.myco/` (`src/editor/newProject.ts`).

## Decision

**What gets a preview.**

| Asset | Tile thumbnail | Inspector |
| --- | --- | --- |
| Image, sprite slice | As today | As today |
| Model (OBJ, FBX) | The model, studio-lit, framed to its bounds from three-quarters above | An orbitable preview |
| Material, shader graph | A lit sphere with the material (`MaterialPreview`) | An orbitable preview |
| Environment (.hdr, .exr) | A chrome sphere reflecting it | The panorama |
| Particle effect | A frame about one second in | A live preview |
| Prefab | Its meshes and sprites, framed as for models | An orbitable preview |
| Audio | Its waveform | A player (below) |
| Scene, script, JSON, folder | An icon per kind | — |

Scenes get an icon for now; a camera-view thumbnail can come later.

**One shared renderer.**
- An engine-internal `ThumbnailRenderer`, reached through `src/engine/editor` like `MaterialPreview`, keeps three.js out of the public API (ADR 0010). It owns one offscreen WebGL context.
- It renders 256 px images, about twice the largest tile, with a transparent background so tiles follow the editor theme.
- It renders only tiles in view (an `IntersectionObserver`), queued, at most two per frame, so scrolling a large folder never stutters.

**Animation on hover.** Particle effects and shader graphs that use Time animate while the pointer is over their tile.
- Only the hovered tile animates, about 30 fps, rendered by the shared renderer into that tile's canvas. Every other tile stays a still image.
- It stops when the pointer leaves, or when the tile scrolls out of view or is covered.
- Particle effects start from a fixed seed each time, so the animation repeats the same way.

**The cache: `.myco/thumbnails/`, named by content.**
- **Files:** each thumbnail is a WebP at `.myco/thumbnails/<key>.webp`, typically 10–20 KB. Audio waveforms are stored as peaks in `<key>.peaks.json` and drawn with the theme's colours.
- **The key** is the first 20 hex characters of a SHA-256 hash (WebCrypto) over:
  - a cache format version (bumped when the renderer's look changes);
  - the asset's kind;
  - the bytes of the asset and of every file its preview depends on: a material's textures and shader graph, a model's `.mtl` and textures, a prefab's models, materials and sprites, a particle effect's textures and materials.
- **Why content, not path or date:**
  - a thumbnail is valid on any machine with the same files;
  - renaming or moving an asset keeps its thumbnail;
  - a change produces a new file rather than rewriting one, so committed thumbnails never cause merge conflicts.
- **Reading:** keys are computed lazily, for tiles in view. Each file's hash is kept in memory by path, size and modification time, so a large model is hashed once per session.
- **Pruning:** after a project opens, in idle time, the editor works out the keys of every asset and deletes thumbnail files no asset uses.
- **Read-only projects** (the samples, a browser without a writable folder) keep thumbnails in memory for the session.
- **Committing:** new projects' `.gitignore` changes from ignoring `.myco/` to ignoring everything in it except thumbnails (`.myco/*` and `!.myco/thumbnails/`), so thumbnails are committed and shared by default. Existing projects keep their `.gitignore`. A project can also ignore the folder, and then each machine builds its own.
- **Builds:** game exports (ADR 0041) leave out all of `.myco/`.

**Audio preview.**
- **Tiles:** a ▶ button on hover plays the clip from the tile. Starting another clip stops the first.
- **The Inspector** gets a waveform you can click to seek, play, pause and stop, a loop toggle, volume, and the clip's length, channels and sample rate, beside its import settings (ADR 0040).
- **Auto-play on select:** an editor preference, off by default, plays a clip when you select it.
- **Implementation:** the editor decodes and plays clips with the browser's Web Audio. That's editor code; games still use Howler (ADR 0006).

## Alternatives considered

- **Cache in IndexedDB.** Keeps the project folder clean, but stays on one machine and in one browser profile, so every machine rebuilds the cache, which the owner ruled out.
- **Paths and modification times as keys** (as Unity's Library does). Dates don't survive clones and copies, so every machine would re-render everything; rewritten files also cause merge conflicts.
- **Render everything when a project opens.** Simple, but it costs seconds of GPU time on large projects for tiles that may never be seen.
- **Canvas thumbnails per tile.** Hits the browser's WebGL context limit after a dozen tiles.
- **Waveforms as images.** Would bake in the theme's colours; peaks are smaller and redraw in any theme.

## Consequences

**Positive**
- **Recognisable folders:** models, materials, effects and sounds can be told apart at a glance, and clips can be heard straight from the panel.
- **Shared cache:** a cloned project shows its thumbnails at once, and machines share the work.
- **Cheap at runtime:** nothing renders for tiles out of view, and only one tile ever animates.

**Negative / costs**
- **Project size:** about 15 KB of committed files per previewed asset, and some churn in version control as assets change, since each change adds a file and pruning deletes the old one.
- **Hashing cost:** a dependency change re-renders every asset that uses it; editing a texture shared by forty materials re-renders forty thumbnails, lazily, as their tiles come into view.
- **Existing projects:** their `.gitignore` still ignores `.myco/`, so thumbnails stay local until someone edits it. The editor won't change an existing `.gitignore` itself.

## Deprecates

Nothing. The text badges stay for kinds without a preview.

## Open questions

- Camera-view thumbnails for scenes.
- Thumbnails for scripts (first lines of code) or JSON.
- A size cap for the cache, with least-recently-used eviction, if projects grow large.

## References

- `src/editor/ui/Assets.tsx` (tiles), `src/editor/ui/AssetInspector.tsx`, `src/engine/render/MaterialPreview.ts`, `src/editor/historyStore.ts` (`.myco/history/`), `src/editor/newProject.ts` (`.gitignore`), ADR 0041 (exports).

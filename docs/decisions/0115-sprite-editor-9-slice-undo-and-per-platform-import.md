# 0115. Sprite Editor 9-slice, undo, slice search, and per-platform import overrides

- **Status:** Proposed
- **Date:** 2026-11-07
- **Deciders:** Chris Carlson
- **Supersedes:** — (extends 0040; answers two of its open questions)
- **Related:** 0040, 0014, 0010, 0022, 0083

## Context

0040 stores a slice's `border` (`[left, bottom, right, top]` pixels) and the Sprite Editor edits it as four numbers, but nothing draws it: a SpriteRenderer stretches a bordered slice like any other. The Sprite Editor has no undo, so a slip while dragging a slice or running "Slice" replaces work for good. The Assets panel's search finds files, never the slices inside a sheet. And 0040 left per-platform overrides and compression open: a web build wants smaller textures than a desktop one, and a sidecar can only say one thing.

## Decision

**9-slice drawing.** A SpriteRenderer whose slice has a non-zero border draws 9-sliced: the four corners keep their size in source pixels (`border / pixelsPerUnit` world units), the edges stretch along one axis and the centre along both, filling the sprite's size (`SpriteRenderer.size`, or the slice's size when unset). If two opposite corners are wider than the sprite they shrink together in proportion (Unity's rule). No new component field: the border in the sidecar is the switch, as 0040 intended. `spriteFrame` gains `border`, `pixelsPerUnit` and `pixelSize`; the pure `spriteMeshData` (`render/spriteFrame.ts`) turns a frame into a 4 × 4 vertex grid (positions in the unit quad, UVs), and the Babylon backend gives every sprite that grid mesh (16 vertices, 9 quads) and rewrites its positions and UVs when the geometry changes. Without a border the inner lines sit evenly and the grid draws the plain quad. The public API gains no Babylon types.

**Tiled fill (amendment).** A slice may set `fill`: `"stretch"` (default) or `"tile"`, in the sidecar beside `border` (parsed leniently: anything else is ignored with a warning; written only when `"tile"`). With `tile`, the edges and the centre repeat at their size in source pixels (`pixels / pixelsPerUnit` world units) instead of stretching, anchored at the bottom-left corner; the last tile along an axis is cropped (its UVs shortened), never squeezed. It works without a border too (the whole slice is the centre, so a plain tiled background). Tiles are independent quads (`tiledMeshData` in `spriteFrame.ts`, pure and tested; `SpriteMeshData` now carries its own `indices`), and the Babylon backend replaces the mesh's buffers when the vertex count changes. A sprite needing more than `MAX_TILE_QUADS` (1024) quads draws stretched and warns once (`tileCapped`). No SpriteRenderer override: the fill is a property of the slice, like the border. The Sprite Editor's slice panel has a Fill dropdown, undoable through the same history as other slice edits. Texture wrap isn't involved (each tile samples inside the slice rectangle), so tiling doesn't bleed with clamp wrap.

**Border editing.** The selected slice shows four guide lines in the Sprite Editor, which drag to set the border (an unset guide has a short grip near one end so the slice edge still moves the slice). The numeric fields stay. Both go through `setBorderSide`, which keeps whole numbers and stops opposite sides crossing; resizing a slice re-fits its border (`fitBorder`).

**Undo and redo** in the Sprite Editor: Ctrl+Z, Ctrl+Shift+Z (and Ctrl+Y) outside text fields, plus buttons in its header. `editor/spriteHistory.ts` is a pure immutable history (`pushHistory`, `undo`, `redo`) over the whole slice list; pushes with the same gesture key (one drag, one stretch of typing) merge into one step, equal snapshots add none, and 100 steps are kept. Revert is itself an undoable step. Apply clears the history, because renames were applied to references and earlier snapshots' "original" names would replay them wrongly. Slice edits only: the Asset Inspector's draft already has Revert.

**Slice search.** Searching the Assets panel also lists matching slices (`images/a.png#walk_0` entries, every word matched against the slice name, `searchEntries` in `assetBrowser.ts`) beside matching files, so a sprite in a sheet can be found and dragged without expanding the sheet.

**Per-platform import overrides and compression** (images). New sidecar keys, parsed leniently and written only when not default:

```jsonc
{
  "format": "myco.import@1",
  "maxSize": 1024,            // largest side in px; 0/absent = no limit
  "compression": "normal",    // "none" (default) | "low" | "normal" | "high" quality
  "platforms": {              // each may override filter, wrap, mipmaps, maxSize, compression
    "web":     { "maxSize": 512, "compression": "low" },
    "desktop": { "mipmaps": false }
  }
}
```

- Platforms are `web` and `desktop`. `Assets.platform` is `desktop` under Tauri and `web` otherwise, and can be set (null detects again); game exports pick it up from the runtime, so a desktop export is `desktop` without a build step.
- `Assets.importSettings(path)` returns the settings **resolved** for `Assets.platform` (`resolveImportSettings`: overrides over the base, `platforms` emptied; resolutions are cached per parsed sidecar and platform). The editor's `readImportSettings` stays unresolved, since it edits the file.
- Parsing: unknown platforms, non-overridable keys and bad values are skipped with a warning naming the path; writing drops overrides equal to the base value and empty platforms.
- Asset Inspector: Max Size and Compression rows plus a collapsible Platform Overrides section, one box per platform with "Same" (inherit) or a value for each of the five keys.
- **What applies.** `filter`, `wrap` and `mipmaps` apply for real, per platform, when the texture loads. **`maxSize` and `compression` are recorded but advisory** for now: Babylon decodes the image the browser hands it and can't GPU-compress it at load (that needs a pre-built KTX2/Basis file), and a runtime downscale would change `getBaseSize()` and with it sprite sizes and slice rectangles, which 0040 defines in source pixels. `clampTextureSize` (the pure clamp) is in place for the game-build step (open question O14), where the export can downscale or transcode with the resolved values and rewrite slice rectangles consistently.

## Alternatives considered

- **A `SpriteRenderer.drawMode` field (simple/sliced)** — a second switch for what the border already says; every use of a slice would repeat it. Kept the border as the switch.
- **A separate 9-slice material or shader** — corner math in a shader needs per-sprite uniforms and breaks the shared-material path; a 16-vertex mesh is cheap and keeps one draw call.
- **Undo through the editor's global history** — the Sprite Editor edits a draft that only Apply writes, so its edits aren't scene or file changes; a local history is simpler and separate.
- **Downscaling at load for `maxSize`** — see above; would silently change sprite sizes and slice maths.
- **Per-platform sidecar files (`a.png.web.meta.json`)** — doubles the files again and makes moves and renames carry more names; one sidecar with a `platforms` object is enough.

## Consequences

**Positive**
- Panels, buttons and borders scale without distortion; the Sprite Editor can be experimented in safely; sheets' slices are searchable; the sidecar format has a place for build-time texture decisions.

**Negative / costs**
- Every sprite mesh has 16 vertices instead of 4.
- `maxSize` and `compression` do nothing visible until a game build step uses them, which the Inspector's tooltips say.
- Slices of a flipped or very small 9-sliced sprite are as Unity's: corners shrink rather than overlap.

## Deprecates

Nothing. 0040's "stored but not drawn yet" note on `border` and its first open question are answered here.

## Export-time compression investigation

Checked 2026-11-07 whether the exporter can honour `compression` and `maxSize` by encoding to KTX2. Result: **an encoder exists and works, but the load side doesn't, so both settings stay advisory.**

- **Encoder.** `ktx2-encoder` 0.6.0 (MIT, wraps BinomialLLC `basis_universal`, depends on `ktx-parse`, about 3.5 MB unpacked, maintained: last release July 2026) runs offline in Node and browsers on a bundled `basis_encoder.wasm`. Tried in Node: a 16 x 16 PNG encoded to a valid KTX2 (ETC1S, mipmaps, 600 bytes, about 300 ms) once given an `imageDecoder` (we'd add a PNG decoder such as `pngjs` or `sharp`, since the encoder takes raw RGBA). `basis_universal` (MIT, 1.16.x) is the raw encoder. Licences are compatible. **Verified:** encode in Node, KTX2 magic bytes. **Not verified:** decoding the file back (no Babylon transcode ran, no pixel compare).
- **Loader.** Nothing in `src/` loads KTX2 today. Babylon's `KhronosTextureContainer2` fetches its decoder and transcoder WASM from `cdn.babylonjs.com` by default, so a game would need network access, and the `@babylonjs/core` package ships only the older Basis transcoder in `assets/Basis/`, not the KTX2 decoder modules. The player would have to bundle and point `URLConfig` at them, and add the Babylon KTX2 loader plugin import (module by module, ADR 0010).
- **Path resolution.** Every texture is created by URL from `Assets` in several places (sprites, UI, particles, materials, previews); each would need `x.png` mapped to `x.ktx2`, or the manifest would have to remap it. The engine also decodes PNGs itself for slice and size work.
- **Quality and sizes.** ETC1S/UASTC artifacts hurt point-filtered pixel art, the engine's main sprite use, and `getBaseSize()` of a KTX2 pads to block sizes only for the GPU format, while 0040 defines slice rectangles in source pixels. A `maxSize` downscale changes that size, so it would need `pixelsPerUnit` and every slice rect rewritten at export (and sprite world size kept by scaling `pixelsPerUnit`), which is doable in the exporter but pointless without the loader.
- **Decision.** Keep `maxSize` and `compression` advisory. A future record (new dependency, so it needs its own) should: add `ktx2-encoder` plus a PNG decoder to the exporter; apply `maxSize` by downscaling and scaling `pixelsPerUnit` and slice rects by the same factor, so world size is unchanged; encode with `compression` (the quality-to-ETC1S/UASTC mapping is that record's to define); bundle the KTX2 transcoder into the player; and resolve `x.png` to `x.ktx2` in `Assets`, with point-filtered sprites left as PNG or UASTC. Until the loader exists no export step is added, so nothing silently diverges between editor and build.

## Open questions

- Tile anchoring (centred, or from the top-left) and a per-SpriteRenderer fill override.
- Applying `maxSize` and `compression` in the game export: investigated, deferred (see "Export-time compression investigation"); revisit when the conditions listed there hold.
- More platforms (mobile, console) and a way to preview another platform's settings in the editor.

## References

- `src/engine/render/spriteFrame.ts`, `src/engine/scene/importSettings.ts`, `src/engine/scene/Assets.ts`, `src/editor/ui/SpriteEditor.tsx`, `src/editor/spriteHistory.ts`, `src/editor/spriteSlicing.ts`, `src/editor/assetBrowser.ts`
- Tests: `tests/spriteNineSlice.test.ts`, `tests/importPlatforms.test.ts`, `spriteHistory.test.ts`, `spriteSlicing.test.ts`, `assetBrowser.test.ts`
- Unity: Sprite Editor borders, Sliced draw mode, per-platform texture overrides.

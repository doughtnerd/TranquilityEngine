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

## Open questions

- Tiled (repeating) edges and centre instead of stretched; per-slice fill mode.
- Applying `maxSize` and `compression` in the game export (downscaling with slice rectangles rewritten, KTX2/Basis transcoding), with 0040's O14.
- More platforms (mobile, console) and a way to preview another platform's settings in the editor.

## References

- `src/engine/render/spriteFrame.ts`, `src/engine/scene/importSettings.ts`, `src/engine/scene/Assets.ts`, `src/editor/ui/SpriteEditor.tsx`, `src/editor/spriteHistory.ts`, `src/editor/spriteSlicing.ts`, `src/editor/assetBrowser.ts`
- Tests: `tests/spriteNineSlice.test.ts`, `tests/importPlatforms.test.ts`, `spriteHistory.test.ts`, `spriteSlicing.test.ts`, `assetBrowser.test.ts`
- Unity: Sprite Editor borders, Sliced draw mode, per-platform texture overrides.

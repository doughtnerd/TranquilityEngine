# 0119. Game exports resize and re-encode images per their sidecars; tiles get an anchor

- **Status:** Proposed (built; verification notes in docs/architecture/implementation-status.md)
- **Date:** 2026-11-07
- **Deciders:** Chris Carlson
- **Supersedes:** — (answers open questions of 0040 and 0115)
- **Related:** 0040, 0115, 0041, 0090, 0103, 0014

## Context

0115 added `maxSize`, `compression` and per-platform overrides to image sidecars but left the last two advisory: nothing in a game export used them, and an investigation found KTX2/Basis needs a bundled transcoder, a new texture loader and an `x.png` → `x.ktx2` resolver, and degrades point-filtered pixel art. 0115 also left tile anchoring open. Today a tilemap tile larger than a cell always overhangs up and to the right of it (0103), so a tall tree or a wide platform can only be placed by padding its sprite.

## Decision

**Exports process images.** Both exporters (`npm run export` and the editor's Export…) pass the images a project ships through `processImages` (`src/export/images.ts`) after planning, as models are baked (0090). For each PNG, JPEG or WebP with a sidecar whose settings **resolved for the export's platform** (`web` target → `web`, `desktop` target → `desktop`; `resolveImportSettings`) have `maxSize > 0` and the image is larger, or `compression` other than `none`, the build gets a processed file at the same project path instead of the copy.

- **`maxSize`** downsizes so the longest side fits (`clampTextureSize`, aspect kept).
- **`compression`** (answer to the open question: WebP, no KTX2): `none` keeps the file's format; `low`, `normal` and `high` re-encode as **lossy WebP at quality 90, 75, 50**. A point-filtered image (pixel art) is encoded **lossless** WebP at those levels instead, since lossy artifacts ruin it, so for it compression only changes encode effort. WebP is decoded natively by browsers and the Tauri webviews, so no loader, transcoder or path remapping is needed: the player's textures work as before.
- **The path and extension stay** (`hero.png` holds WebP bytes), so references, sidecars, slice references and tilesets are untouched. Browsers detect an image's format from its content, not its file name or MIME type; the exporter's own `serve.mjs` already sends `image/png`. (Hosts that send `X-Content-Type-Options: nosniff` with a wrong type would block it; none of the targets here do. Noted as a cost below.)
- **World size does not change.** Authored pixel sizes live in the sidecar (slice rects, borders, `pixelsPerUnit`, tile size), and a SpriteRenderer or the project can set its own `pixelsPerUnit`, so rewriting values can't cover every case. Instead the build's sidecar gains `sourceSize: [width, height]`, the image's authored size, written only for images that were resized. `authoredSize(settings, textureSize)` (importSettings.ts) gives sprite frames, tilemaps and particles the authored size to measure with; UVs are fractions, so they sample the smaller texture identically. The editor never writes `sourceSize` and ignores it for its own work.
- Images the settings don't touch, other formats (GIF, SVG, KTX…) and images that can't be decoded are copied as they are, with a log line for the last.
- **Codec.** The Node exporter uses `sharp` (Apache-2.0, prebuilt libvips binaries, decodes PNG/JPEG/WebP, encodes WebP/PNG/JPEG) as a dev dependency. The editor's export uses the browser's own codec (`createImageBitmap` and `OffscreenCanvas.convertToBlob`, which encodes WebP in Chromium and Tauri's WebView2; where the browser can't encode WebP it falls back to copying the image and logs it). Both sit behind one `ImageTranscoder` function type, so the planner is pure and tested with a fake.

**Tile anchors.** A tile may set `anchor: [x, y]` (0..1 from the sprite's bottom-left, y up), and the tileset may set a default `anchor` for its tiles. The rule: the anchor point of the sprite is placed at the same fractional point of its cell. `[0, 0]` (default) is today's behaviour, bottom-left corners together, overhang up and right; `[0.5, 0]` centres a tall tile on its cell and lets it grow upward; `[0.5, 0.5]` centres it; `[1, 1]` aligns top-right corners so it overhangs down and left. The offset is `anchor × (1 − size in cells)` per axis; a tile that is exactly one cell is unaffected. It applies under flips and turns (computed from the flipped size). `TileFrame` carries `anchor`; `buildChunkMeshes` applies it. The tileset inspector gets an Anchor field. Colliders are in cell units and don't move with the anchor.

**Per-SpriteRenderer fill override:** not built; the fill stays a property of the slice (0115).

## Alternatives considered

- **KTX2/Basis (the 0115 investigation).** Real GPU savings, but needs a bundled transcoder, a loader plugin and a path resolver, and it degrades pixel art. WebP keeps download size and needs nothing at load; GPU memory is unchanged, which is the cost.
- **Lossless PNG optimisation only.** No new format, but compression levels would barely differ.
- **Rename to `.webp` and remap paths.** Honest file names, but every path consumer (sidecars, slice refs, tilesets, Assets) would need a remap table.
- **Rewrite `pixelsPerUnit` and slice rects when resizing.** Breaks when a SpriteRenderer or the project supplies the units.
- **A Sprite Renderer-level or tilemap-wide anchor.** The tile's size is what makes the anchor matter, so it belongs to the tile (with a tileset default).

## Consequences

**Positive**
- `maxSize`, `compression` and per-platform overrides now change what ships; download size drops; scripts, scenes and sidecars are unchanged.
- Tall and wide tiles can sit where the level designer wants without padded sprites.

**Negative / costs**
- WebP bytes under a `.png` name confuse tools that trust the extension (image viewers on the build folder); decoding is by content in every browser engine we target.
- GPU memory is the decoded size, not the file size. Only `maxSize` reduces it.
- Lossy WebP loses quality at `normal` and `high`; the Inspector's wording says so.
- A `sharp` dev dependency (native binaries) for the CLI exporter.

## Deprecates

Nothing. 0115's "advisory" note on `maxSize` and `compression` is retired; its KTX2 investigation stays as the record of why not.

## Open questions

- KTX2 for GPU memory savings (needs the loader work in 0115's investigation).
- More platforms and previewing another platform's settings in the editor.
- Per-SpriteRenderer fill override.

## References

- `src/export/images.ts`, `src/export/node.ts`, `src/editor/exportBuild.ts`, `src/engine/scene/importSettings.ts`, `src/engine/tilemap/mesh.ts`, `src/engine/tilemap/tileset.ts`
- Unity: texture importer max size and compression per platform; Tilemap tile anchor.

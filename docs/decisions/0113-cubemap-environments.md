# 0113. Environments take prefiltered `.env`/`.dds` cubes and six-image `*.cubemap.json` assets

- **Status:** Proposed
- **Date:** 2026-11-07
- **Deciders:** Chris Carlson
- **Supersedes:** —
- **Related:** 0053, 0061, 0075, 0112

## Context

`Environment.map` (0053) reads equirectangular `.hdr`, `.exr`, `.png` and `.jpg`. Many skyboxes come as six
square images, and IBL tools (Babylon's sandbox, cmftStudio, IBLBaker) export prefiltered cubes as `.env` or
`.dds`, which load without the prefiltering pause an HDR has. 0053 left "cubemap skies" open.

## Decision

- **Prefiltered cubes:** `.env` (Babylon's format) and `.dds` load with Babylon's `CubeTexture` (its loaders are
  imported on demand when such a file is first used) and are used as they are, already prefiltered.
- **Six images:** a `*.cubemap.json` asset (`myco.cubemap@1`, `src/engine/sky/cubemapFormat.ts`) names one
  image per face, `px nx py ny pz nz` (OpenGL naming; with -Z north, `nz` is north). They load as a `CubeTexture`
  and are prefiltered with `HDRFiltering` (1024 samples) once loaded; until prefiltering finishes the texture
  doesn't count as ready (`cubemapReady`), so no material binds the texture that prefiltering replaces.
- `environmentKind` (`lighting.ts`) gains `cube`, `faces` and `sky` (0112); `loadCubemap` lives in
  `render/babylon/sky/cubemaps.ts`. The skybox, intensity, blur and rotation fields work as for equirectangular maps.
- **Editor:** both are "Environment" assets with thumbnails (0061) and the Environment map picker offers them.

## Alternatives considered

- **KTX2 cubes** — Babylon's KTX2 loader fetches its transcoder from Babylon's CDN unless it's configured with
  self-hosted files, which a desktop game can't rely on; left until the engine ships the transcoder.
- **A naming convention instead of a JSON file** (`sky_px.png` …) — implicit, breaks on renames, and an asset
  file gives the Assets panel one thing to show and pick.

## Consequences

**Positive**
- Skyboxes from asset stores and prefiltered IBL files work directly; `.env` loads faster than an HDR.

**Negative / costs**
- Face orientation conventions differ between tools; some sets need faces swapped or rotated by hand.
- Six-image sets are LDR, so lighting from them is flatter than from an HDR.

## Deprecates

Nothing.

## Open questions

- KTX2 support with a bundled transcoder; a cubemap editor that previews and rotates faces.

## References

- Babylon `CubeTexture`, `CubeTexture.CreateFromPrefilteredData`, `HDRFiltering`.

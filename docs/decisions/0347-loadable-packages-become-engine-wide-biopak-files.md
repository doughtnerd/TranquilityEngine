# 0347. Loadable packages become engine-wide BioPak files

- **Status:** Proposed
- **Date:** 2026-11-22
- **Deciders:** Chris Carlson
- **Supersedes:** —
- **Amends:** audio 0337 (its `.mycopak` audio packages become BioPaks; audio semantics kept)
- **Related:** 0090, 0119, 0340, 0341

## Context

Audio 0337 (audio branch, merging before this build) ships audio in loadable packages, built as `audio/packages/<name>.mycopak` (`MYCOPAK1`, a JSON TOC `myco.audiopack@1`, 16-byte-aligned entries) and authored in `audio.json` `packages`, with a public API `Audio.package(name).load()/unload()`, preload packages, strict loading and budgets as tripwires. It covers audio only.

Animation adds large binary assets (compiled clips, skeletons, pose databases, 0341) that games want to load per level, as do baked models (0090) and textures (0119). The owner decided (2026-11-22) that packages become engine-wide and are called **BioPak**. The audio plugin will be renamed **Biosonic** after the audio work is done.

## Decision

We will generalise audio 0337's packages into **BioPaks**, one engine feature for every asset kind.

- **Format** (`src/engine/packages/format.ts`, the pure reader and writer moved from `audio/packaging/format.ts`):
  - `<name>.biopak` with the magic `BIOPAK01`, `u32 tocBytes`, a TOC in UTF-8 JSON with `format: "myco.biopak@1"`, then entries 16-byte aligned;
  - each TOC entry has `{ path, offset, bytes, kind, hash }` plus a `meta` object owned by the asset kind. Audio's entry fields (`codec`, `rate`, `channels`, `frames`, `load`, `prefetch`) move under `meta` unchanged.
- **Authoring:** `packages.json` at the project root, with the same shape as audio 0337's list (`name`, `preload`, `include` globs, platforms). It is edited in the Project settings, and the Studio's Packages screen edits it too. Audio's own encoding profiles and rules stay in `audio.json`.
- **Asset kinds load their entries.** An asset kind (0143, 0314) can register a package loader `(entry, bytes) → loaded | failed` and an unloader:
  - audio keeps audio 0337's runtime behaviour (decoder worker, arena, prefetch heads, loose streams);
  - animation loads compiled clips, skeletons and pose databases into the core's arena (0340);
  - baked models and textures load into the model and texture caches.
  
  Kinds without a loader are served from the package bytes by `Assets`.
- **Runtime API (public):**
  - `Packages.get(name)` returns a `BioPak` with `state`, `load()`, `unload()` and `progress`;
  - `Audio.package(name)` stays as an alias that returns the same object.
  
  Reference counting, preload and the `strict` rule apply per entry across kinds, as audio 0337 defined for audio.
- **Exports:** the exporter writes `packages/<name>.biopak` per platform and lists them in `game.json` `packages`. Each kind's conversion (audio encoding, clip compression, image re-encoding) runs before packing. Budgets stay tripwires.
- **Migration:** audio's `packages` in `audio.json` move to `packages.json` once, on opening, with one confirmation. `.mycopak` outputs are rebuilt on the next export; no old builds need reading.
- **Naming:** BioPak is used in the UI, docs and file extension. The audio plugin's rename to Biosonic is a separate, later change.

## Alternatives considered

- **Keep packages audio-only and add a second package type for animation.** Two loaders, two authoring screens, duplicated budgets.
- **Rely on the browser cache and loose files only.** No level-sized loading, no preload guarantees, no strict mode.

## Consequences

**Positive**
- One package system for every heavy asset, with audio 0337's proven rules.
- Level loading can bring sounds, clips, pose databases and models in together.

**Negative / costs**
- It touches audio 0337's freshly built code (moving the format and the authoring file) just after it merges.
- Asset kinds gain a loader contract to implement and test.

## Deprecates

`.mycopak` and `myco.audiopack@1`, replaced by `.biopak` and `myco.biopak@1`; `audio.json` `packages`, moved to `packages.json`.

## Open questions

None.

## References

Audio 0337 §7 (packages), `src/engine/audio/packaging/format.ts` (audio branch), `src/export/`.

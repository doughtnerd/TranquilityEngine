# 0050. Graphics quality tiers in project.json, chosen by the player through `Graphics.quality`

- **Status:** Proposed
- **Date:** 2026-11-03
- **Deciders:** Chris Carlson
- **Supersedes:** —
- **Related:** 0004, 0010, 0024, 0032, 0043, 0047, 0048

## Context

The owner wants games to offer graphics levels (a Low…Ultra menu) and to reach high-fidelity visuals on capable machines. Most of what separates low from high quality is renderer state rather than material shaders: resolution, anti-aliasing, shadow map size, texture filtering, and (later) post-processing, cascaded shadows and environment lighting. three.js already recompiles its own materials when such state changes. Shader graphs (0047, 0048) need one hook so a graph can be cheaper on low tiers. Unity's Quality Settings are the reference: named levels defined per project, one active, switchable at run time.

## Decision

### Tiers in `project.json`

A `graphics` section lists tiers from lowest to highest and names the default:

```jsonc
"graphics": {
  "defaultTier": "High",
  "tiers": [
    { "name": "Low", "renderScale": 0.75, "antialias": "off", "shadows": "low", "anisotropy": 1, "shaderLevel": "low" },
    { "name": "High", "renderScale": 1, "antialias": "msaa", "shadows": "high", "anisotropy": 8, "shaderLevel": "high" }
  ]
}
```

- `renderScale` (0.25–2): rendering resolution as a share of the screen's, after capping the device pixel ratio at 2.
- `antialias`: `off` or `msaa`.
- `shadows`: `off`, or shadow map size `low` 512, `medium` 1024, `high` 2048, `ultra` 4096.
- `anisotropy` (1–16): texture filtering, capped at the GPU's limit.
- `shaderLevel`: `low`, `medium` or `high`, the branch shader graphs' Quality Branch nodes keep (a later step of this work).

Without a `graphics` section a project gets Low, Medium, High and Ultra, defaulting to High. The section is read leniently like other assets: bad values are reported and replaced. Later records add tier fields (post-processing effects, cascaded shadows); unknown fields are reported, so a typo isn't silently ignored.

### `Graphics` at run time

`Graphics` is a static API, process-wide like `Storage` (0024, 0032): the tier belongs to the player, not to a World, so every render backend applies the same one.

```ts
Graphics.tiers;           // ["Low", "Medium", "High", "Ultra"]
Graphics.quality;         // "High"
Graphics.quality = "Low"; // applies now and saves the choice (Storage, namespace "settings")
Graphics.tier;            // the active tier's settings
Graphics.defaultQuality;  // the project's default
```

At start the Engine activates the player's saved choice if it still names a tier, else the project's default. Render backends compare a version number each frame and re-apply the tier when it changes: pixel ratio, shadows on or off and their map size (materials recompile when shadows switch on or off), and texture anisotropy. MSAA on the canvas is fixed when the WebGL context is created, so until post-processing renders through multisampled targets (the next record), a change of `antialias` takes effect at the next start.

### Editor

The Project panel edits the tiers (add, rename, reorder, remove, each field, the default) and saves them to `project.json`; the running editor picks up the change. The scene view has a Quality menu that previews any tier in the editor without saving a player choice.

## Alternatives considered

- **A single quality number (0–5) with fixed meanings.** Simpler, but projects can't name or tune their levels.
- **Per-World tiers.** Worlds in one process share one GPU and one player; per-World quality has no use.
- **Recreating the WebGL context to switch MSAA live.** Loses every GPU resource; rendering through multisampled targets (next record) makes it unnecessary.
- **Shader keywords for quality.** A general keyword system multiplies variants; a fixed three-level `shaderLevel` gives graphs a quality hook with at most three variants each.

## Consequences

**Positive**
- Games get a graphics menu with one line of code; projects tune what each level means.
- Later fidelity features (post-processing, cascaded shadows, environments) hang off the same tiers.

**Negative / costs**
- Switching shadows on or off recompiles materials (a hitch when the player changes the setting).
- Canvas MSAA changes need a restart until the post-processing pipeline lands.

## Deprecates

Nothing. The render backend's fixed 2048 shadow maps and device-pixel-ratio cap become tier values.

## Open questions

- Automatic tier detection from the GPU and frame rate.
- Per-platform default tiers (desktop vs web) in game builds.

## References

- Unity Quality Settings, `QualitySettings.SetQualityLevel`.
- three.js `WebGLRenderer.setPixelRatio`, `LightShadow.mapSize`, `Texture.anisotropy`.

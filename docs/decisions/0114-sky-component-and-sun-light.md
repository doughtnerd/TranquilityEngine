# 0114. A `Sky` component scripts the procedural sky, and the sky can drive the main directional light

- **Status:** Proposed
- **Date:** 2026-11-07
- **Deciders:** Chris Carlson
- **Supersedes:** —
- **Related:** 0010, 0017, 0019, 0043, 0053, 0112

## Context

A sky asset (0112) describes a sky as saved. Games change it while running (a day cycle, a storm rolling in) and
want the sun light to match the drawn sun without keeping a Light's rotation in step by hand.

## Decision

**`Sky` component** (`engine.Sky`, `src/engine/sky/Sky.ts`, public). The first active one in a World controls the
sky its Environment uses; a World without one draws the asset as saved.

- Fields: `timeOfDay` (hours; -1 follows the asset's, the default) and `daySpeed` (game hours per second of game
  time, 0 = stopped). The clock is computed from the World's scaled time, not advanced by a system: setting
  `timeOfDay` jumps there and the cycle runs on from it; changing `daySpeed` carries on from where the sky is.
- `currentTime` (read-only): the time of day now.
- `settings`: a live copy of the asset's `SkySettings` (plain data, 0112) that scripts change freely
  (`sky.settings.clouds[0].coverage = 0.9`); the renderer reads it every frame and rebakes as 0112 says.
  `resetSettings()` goes back to the asset.
- `sunDirection`, `moonDirection` (engine `Vector3`s) and `light` (`{ body, direction, color, intensity }`), so
  gameplay can react to day and night without the renderer.
- `rebake()` forces a lighting bake on the next frame.

**Sun-driven light.** With `lighting.driveSunLight` on (the default), the World's main directional light, the
first enabled shadow-casting directional `Light` (else the first directional one; the default sun when the World
has no Lights), takes the sky's light each frame: direction, colour (sunlight through the atmosphere, normalized),
and intensity (`sunIntensity` × transmittance, faded at the horizon and dimmed by cloud cover). At night the moon
takes over when it's brighter (`moonIntensity` × its lit fraction). This happens in the renderer
(`BabylonLighting.setSunOverride`), so the editor's scene view and play mode look the same and the Light
component's own data is untouched; shadows and shader graphs' Main Light nodes follow the driven direction.

## Alternatives considered

- **Fields on `Environment`** — Environment is 0053's and image maps have no time; a separate component keeps the
  scripting surface for skies only and leaves `Environment` unchanged.
- **Rotating the Light node in the ECS** — the light's transform would change in the editor's World and disagree
  with the document, and a script reading the Light would see values it didn't set; the override is render-side.
- **A built-in system advancing `timeOfDay`** — mutates serialized data every frame (dirtying saves and
  replication); a clock derived from World time is deterministic and free.

## Consequences

**Positive**
- `sky.timeOfDay = 18.5` and a day cycle in one field; lighting follows without extra code.

**Negative / costs**
- A driven Light's gizmo in the scene view still shows its authored rotation.
- The moon/sun hand-over is a switch in direction at very low intensity (around −2° to −8° sun elevation).
- Headless Worlds (servers) compute `sunDirection` etc. but nothing drives a light there.

## Deprecates

Nothing.

## Open questions

- Replicating `timeOfDay` / `daySpeed` in multiplayer (games can replicate the fields themselves today).
- Showing the driven direction on the Light's gizmo.

## References

- `src/engine/render/babylon/lighting.ts` (`setSunOverride`, `sunLight`), `src/engine/sky/skyMath.ts` (`skyLight`).

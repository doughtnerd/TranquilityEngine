# 0435. Camera shake is a plugin of impulse sources and camera listeners on the ECS, offsetting only the rendered view

- **Status:** Accepted
- **Date:** 2026-11-27
- **Deciders:** Chris Carlson
- **Supersedes:** —
- **Related:** 0007, 0011, 0017, 0056, 0073, 0108, 0133, 0140, 0164, 0371, 0372

## Context

Games shake the camera for hits, explosions, landings, recoil and engines rumbling. Today a game has to write it
itself: move the camera's `Transform` from a script, which fights any script that also places the camera (a follow
script overwrites it, or the two drift apart), shakes the audio listener and camera rays with it, and has no way to
fire from a clip, a timeline or a collision without more code.

What the engines do:

- **Unity (Cinemachine Impulse):** an *Impulse Source* on any object emits impulses (a signal shape × a velocity, with
  a duration, a radius, distance dissipation and a propagation speed) on channels; an *Impulse Listener* on the camera
  sums the impulses that reach it, scaled by a gain. Sources fire from script (`GenerateImpulse`), from collisions
  (*Collision Impulse Source*) or from a Timeline track. Shapes come as presets: **Recoil, Bump, Explosion, Rumble**.
  Separately, *Basic Multi-Channel Perlin* adds continuous noise from a noise profile (handheld, 6D shake) with
  amplitude and frequency gains, which a Timeline can animate.
- **Unreal:** Camera Shake assets (wave oscillator, Perlin noise, sequence) played on a player camera manager or by a
  world-placed shake source with inner and outer radius.
- **Godot:** nothing built in; the usual answer is a script offsetting `Camera2D.offset`, a render-only offset that
  leaves the node where it is.

Myco's constraints: behaviour, data and systems are built on the ECS stack (0007, 0017; owner, 2026-11-22: `@component`
classes, `defineComponent`, `defineBuffer`, systems registered by the plugin's runtime context). No event bus: things
that happen go in buffers (0017). Any `@field` is animatable by clips and timelines without extra code (0371).
Animation notifies call methods on `GameBehavior`s only (0372, `World._sendMessage`), not on engine components. The
renderer places each Babylon camera from the camera node's world matrix in `BabylonRenderer` (camera sync), then snaps
a pixel-perfect camera to its pixel grid (0108).

## Decision

**A first-party plugin, `myco.camera-shake`** (`src/plugins/camera-shake/`, runtime and editor halves, 0133, 0140),
with `myco.physics` as an optional dependency (for collision triggers). Its public parts are exported from `myco`.
With the plugin off nothing shakes and nothing else changes.

### Components

**`CameraShake`** (on a camera node: the listener, plus optional continuous noise):

| Field | Default | Notes |
|---|---|---|
| `noise` | `"none"` | continuous noise preset (below) |
| `amplitudeGain`, `frequencyGain` | 1, 1 | scale the noise; animatable, so a clip or timeline keys a shake envelope |
| `impulseGain` | 1 | scales every impulse it hears; animatable; 0 mutes impulses |
| `channels` | `[]` | channel names it hears; empty hears all |
| `positionScale`, `rotationScale` | (1,1,1), (1,1,1) | per-axis weight of the result, in camera space |
| `useCameraSpace` | true | an impulse's direction is read in the camera's space (true) or the world's |
| `use2DDistance` | false | distance to a source ignores Z (2D games) |
| `timeMode` | `"scaled"` | `"scaled"` stops with `Time.timeScale = 0` (pause menus); `"unscaled"` doesn't |
| `seed` | 0 | the noise seed; 0 derives one from the node, so runs replay identically (input recordings) |

Read-only: `offsetPosition` (`Vector3`) and `offsetRotation` (`Vector3`, degrees) — this frame's shake.
Method: `shake(preset, strength = 1, duration?)` shakes this camera only, with no position or falloff (screen
shake for UI moments, damage flashes).

**`ShakeImpulseSource`** (on any node: emits impulses from where it is):

| Field | Default | Notes |
|---|---|---|
| `preset` | `"bump"` | impulse shape preset (below) |
| `force` | 1 | strength; animatable |
| `direction` | (0,-1,0) | the impulse's main axis (normalised when used) |
| `duration` | preset's | seconds |
| `trigger` | `"script"` | `"script"`, `"onStart"`, `"interval"`, `"collision"`, `"trigger"` (the last two need physics) |
| `interval` | 1 | seconds between impulses for `"interval"` |
| `minImpactSpeed` | 1 | `"collision"`: slower contacts don't fire; force scales with impact speed |
| `radius` | 0 | full strength within it |
| `dissipationDistance` | 100 | beyond `radius` strength falls to zero over this distance (smoothstep) |
| `propagationSpeed` | 0 | world units per second the impulse travels; 0 reaches every listener at once |
| `channel` | `""` | the channel it emits on; `""` is heard by every listener |
| `fire` | false | animatable: each false → true change fires one impulse (a clip or timeline keys it) |

Method: `generateImpulse(force?: number | Vector3)` — a number scales `force`, a vector replaces direction × force.

### The three ways an impulse starts

- **Automatic:** `trigger` `"onStart"`, `"interval"`, `"collision"` or `"trigger"` (the physics `CollisionEvents` and
  `TriggerEvents` buffers, 0017). No code.
- **Animatable:** key `fire` in a clip or timeline (a step key false → true), or key `force`, `amplitudeGain`,
  `frequencyGain` or `impulseGain` for a continuous envelope. Works through 0371's property tracks with no animation-
  specific code. (A notify can't call `generateImpulse` directly because notifies reach `GameBehavior`s only; a
  behaviour's notify method can.)
- **Scriptable:** `source.generateImpulse()`, `camera.getBehavior(CameraShake).shake("explosion", 2)`, or, from a
  system or anywhere with no source node, `ShakeImpulses.push({ position, velocity, preset, duration, ... })`.

### ECS stack

- **`ShakeImpulses`** (`defineBuffer`, public): `{ position, velocity, preset, duration, radius, dissipationDistance,
  propagationSpeed, channel }`. Sources, `generateImpulse` and user code all push here; it is the one way in.
- **`cameraShake.Sources`** (`lateUpdate`): evaluates triggers (`onStart`, `interval`, `fire` edges, physics buffers)
  and pushes impulses.
- **`cameraShake.Listen`** (`lateUpdate`, after `Sources` and after `lateUpdate()` scripts, so follow scripts have
  placed the camera): moves this frame's `ShakeImpulses` into the World's table of live impulses (impulses outlive the
  per-frame buffer), drops finished ones, and for each active `CameraShake` sums the impulses that reach it (channel,
  distance, arrival time) plus its noise, and adds the result to the camera's `CameraViewOffset`.
- **`CameraViewOffset`** (`defineComponent("engine.CameraViewOffset", { px, py, pz, rx, ry, rz: f32 })`, engine core,
  public): a camera-space position and rotation (degrees) the renderer adds to a camera's view this frame. Writers
  *add* to it; the engine system `engine.CameraViewOffsets` zeroes every offset at the start of each frame's `update`
  phase, before the update scripts, so it is cleared in every World (headless ones too) whether or not a renderer
  reads it. This is the seam: shake is its first writer, and head bob or recoil kick can be later ones without
  touching the renderer.

All systems are registered with `registerEngineSystems`, so the System catalogue and Worlds panel show them.

### The renderer applies the offset to the view only

- In the camera sync, after reading the node's world matrix and **before** pixel snapping, the renderer applies
  `CameraViewOffset` in camera space. A pixel-perfect camera's shake therefore lands on its pixel grid (no shimmer).
- **Orthographic cameras** get position X/Y and roll only from `cameraShake.Listen`; Z position, pitch and yaw don't
  read as shake in orthographic and are left out. The renderer applies whatever `CameraViewOffset` holds.
- **Nothing else moves:** the camera's `Transform`, physics, the audio listener and camera rays and screen points
  (`screenPointToRay`, `worldToScreenPoint`, 0073) use the unshaken pose, so aim, picking and UI anchors stay steady.

### Presets

Presets are data in one format (an envelope curve over normalised time, `core/curve.ts`, times a signal that is either
the direction alone or 6-channel noise), held in a table in the plugin. "Custom" later is the same format exposed as an
asset, not new machinery.

- **Impulse shapes (`ShakeImpulsePreset`):** `recoil` (instant kick, fast ease back, along the direction), `bump`
  (one smooth pulse along the direction), `explosion` (a hard hit decaying through noise on all six channels),
  `rumble` (a sustained noisy shake that fades in and out). Default durations 0.2, 0.3, 1.0 and 2.0 s.
- **Continuous noise (`CameraNoisePreset`):** `none`, `handheldSubtle`, `handheld`, `handheldWild`, `shake6D`. Each is
  per-channel smooth noise (2–3 octaves, each with an amplitude and frequency) from a seeded generator.

### Editor

- The Inspector's preset fields show the preset's curve as a small plot, and both components get a **Test** button
  that, in Play mode, fires an impulse or a `shake`.
- A selected source draws its `radius` and `radius + dissipationDistance` as wire spheres (circles in 2D).
- Shake doesn't run in a scene being edited (0026), so the scene view never shakes; the camera preview inset does in
  Play mode.

### Not in scope

Custom presets (curve and noise assets), shaking anything but cameras, replication (shake is cosmetic: each peer's
own scripts and triggers make it), and a timeline track type of its own (keyed `fire` covers it).

### As built (2026-11-27)

- `ShakeImpulses` has the id `cameraShake.Impulses`. An impulse taken in a frame counts as starting when that frame
  began, so the frame that hears it already shows it.
- `generateImpulse()` pushes into its own World's buffer, whichever World is current (the editor's Test button calls
  it from outside the play World).
- `"collision"`: by the time systems read a contact the solver has stopped the body, so the impact speed is the
  source body's velocity when `cameraShake.Sources` last looked, less the other body's velocity now. Physics is loaded
  with `import()` while the Physics plugin is on (as the Animation plugin's grounder does); without it, collision and
  trigger sources send nothing.
- `duration` 0 means the preset's own duration.

## Alternatives considered

- **Shake the camera's `Transform`** (as Cinemachine ends up doing). Fights follow scripts, shakes the audio listener,
  rays and anything parented to the camera, and leaves drift if a frame is missed.
- **A screen-space post effect** (shift the final image). Cheap and 2D-friendly, but shows edges or needs overscan,
  can't rotate in 3D, and doesn't parallax. The view offset gives the same 2D result with correct 3D.
- **Only a `shake()` method on the camera.** Simplest, but no spatial falloff, channels, collision or animation
  triggers; Unity's source/listener split is what makes shakes authorable without code.
- **Inside the post-processing plugin.** That plugin claims a screen-space component the renderer core composes;
  shake is a camera pose change with its own systems and physics dependency. Separate plugins can be enabled apart.
- **Notify-driven impulses** (the shake system reads `AnimationEvents`). Couples to the animation plugin and only
  works for Animators, not timelines; keying `fire` works for both.

## Consequences

**Positive**
- Shakes from collisions, intervals and start with no code; from clips and timelines with keys; from scripts and
  systems with one call or one buffer push.
- Follow scripts, aim, rays, UI anchors and audio are unaffected by shake.
- `CameraViewOffset` is a reusable seam for other camera effects.
- Deterministic with a seed, so input recordings and tests replay the same shake.

**Negative / costs**
- A new plugin, two components, one buffer, two systems and one engine data component in the public API.
- Rays don't match the shaken image; a game wanting shaken aim must apply `offsetPosition`/`offsetRotation` itself.
- Live impulses are per World state the plugin keeps, outside component storage.

## Deprecates

Nothing.

## Open questions

- Custom presets: an asset (`*.shake.json`) with an envelope curve and noise channels, and an editor for it.
- Whether a dedicated timeline track (an impulse clip with a visible length) is worth adding over keyed `fire`.
- Whether the Flappy sample should use it (a small bump when the bird hits a pipe); doing so changes its captures.

## References

- `src/engine/render/babylon/BabylonRenderer.ts` (camera sync), `src/engine/render/components.ts` (`Camera`).
- `src/plugins/post-processing/` (plugin layout), `src/plugins/physics/runtime/systems3d.ts` (`CollisionEvents`).
- Unity Cinemachine Impulse (Impulse Source, Impulse Listener, Collision Impulse Source) and Basic Multi-Channel Perlin.

# 0252. The lighting rig resolves what the sky and fog contribute in one sync after the lighting phase

- **Status:** Accepted
- **Date:** 2026-11-20
- **Deciders:** Chris Carlson
- **Supersedes:** —
- **Related:** 0053, 0071, 0112, 0114, 0130 (amends: lighting is no longer two features), 0135, 0140 (amends: the rig stays core, as one module rather than the `lights` and `environment` features), 0153, 0154, 0189

## Context

The lighting rig (`render/babylon/lighting.ts`, `BabylonLighting`) is one object: Light components, shadow requests,
the Environment's lighting, the studio room and the skybox. Before this record its interface was shallow: four
callers mutated it through setter channels, and its correctness depended on the order they ran in.

- `features.ts` split it into two render features, `LightsFeature` (`syncLights`) and `EnvironmentFeature`
  (`syncEnvironment`), only so the fog could sync between them: the skybox dims by the sky fog.
- The Sky plugin's `BabylonSky` called `setSunOverride` and `setSkyEnvironment` (through its own `SkyLightingHooks`
  interface); the fog called `setSkyFog`, injected as a callback by `BabylonRenderer`; the renderer called
  `shareStudio` (thumbnails) and `fitSky` (each view).
- The order sky → lights → fog → environment was written as `after` constraints on three specs (`LIGHTS_SPEC`
  `after: ["sky"]`, `FOG_SPEC` `after: ["sky", "lights"]`, `ENVIRONMENT_SPEC` `after: ["sky", "lights", "fog"]`).
  A new plugin feature affecting lighting had to know this chain. A setter's value also outlived its caller: if the
  sky feature stopped syncing, its last sun override and bake stayed on the rig.
- Tests drove the rig's halves (`syncLights`, `syncEnvironment`, `setSunOverride`) directly, not as the renderer does.

## Decision

We will make the lighting rig one deep module that **takes contributions and resolves them itself**.

- **Contributions.** A render feature in the `lighting` phase contributes data for this frame with
  `contribute(c: LightingContribution)`: `sun` (the sky's sun, ADR 0114; null leaves Lights as authored),
  `skyEnvironment` (the procedural sky's bake, ADR 0112) and `skyFog` (how much the fog covers the sky, ADR 0071). A
  field nobody contributes in a frame is off in that frame; when two features contribute a field, the later wins.
  Plugin features see only this (`BabylonFeatureHost.lighting: LightingContributions`), so plugins can still
  contribute (ADR 0135, 0140) but can't set the rig's state.
- **One sync.** The renderer calls `BabylonLighting.sync(world, camera, far)` once, as its own step after the
  `lighting` phase (`SYNC_PHASES` docs list it beside the steps after `content` and `effects`). It resolves the lights
  and shadow requests, then the environment and skybox, from the World and the frame's contributions, then clears
  them. The order between those parts is internal. `syncLights`/`syncEnvironment` become private.
- **Read through its interface.** `shadows()` (the last sync's shadow requests, for the frame graph), `state()`
  (diagnostics), `settled()` (ADR 0189; was `environmentSettled`), `mainLight`, `fit(camera)` (per view; was
  `fitSky`), `release(light)` (the renderer routes destroyed Lights to it, as it does Cameras) and `dispose()` (after
  every feature, which may own contributed textures).
- **Construction.** The studio room is a constructor option (`{ studio }`: someone else's shared room, or null for
  none, as thumbnails pass, ADR 0153) instead of the `shareStudio` setter.
- **Features.** `LightsFeature`, `EnvironmentFeature`, `LIGHTS_SPEC` and `ENVIRONMENT_SPEC` are deleted. The fog stays a
  core feature (`FOG_SPEC`, now in `fog.ts`) that sets the scene's fog and contributes `skyFog`; the Sky plugin's
  feature contributes `sun` and `skyEnvironment`. Neither has an `after` constraint. The `after` mechanism (0135) stays
  for features that do depend on each other (meshes after sprites and tilemaps).

## Alternatives considered

- **Keep the rig as one feature with `after: ["sky", "fog"]`.** Removes the split but keeps ordering in the
  interface: every new contributor must be named in the rig's spec.
- **A new `lighting-resolve` sync phase.** Equivalent ordering, but adds a phase to the renderer-neutral
  `SYNC_PHASES` for one core module; the renderer's own between-phase steps already exist for exactly this.
- **Contributions that persist until changed (setters under a new name).** Keeps the stale-override bug and makes
  "who set this?" a question of history. Per-frame contributions cost one object write per frame.

## Consequences

**Positive**
- Ordering is the rig's: any feature in the `lighting` phase can contribute, in any registration order.
- A contributor that stops syncing (disposed, not loaded, the World has no sky) stops affecting lighting at the next
  frame.
- Tests drive one rig with contributions and read it through `shadows()`, `state()`, `settled()` and the scene it
  lights; a renderer test checks that a plugin feature's contribution is resolved in the same frame.

**Negative / costs**
- A feature in a later phase can't contribute to this frame's lighting (none does; the sky and fog are in `lighting`).
- The renderer names the rig in two more places (the step after `lighting`, Light release).

## Deprecates

`LightsFeature`, `EnvironmentFeature`, `LIGHTS_SPEC`, `ENVIRONMENT_SPEC` (`features.ts`); `setSunOverride`,
`setSkyEnvironment`, `setSkyFog`, `shareStudio`, `fitSky`, `environmentSettled`, public `syncLights`/`syncEnvironment`
(`lighting.ts`); `SkyLightingHooks` (`sky/BabylonSky.ts`); `FogHost.setSkyFog`. All removed.

## Open questions

None.

## References

- `src/engine/render/babylon/lighting.ts`, `BabylonRenderer.ts`, `fog.ts`, `features.ts`, `feature.ts`,
  `sky/BabylonSky.ts`; `src/plugins/sky/runtime/`.
- Tests: `engine/tests/babylonLighting.test.ts`, `renderFeatureHooks.test.ts`, `renderFeatureAdapters.test.ts`,
  `renderFeatures.test.ts`, `plugins/renderPlugins.test.ts`.
- Architecture review 2026-11-20, candidate 7.

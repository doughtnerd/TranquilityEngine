# 0393. A directional Light flagged `sun` is the World's sun, which the sky drives and Main Light nodes read; else the brightest

- **Status:** Accepted
- **Date:** 2026-11-24
- **Deciders:** Chris Carlson
- **Supersedes:** — (amends 0114's and 0075's choice of the main directional light)
- **Related:** 0043, 0075, 0114, 0252, 0277

## Context

Two parts of the lighting rig (`src/engine/render/babylon/lighting.ts`, `BabylonLighting`) each chose a "main"
directional light, by different rules:

- **The sky's sun** (ADR 0114): the first enabled directional `Light` with `castShadows` on, else the first enabled
  directional one.
- **Shader graphs' Main Light** (ADR 0075's note on Main Light nodes, three.js's rule): the first directional light
  that *casts a shadow this frame*, else the first directional one.

On a quality tier with shadows off (a project may turn them off for a tier, Project Settings > Graphics) nothing
casts, so Main Light fell back to the first directional light while the sky still drove the first one with
`castShadows`: graphs lit from one direction, the rest of the scene from another. And neither rule let an author say
which light is the sun: it followed the shadow switch, a setting with another purpose.

The owner's decision (review item Q23): follow Unity and Unreal.

- **Unity:** the Lighting window's *Sun Source* (`RenderSettings.sun`) names the light the procedural skybox follows;
  when none is set, Unity uses the brightest directional light in the scene.
- **Unreal:** a Directional Light's *Atmosphere Sun Light* flag (`bAtmosphereSunLight`) marks the light the sky
  atmosphere uses as its sun; with several, its *Atmosphere Sun Light Index* says which is which.

## Decision

We will give the directional Light a **`sun` flag** (Unreal's shape, a field on the light rather than a World
setting) and choose **one sun** that the sky and Main Light nodes both use, whatever the shadow tier.

- **Field.** `Light.sun: boolean` (`engine.Light`, `@field(Boolean)`, default `false`), saved in scenes and shown in
  the Inspector with the other Light fields; its description is the field's tooltip. It matters for directional
  lights only.
- **The pick** (`BabylonLighting`, each sync), over the World's enabled directional Lights:
  1. the one flagged `sun`;
  2. several flagged: the brightest of them, ties to the first in the World's order, and a warning once per rig
     naming the chosen node ("N directional lights are flagged sun; using the brightest, …");
  3. none flagged: the brightest of all (Unity's fallback), ties to the first;
  4. none at all: the default sun of the default rig (ADR 0277) when the World has no Lights, else Main Light's
     fixed fallback (0.4, 1, −0.6) and white, as before.

  *Brightest* is intensity × the Rec. 709 luminance of the colour in linear space, converted as the rig converts
  colours for Babylon (gamma 2.2).
- **Both readers use it.** A contributed sky sun (ADR 0114, 0252) drives that light; `BabylonLighting.mainLight`
  reads it (after the sky has driven it). `castShadows` and the tier's shadows no longer take part: they decide only
  which lights cast.

## Alternatives considered

- **A World setting naming the sun (Unity's *Sun Source*)** — a reference from a settings object to a node needs a
  node reference that survives prefabs, duplication and deletion; a flag on the light travels with it, as Unreal's
  does. Unity's fallback to the brightest light is kept.
- **Both readers follow `castShadows` as authored, or both "casts this frame"** — the two options listed with Q23.
  Either keeps the sun tied to the shadow switch, and "casts this frame" moves the sun when the player changes the
  quality tier.
- **First flagged instead of brightest flagged** — first depends on the order of nodes, which an author doesn't see
  as meaningful; brightest matches the unflagged rule. Either way it is deterministic and warned about.
- **Unreal's index for two suns** — the sky draws one sun; a second sky light (a moon) is the sky's own (ADR 0114).

## Consequences

**Positive**
- The sky and shader graphs agree on every tier, and an author picks the sun explicitly.
- A scene with one directional light looks as before.

**Negative / costs**
- A scene with several directional lights and none flagged now takes the brightest as its sun instead of the first
  shadow caster. No sample has more than one directional light, so none changed.
- One more Light field, which means nothing on point, spot and ambient lights.

## Deprecates

The two earlier rules for the main directional light (0114's "first shadow-casting directional, else the first",
0075's "first casting this frame, else the first"), replaced in `lighting.ts`.

## Open questions

- The Inspector shows `sun` for every light type, as it shows `spotAngle` on directional lights; hiding fields by
  type is a general Inspector question.

## References

- Unity Manual, *Lighting window* (Environment > Sun Source) and `RenderSettings.sun`.
- Unreal Engine documentation, *Directional Lights* (Atmosphere and Cloud > Atmosphere Sun Light, Atmosphere Sun
  Light Index) and *Sky Atmosphere Component*.
- Review item Q23 (2026-11-24).

# 0333. Attenuation curves live on playlists; audio zones are a component; spatial test scenes are Studio assets

- **Status:** Accepted
- **Date:** 2026-11-22
- **Deciders:** Chris Carlson
- **Supersedes:** — (amends 0162: attenuation is a set of curves, not a rolloff model)
- **Related:** 0074, 0157, 0162, 0170, 0327, 0329, 0330, 0332, 0334

## Context

Spatial audio today (0162): attenuation is `minDistance`, `maxDistance` and one of three rolloff laws on `AudioSource`,
one-shot options and an event's `spatial` block, plus a reverb-send-versus-distance curve; HRTF for the nearest
`voices.hrtf` voices, third-order ambisonic beds and equal-power panning for the rest; occlusion by rays against
colliders on `audio.occlusion.layers` with `AudioOccluder` materials whose losses add; reverb zones
(`AudioReverbZone`: box or sphere, presets, impulse responses, priority); Doppler. "Test scenes" are the Sound Lab
sample, not a tool.

The prototype's Spatial screen adds: **attenuation curves** for volume, low-pass, reverb send and spread over distance,
edited in the Curves window with Min/Max handles (its storage is a stand-in keyed by emitter name and the curves are
dropped on apply); **audio zones** (an area that plays a sound, heard from its edge or only inside, with a feather, a
0..1 depth exposed as a parameter and a spread that narrows with distance); **test scenes** in folders with listeners,
static and moving emitters (routes with speed and height), obstacles with materials, reverb zones, audio zones and 2D
sounds; a top-down view with an elevation slab and a side view; "From open game scene" (a game scene's own sounds, with
A/B replacement that doesn't change the scene) and "From take" (positions at a take's playhead); a Voices table of how
each sound is heard (HRTF, panned, bed), its distance, occlusion and Doppler.

## Decision

We will put attenuation on the playlist as curves, add an `AudioZone` component, and make test scenes Studio assets the
Studio plays through the engine's real components.

**Attenuation** is part of a playlist's `spatial` block (0329), inline or as a reference to a shared preset asset
`*.attenuation.json` (`myco.attenuation@1`):

```jsonc
"spatial": { "attenuation": "audio/attenuation/vehicle.attenuation.json",   // or an inline object of the same shape
             "occlusion": true, "doppler": 0.5, "spread": null }
// *.attenuation.json
{ "format": "myco.attenuation@1", "minDistance": 2, "maxDistance": 40,
  "curves": { "volume": [[0, 0], [2, 0], [40, -60, "easeOut"]], "lowpass": [[0, 20000], [40, 2000]],
              "reverbSend": [[0, 0], [40, -6]], "spread": [[0, 180], [40, 20]] } }
```

- Curves are engine curves (0332) keyed on distance in metres, in the target's units; moving Min or Max in the editor
  stretches the keys between them. Beyond the last key the value holds.
- The rolloff laws become presets (Linear, Inverse, Exponential, Inverse square) that write curve keys; the migration
  (0329) turns each event's `rolloff` and `reverbSendCurve` into curves.
- `AudioSource` and one-shot options keep `minDistance`/`maxDistance` as optional overrides that stretch the playlist's
  curves; `rolloff` is migrated.
- The spatial code (`runtime/core/spatial.ts`) evaluates the volume and spread curves on the main thread per voice per
  frame, as it computes attenuation today, and sends low-pass and reverb send through the voice's existing parameters.

**Audio zones** are a new runtime component, `AudioZone` (public API): a rotated box with `bottom`/`top`, a playlist,
`heard: "edge" | "inside"`, `feather` (m). Outside an edge zone the sound plays from the nearest point on the box, with
spread `min(180°, 40° + 600°/max(3 m, distance))`, traced for occlusion; inside it plays as an ambisonic bed. An inside
zone plays non-spatially at a level that falls linearly over the feather. Its depth (0 at the edge, 1 at the centre)
is the playlist instance's built-in local parameter `zoneDepth`. Editor Inspector section and gizmo as for reverb zones.

**Settings the Spatial screen shows** are the project's (`audio.json` `settings`, 0330): HRTF voice count (existing
`voices.hrtf`), a new `bed.beyond` distance (sounds farther than this go to their bus's bed), a global Doppler amount
multiplier `doppler.amount` (0..2, default 1), occlusion materials. Where the prototype differs from the engine on a
detail, the engine's behaviour stays: occlusion losses of several obstacles add (the prototype takes the worst),
Doppler uses listener velocity too, and reverb-zone membership is per source. The prototype's reverb presets (Small
stone, Canyon hall, Metal tunnel, Forest) are added to the zone presets, and a zone can be the level's default.

**Test scenes** are Studio assets `*.audioscene.json` (`myco.audioscene@1`) holding listeners (one active), emitters
(static with x, y, z; moving with a route, speed, path height and a start fraction), obstacles (rotated boxes with
bottom/top and a material), reverb zones, audio zones and 2D sounds (playlist, volume, output bus), each with name,
hidden and locked flags, and folder paths for the Scenes tree. Optionally `base: "scenes/canyon.scene.json"` names a game
scene whose audio components and colliders load read-only underneath, with `replace: { <component path>: <playlist> }`
for A/B replacement. The Studio plays a test scene by building a headless World from it with the engine's own
components (`AudioListener`, `AudioSource`, `AudioOccluder` with a box collider on the occlusion layer, `AudioReverbZone`,
`AudioZone`) and the 3D physics plugin, and moves moving emitters along their routes. The Voices table reads the
runtime's own debug rows (how each voice is rendered, distance, occlusion, Doppler), not a simulation. "From take"
copies the listener and emitter positions at the take's playhead (0334).

## Alternatives considered

- **Attenuation on the emitter (the prototype's stand-in)** — attenuation is a property of how a sound behaves, needed
  wherever it plays; per-emitter would repeat it in every scene.
- **Test scenes as ordinary game scenes** — reuses the scene format, but the Studio would edit scene files the editor
  owns (0327) and need the scene document machinery; a small Studio format that spawns engine components keeps the
  runtime real without that.
- **The prototype's spatial maths in the Studio** — would drift from what the game does; the Studio runs the engine.

## Consequences

**Positive**
- Designers shape distance behaviour with curves and share presets; test scenes play through the real runtime.
- Audio zones cover rain, rivers and wind without scripting.

**Negative / costs**
- A new public component and Inspector section; attenuation evaluation changes from three laws to curves.
- The Studio's runtime loads the 3D physics plugin for occlusion in test scenes.

## Deprecates

- `rolloff` on events, `AudioSource` and one-shot options (migrated to curves), `reverbSendCurve` (now the
  `reverbSend` attenuation curve).

## Open questions

- None.

## References

- Prototype Spatial screen (`Spatial2.dc.html`), Journey j9.
- `src/plugins/audio/runtime/core/spatial.ts`, `AudioSource.ts`, `AudioReverbZone.ts`, `AudioOccluder.ts`,
  `src/engine/audio/occlusionMaterials.ts`; guide `spatial-audio.md`; `samples/sound-lab/`.

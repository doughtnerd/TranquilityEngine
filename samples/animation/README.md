# Animation sample

The animation plugin (ADR 0370–0373) in four stations and a 2D page. Open it from the editor's start screen (or
`/editor.html?sample=animation` with `npm run dev`) and press Play.

| Station | Shows | Files |
|---|---|---|
| Graph | A skinned glTF model (`Skeleton`, `SkinnedMeshRenderer`) whose `Animator` runs an animation graph: a state machine (Idle, Move, Hop), a 1D blend space on the `speed` parameter (Idle, Sway, Wiggle), a requested hop, and the hop clip's `land` notify reaching a behaviour | `models/sprout.gltf`, `graphs/sprout.animgraph.json`, `clips/sprout-*.anim.json`, `scripts/behaviors/SproutController.ts` |
| Property clip | An `Animator` with no skeleton playing an authored clip: a child's position and rotation, a light's colour, and a `chime` event | `clips/lantern.anim.json`, `scripts/behaviors/GemPulse.ts` |
| Tweens | `tween()`, `parallel()` and `sequence()` from script, one easing per cube, awaited round after round | `scripts/behaviors/TweenShowcase.ts` |
| Timeline | A `TimelineDirector` moving two moons, scaling the planet and switching a light with an activation track | `timelines/orrery.timeline.json` |
| Sprites page | Flipbooks from a sliced sheet (`walk`, `spin` in the image's sidecar), a walker on linear tweens and coins on a looping yoyo tween | `images/critter.png`, `scenes/sprites.scene.json`, `scripts/behaviors/Walker.ts`, `Bob.ts` |

Open a clip in the Animation window, or the graph in the graph editor, to edit them; the debugger shows the graph live
while playing.

## Controls

| Key | Does |
|---|---|
| Up / Down (W / S) | Change the sprout's speed (it moves from Idle to Move above 0.15, and blends Sway into Wiggle up to 2) |
| Space | Ask for a hop |
| P | Autopilot on or off (on until a key is pressed: the speed follows a slow wave and it hops every 5 s) |
| 2 / 1 | Open the sprites page / go back |

## Regenerating

Everything but the scripts and the HUD is generated from numbers by `node samples/animation/tools/generate.mjs`
(no dependencies; running it again writes the same files). `src/engine/tests/animationSample.test.ts` plays both scenes
headless.

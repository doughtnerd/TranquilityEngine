# Water

A `WaterSurface` draws a moving sea: a grid pushed around by up to eight Gerstner waves, with foam on the crests, ripples, and reflections of the sky. `Buoyancy` floats nodes on it. The waves you see and the waves scripts sample come from the same numbers, so a ship sits on the crest that is drawn under it.

The design is in [ADR 0072](../decisions/0072-water-surfaces-and-buoyancy.md). This guide is about using it.

## Adding water

In the editor, choose **Create > Water**. You get a node with a `WaterSurface` and a preset of four waves: a long swell, two crossing seas and a short chop. In code:

```ts
import { GameObject, WaterSurface } from "myco";

const sea = GameObject.create("Sea");
const water = sea.addBehavior(WaterSurface); // starts with the same four-wave preset
water.size = 200;
```

The grid is a square of `size` units centred on the node, in the node's XZ plane. Keep the node level: move it and turn it about Y, but don't pitch or roll it (sampling assumes the water's up is the world's). The waves continue past the grid's edge for sampling, but only the grid is drawn.

## Fields

| Field | What it does |
| --- | --- |
| `size` | Side of the square, in the node's units. |
| `resolution` | Vertices per side (2–1024, default 128). Tiers whose shader level is "low" draw half. Short waves need enough vertices: at least four per wavelength looks right. |
| `waves` | Up to 8 waves. Each has `direction` (degrees around Y, 0 = +X, 90 = +Z), `wavelength` (crest to crest), `steepness` (0 flat to 1 sharp) and `speed` (0 uses the natural deep-water speed √(g·L/2π)). Edited as a list in the Inspector. |
| `waveScale` | Multiplies every wave's height (and its sideways motion). Raise it for a storm. |
| `deepColor`, `shallowColor` | Looking straight down and in troughs you see the deep colour; at grazing angles and on crests, the shallow one. |
| `foamColor`, `foamAmount` | Foam forms where the surface is squeezed together, which is where crests fold. 0 is none; 1 foams readily. |
| `normalDetail` | Strength of two layers of scrolling ripples on top of the waves. |
| `roughness`, `reflectivity` | How blurry and how strong the Fresnel reflection of the sky and reflection probes is. |
| `opacity` | Below 1 the water is drawn transparent. |

Choosing waves: a wave's height is `steepness × wavelength / 2π`. The steepnesses of all waves should add up to well under 1, or crests fold over themselves and loop. Spread directions over 90° or so, and use wavelengths that aren't multiples of each other, so the pattern doesn't visibly repeat.

The water is lit like any other material: lights, received shadows, the World's `Environment` (and any `ReflectionProbe` whose box holds the water's centre), and fog. It doesn't cast shadows.

## Sampling the surface

```ts
import { Water } from "myco";

const s = Water.sample(x, z); // the World's first enabled WaterSurface; null without one
if (s && s.height > y) {
  // (x, y, z) is under water; s.normal is the surface's up there
}
```

`water.sample(x, z)` asks one surface. Both return `{ height, normal }` in world space, at the water clock's current time. Gerstner waves move water sideways as well as up, so the sampler finds the point of the drawn surface that is actually above (x, z).

`Water.time` is the water clock: the World's scaled time (so pausing time freezes the waves), or the server tick in a networked World.

## Buoyancy

Add `Buoyancy` to a node to float it on the World's first enabled surface. It samples the water at a few local points: by default the four corners of `size` (x is the width, y the length along local Z); set `points` for a different shape, such as more points along a long hull.

**Physics mode** (default) needs a dynamic `RigidBody` on the node. Each point under water pushes the body up with a force of `depth × strength × mass × g / points`, at that point, so the waves pitch and roll it. At `strength` 1 the body floats with its points one unit deep on average; at 2, half a unit. While under water, `drag` and `angularDrag` (per second, scaled by how much is submerged) slow it down, which stops it bobbing forever.

```ts
const box = GameObject.create("Crate");
box.addBehavior(RigidBody).mass = 20;
box.addBehavior(BoxCollider);
const b = box.addBehavior(Buoyancy);
b.size.set(1, 1);
b.strength = 2;
```

**Kinematic mode** places the node on the waves without physics: its height becomes the mean water height at its points, and its pitch and roll follow the plane through them, eased by `follow` (per second; 0 snaps). The node's heading is kept. Use it for scripted ships and props.

`submerged` is the fraction of points under water at the last fixed step (always 1 in kinematic mode).

Buoyancy runs in the fixed step, after scripts' `fixedUpdate` and before 3D physics. It needs no renderer, so a dedicated server floats objects the same way the clients do.

## Storms

One field changes both the look and the physics:

```ts
water.waveScale = Mathf.lerp(water.waveScale, stormy ? 2.5 : 1, Time.deltaTime);
```

## Multiplayer

Every World computes the same waves from the same clock: in a networked World the water clock is `Time.network.serverTick / tickRate`, so a server and its clients agree within a frame. Wave settings are scene data, the same everywhere. Fields you change at runtime, such as `waveScale` for a storm, aren't sent by themselves: keep the storm state in a replicated field of your own and set `waveScale` from it on every World.

## Known limits

- Gerstner waves repeat; eight waves hide it from a ship-game camera, not from close up.
- No shoreline foam or depth fade against geometry, no refraction, no underwater view.
- One grid per surface (no camera-following rings for very large oceans).
- The water node must be level for sampling, and the water isn't picked by clicking in the Scene view (select it in the Hierarchy).

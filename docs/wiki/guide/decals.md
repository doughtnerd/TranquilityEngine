# Decals

Decals put a picture onto other things: bullet holes, blood splats, scorch marks, footprints, road paint, grime. In 3D a `DecalProjector` projects a material onto whatever opaque surfaces are inside its box; in 2D a `Decal2D` stamps a sprite onto a sorting layer and can stop at the edge of the sprite it sits on. For decals that gameplay makes by the hundred, `Decals.project` and `Decals.stamp` spawn them without a node. They come from the **Decals** plugin (`myco.decals`), which is on by default.

The design is in [ADR 0395](../../decisions/0395-decals-are-a-plugin-3d-projectors-shade-the-scene-depth-2d-decals-are-layered-quads.md). This guide is about using them.

## 3D: DecalProjector

In the editor, choose **+ > Effects > Decal Projector**. The projector is a box; it projects along its node's forward axis (+Z), and the default `pivot` puts the node on the box's back face, so place the node in front of a wall and point it at the wall. In the scene view every projector shows its box and an arrow along the projection.

```ts
import { DecalProjector, GameObject, Quaternion, Vector3 } from "myco";

const scorch = GameObject.create("Scorch");
scorch.transform!.position.set(0, 0.5, 0);
scorch.transform!.rotation = Quaternion.lookRotation([0, 0, 1]); // project along +Z
scorch.addBehavior(DecalProjector, { texture: "textures/scorch.png", size: new Vector3(2, 2, 1) });
```

| Field | What it does |
| --- | --- |
| `material` | A material asset or shader graph. Empty: the built-in decal material (lit, rough), showing `texture`. |
| `texture` | The built-in material's texture: its colour and alpha are the decal. Greyed while a material is set. |
| `color`, `opacity` | Multiply the material's colour and alpha (`opacity` is Unity's fade factor). |
| `size` | The box: width, height and how deep it projects. Surfaces anywhere inside the box receive the decal. |
| `pivot` | Where the box's centre is from the node, in node units (not scaled by `size`, as in Unity). |
| `uvScale`, `uvOffset` | Tile and shift the texture across the box. |
| `blend` | `alpha`: drawn over the surface and lit by the scene's lights, environment and fog. `multiply`: darkens what's under it (dirt, grime), unlit, keeping the surface's own shading and shadows. `additive`: adds light (glows, magic circles), unlit. |
| `order` | Where two decals overlap, the higher order draws on top. |
| `drawDistance`, `fadeRange` | Beyond `drawDistance` metres from the camera the decal isn't drawn; it fades out over the last `fadeRange` metres. |
| `angleFade` | In radians, between a surface's normal and the projection: full strength below x, gone past y. Stops a decal smearing down the sides of things it hits at a grazing angle. |

### Editing the box

Select the projector and press **Edit Bounds** in its Inspector card: the box gets a handle on each face. Drag one to resize the box with the opposite face fixed; hold Alt to resize about the centre. Each drag is one undo step.

### What receives decals

Everything opaque and depth-tested inside the box: meshes and models, moving and animated ones too, so a decal stays put in the world while things pass through it. Sprites, tilemaps and other 2D content, water, particles and transparent materials never receive 3D decals. There's no per-object opt-out yet, so keep boxes tight around what they should mark.

### Materials

A decal material asset is drawn with its own colour, textures and normal map, sampled across the box. Shader graphs work: their UV and normal nodes see the surface the decal landed on. The asset itself isn't changed (the decal draws a copy).

## 2D: Decal2D

Choose **+ > 2D > Decal 2D**, or add a `Decal2D` under a sprite's node. It stamps `sprite` in `sortingLayer` at `orderInLayer`, sorted with sprites, tiles and 2D lines. Its size comes from the sprite's pixels and pixels per unit unless you set `size`.

With `clip` at `parentSprite` (the default), it draws only where the parent node's sprite is opaque: a splat on a crate stops at the crate's edge, and follows the crate's flips and slice. With `clip` at `none`, or without a sprite on the parent, it draws everywhere it covers.

## Spawned decals

```ts
import { Decals, Physics, Quaternion, Vector3 } from "myco";

// A bullet's hit (`{ collider, point, normal, distance }`): a hole on the surface, projecting into it, gone after 20 s.
const hit = Physics.raycast(origin, direction);
if (hit) {
  Decals.project({
    position: hit.point,
    rotation: Quaternion.lookRotation(Vector3.scale(hit.normal, -1)), // its +Z into the surface
    size: [0.2, 0.2, 0.3],
    texture: "textures/bullet-hole.png",
    lifetime: 20,
    parent: hit.collider.node, // follows a door that swings; removed when the door is destroyed
  });
}

// A 2D splat clipped to the enemy sprite it hit.
Decals.stamp({ position: [x, y], rotation: Math.random() * Math.PI * 2, sprite: "fx/splat.png", clip: enemyNode, lifetime: 5 });
```

Both return a handle: `alive`, `opacity` (set it to fade by hand) and `remove(fadeOut?)`. `Decals.count` says how many there are, and `Decals.clear()` removes them all.

Each World keeps at most `render.maxDecals` spawned decals of each kind (1000 by default, set it in `project.json`); spawning past it fades out the oldest quickly. Placed `DecalProjector` and `Decal2D` Components don't count.

Spawned decals are cosmetic: they aren't saved in scenes and aren't replicated. In multiplayer, spawn them on each client from a replicated event (the hit). On a dedicated server or in a headless World the calls keep their bookkeeping, so scripts behave the same, and nothing draws.

## Performance

Decals sharing a material, blend and order draw together as one instanced draw, so hundreds of bullet holes cost a handful of draws. Any 3D decal makes every camera keep a depth pass (about what ambient occlusion's costs), even on quality tiers that turn ambient occlusion off. A decal's cost on the GPU is the screen area its box covers, so a huge box filling the screen costs more than many small ones.

## Known limits

- Lit (`alpha`) decals are lit by the scene's lights but don't take shadow maps: in shadow they look unshadowed. Use `multiply` for grime that should stay in shadow.
- No per-object opt-out from receiving 3D decals yet.
- 2D decals clip to a parent sprite only, not to tilemaps or whole sorting layers.
- Clicking a projected decal in the scene view doesn't select it; select it in the Hierarchy.
- Script `Material` values aren't applied to decal materials.

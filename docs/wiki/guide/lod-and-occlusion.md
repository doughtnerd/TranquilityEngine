# Levels of detail

Levels of detail (LOD) let distant objects draw with fewer triangles. A model gets cheaper versions of each mesh, called
**levels**, generated when you import it. An **LOD Group** on the placed model picks a level per camera by how tall the
object looks on screen, and stops drawing it when it gets too small. It works like Unity's LODGroup, except that you
don't model the levels yourself.

The design is in [ADR 0446](../../decisions/0446-meshes-get-import-generated-lod-levels-chosen-per-camera-by-an-lodgroup-with-dithered-crossfade.md).
Occlusion culling, which skips objects hidden behind others, is designed in
[ADR 0447](../../decisions/0447-occlusion-culling-v1-is-a-cpu-software-depth-buffer-in-a-rust-wasm-simd-core.md) and not
switched on yet. This guide is about LOD.

## Getting started

1. Select a model in the Assets panel. The Inspector shows its import settings.
2. Tick **Generate LODs** and choose **Apply**. The editor makes three levels (half, a quarter and an eighth of the
   triangles) and lists the triangles each level reached and its measured error.
3. Drag the model into the scene. It gets an **LOD Group** component with an LOD bar.
4. Press Play and move the camera away. The model switches to coarser levels, then stops drawing when it's under 1 % of
   the screen's height.

A model without generated levels, or a scene without LOD Groups, draws exactly as before. Nothing changes until you ask
for levels. The import panel suggests it for meshes of 2,000 triangles or more.

## Import settings

| Setting | What it does |
|---|---|
| **Generate LODs** | Makes levels for every mesh of the model. Off: no levels. |
| **Levels** | Up to four rows. **Ratio** is the triangle target relative to the original; **error** is how far a level may stray from the original surface, as a fraction of the model's size. A level stops early when it reaches its error limit, and the panel says what it reached. |
| **Attributes** | Keep normals, UVs and vertex colours in mind while simplifying. Leave it on unless a mesh has no textures or lighting detail. |
| **Permissive** | Let hard edges and UV seams collapse. Boxy, flat-shaded models (buildings, crates) need it: without it their levels stop at about 60 % of the triangles, and the panel warns you. |
| **Lock borders** | Keep open edges exactly where they are, for terrain tiles that must meet their neighbours. |
| **Pixel error** | How many pixels of error a level may show at 1080p before the group switches to a finer one. It sets the automatic transition heights. 1 is a good default. |
| **Occluder** | For occlusion culling (not switched on yet): which level stands in for the model when it hides other objects. |

Levels are generated once and cached in your project's `.myco/lod/` folder, so reopening a project doesn't generate them
again. Exported games read levels baked into their `.mycomesh` files and never run the simplifier.

## The LOD Group

| Field | Default | Meaning |
|---|---|---|
| **Levels** | empty (automatic) | The screen heights at which the group drops a level. Empty means automatic: worked out from each level's measured error and the pixel error. |
| **Fade** | Crossfade | How a switch looks. **Crossfade** blends the two levels with a dither pattern for **Fade duration**; **None** switches at once. |
| **Fade duration** | 0.3 s | How long a crossfade takes. |
| **Force level** | -1 | -1 chooses automatically; a level number always draws that level. A badge on the LOD bar reminds you while it's set. |
| **Size** | 0 (automatic) | The size used to measure screen height. Automatic uses the group's bounds. |

**The LOD bar** shows one coloured segment per level, each with its screen height and triangle count, then a **Culled**
segment. Drag a divider to set your own heights. That writes them into **Levels**, as one undo step. **Reset to
automatic** clears them again.

The group controls every Mesh Renderer and Skinned Mesh Renderer below it, stopping at another LOD Group. Its meshes
switch together, even if they have different numbers of levels.

From a script, `lodGroup.currentLevel` is the level the main camera sees (-1 when culled), and `lodGroup.visibility` says
why something isn't drawn: `"drawn"`, `"lodCulled"`, `"offScreen"` or `"occluded"`.

## Shadows, cameras and quality

- **Each camera chooses its own levels:** game cameras, render-texture cameras, the scene view and reflection probes.
- **Shadows** use the main camera's level, so a shadow matches the object. An object culled because it's too small still
  casts its shadow, at its coarsest level, within the quality tier's shadow distance.
- **Quality tiers** (Project Settings > Graphics) set three fields:
  - **LOD bias:** above 1 keeps detail longer; below 1 drops it sooner.
  - **First LOD level:** the finest level a tier may draw. The Low tier starts at level 1.
  - **LOD crossfade:** whether switches blend. The Low tier switches at once.
- **Animated characters:** set an Animator's **LOD metric** to **LOD Group**, and its update rate follows the group:
  every frame at level 0, every second frame at level 1, every fourth at level 2 and below.

## Why does my object disappear, or not change?

- **It vanishes at a distance:** it's under its last transition height (1 % of the screen by default). Drag the last
  divider on the LOD bar towards 0, or set the last value in **Levels** to 0 to never cull.
- **It never changes level:** check the model has levels (its import settings show them) and that **Force level** is -1.
  A very smooth model's first level can be invisible at almost any distance, so it may start at level 1. That's
  intended: it saves triangles you couldn't see.
- **Its levels barely save anything:** the import panel shows the triangles reached. For boxy models, tick
  **Permissive**.
- **It pops when it switches:** use **Crossfade**, or lower **Pixel error** so each finer level shows for longer.

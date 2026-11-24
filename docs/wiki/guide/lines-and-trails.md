# Lines and trails

A `LineRenderer` draws a ribbon through points you give it: a laser beam, an aim guide, a rope preview, a path. A `TrailRenderer` draws a ribbon behind a moving node: a bullet streak, a sword swipe, a skid mark. Both work in 3D (depth-tested, with any material) and in 2D (sorted with sprites in a sorting layer), and both come from the **Lines and Trails** plugin (`myco.lines`), which is on by default.

The design is in [ADR 0396](../../decisions/0396-line-and-trail-renderers-are-a-plugin-drawing-camera-facing-ribbons.md). This guide is about using them. If you know Unity's components, the fields are the same, with three differences listed [at the end](#coming-from-unity).

## Adding a line or a trail

In the editor, the Hierarchy's **+** menu has **Effects > Line** and **Effects > Trail** (3D) and **2D > Line 2D** and **2D > Trail 2D**. A new line runs one unit along +X from its node. In code:

```ts
import { Color, GameObject, LineRenderer, TrailRenderer } from "myco";

const beam = GameObject.create("Laser").addBehavior(LineRenderer, { width: 0.05, color: new Color(1, 0.2, 0.1) });
beam.setPositions([[0, 1, 0], [0, 1, 20]]); // world space by default

const bullet = GameObject.create("Bullet");
bullet.addBehavior(TrailRenderer, { lifetime: 0.3, width: 0.1 });
```

## Fields both share

| Field | What it does |
| --- | --- |
| `mode` | `"3d"`: drawn in the 3D scene, depth-tested, with `material`. `"2d"`: drawn as 2D content in `sortingLayer` and `orderInLayer`, lying in the node's XY plane, with `texture`. |
| `width` | Width in world units where the width curve is 1. |
| `widthCurve` | The width multiplier along the ribbon: x from 0 at its start to 1 at its end (for a trail, 0 is the head, at the node). Edited in the Inspector with the curve field. |
| `color`, `colorGradient` | The gradient gives colour and alpha along the ribbon (the same 0 to 1); `color` multiplies it. Edited with the gradient field: click the bar's lower half for a colour stop, the upper half for an alpha stop. |
| `cornerVertices` | Extra vertices rounding each join. 0 mitres them (cut back where a join is very sharp). |
| `capVertices` | Extra vertices rounding each end. 0 ends square. |
| `alignment` | 3D: `"view"` turns the ribbon to face the camera drawing it (every camera: split screen and the editor's views each see it face-on); `"transformZ"` makes it face the node's +Z, like a flat strip. |
| `textureMode`, `textureScale` | How the texture runs along: `stretch` once over the length, `tile` repeating every `1 / textureScale.x` world units, `distributePerSegment` once over the points by index, `repeatPerSegment` once per segment. `textureScale.y` repeats it across. |
| `material` | 3D: a material asset or shader graph. Empty: the built-in line material, unlit and alpha-blended, showing `texture`. Vertex colour (the gradient) multiplies the material's colour; shader graphs read it as **Particle Color**. |
| `texture` | The built-in material's texture in 3D, and the texture in 2D. |
| `castShadows`, `receiveShadows` | 3D only. Only ribbons facing their node's +Z cast shadows: a camera-facing ribbon has no width in the shadow map. |
| `sortingLayer`, `orderInLayer` | 2D only: where it draws among sprites, tiles and 2D decals. |

The Inspector greys the fields the mode ignores.

## LineRenderer

| Field | What it does |
| --- | --- |
| `positions` | The points, in order. |
| `useWorldSpace` | On (the default, as in Unity): the points are in world space and stay put when the node moves. Off: they're in the node's space and move, turn and scale with it. Lines made from the Hierarchy menu are created with it off. |
| `loop` | Joins the last point back to the first. |

From scripts: `positionCount`, `setPositions(points)`, `setPosition(index, point)`, `getPosition(index)`. Assigning `positions` works too; edit a copy and assign it back, as the field is replaced, not watched.

### Editing points in the scene view

Select the line and press **Edit Points** in its Inspector card. Each point gets a handle:

- drag a handle to move the point (in the plane facing the camera; a 2D line stays in its XY plane), snapped like the move tool when snapping is on;
- Shift-click on the line to add a point there;
- press Delete to remove the point you last grabbed (a line keeps two).

Each change is one undo step. Press Edit Points again, Escape, or pick a transform tool to stop.

## TrailRenderer

| Field | What it does |
| --- | --- |
| `lifetime` | Seconds a point lives (Unity's `time`). |
| `minVertexDistance` | A new point once the node has moved this far from the last one. Smaller is smoother and costs more points (a trail keeps at most 1024). |
| `emitting` | Off: no new points; the trail ages out. |
| `autodestruct` | Destroys the node once its trail has aged out with nothing new added. |

The trail records the node's position once a frame, after scripts' `lateUpdate`, and ages its points by the World's time: pausing the game freezes a trail, `Time.timeScale` slows it. Its width curve and gradient run over each point's age (0 at the head, 1 at `lifetime`).

From scripts: `positionCount`, `getPosition(index)` (0 is the oldest; the last is the head), `getAge(index)`, `addPosition(point)`, and `clear()`, which you should call after teleporting a node so the trail doesn't streak across the jump. The history is game state, so it reads the same on a dedicated server or in a headless test World, where nothing draws.

A trail outside Play has no history, so it draws nothing in the scene view until you play.

## Performance

Each line or trail is one draw. Its ribbon is rebuilt on the CPU each frame from its points, so thousands of points per frame are fine, hundreds of thousands are not. Camera-facing ribbons are turned on the GPU, so extra cameras cost no extra CPU.

## Coming from Unity

- `TrailRenderer.time` is `lifetime` (every Myco Component already has a `time`, the World's clock).
- Colours are `color` × `colorGradient` and widths `width` × `widthCurve` (Unity's `widthMultiplier`), and a trail's curves run over age rather than length.
- There's no `numCornerVertices` limit beyond 16 per join or end, and no `shadowBias` or `generateLightingData`.

## Known limits

- Camera-facing ribbons don't cast shadows.
- Script `Material` values (`renderer.material` instances) aren't applied to line materials yet.
- A transparent ribbon sorts as a whole against other transparent meshes, so a long line crossing another transparent object can sort wrongly, as in Unity.
- No dashed lines or pixel-width lines yet.

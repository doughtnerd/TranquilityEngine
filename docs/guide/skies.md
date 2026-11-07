# Skies

Myco draws the sky and lights the scene from the World's `Environment` component (ADR 0053). Its `map` can be:

| Map | What it is |
| --- | --- |
| `.hdr`, `.exr`, `.png`, `.jpg` | An equirectangular photo (ADR 0053) |
| `.env`, `.dds` | A prefiltered cubemap exported by an IBL tool (ADR 0113) |
| `*.cubemap.json` | Six images, one per cube face (ADR 0113) |
| `*.sky.json` | A procedural sky you build in the editor (ADR 0112) |

## Procedural skies

Create one with **Create > Sky** in the Assets panel (pick a preset: Clear Day, Sunset, Overcast, Night or Simple
Gradient), then double-click it to open the **Sky** panel. Every change previews live and is saved to the file.
Set an Environment's `map` to the asset to use it in a scene; `samples/playground3d/scenes/skies.scene.json` is a
ready example, with all five presets in `skies/`.

The layers, top to bottom:

- **Sky**: `atmosphere` (physically based: Rayleigh scattering makes the blue and the red sunsets, Mie the haze
  around the sun) or `gradient` (zenith, horizon and ground colours with a sharpness).
- **Sun**: from a **time of day**, latitude and day of the year, or placed by hand (elevation and azimuth). North is
  the World's -Z axis, east +X; `northOffset` turns the compass.
- **Sun disc** and **Moon**: size in degrees, glow, colour, brightness. The moon is lit from the sun, so its phase
  follows where the two are; give it an image to wrap on the disc if you like.
- **Clouds**: up to two layers with coverage, density, scale, speed, wind direction, altitude and colour.
- **Stars**: density, brightness, twinkle, and an optional equirectangular Milky Way image. They turn with the time.
- **Horizon**: fades the horizon to the World's `Fog` colour (or the horizon colour without a Fog). A Fog with
  `affectsSkybox` also covers the whole sky by `skyboxFog`.
- **Exposure**, in stops.
- **Lighting**: `driveSunLight` points the World's main directional light along the sun (the moon at night) with
  the sunlight's colour; `bake` renders the sky to a cubemap for reflections and ambient light, every
  `rebakeHours` of game time and at most every `rebakeInterval` seconds while you edit; `bakeSize` is pixels per
  cube face.

The Environment's own fields still apply: `intensity` (lighting), `skybox` (draw the sky), `skyboxIntensity`,
`rotation` (turns the whole sky, sun included).

## Scripting

Add a **Sky** component anywhere in the World:

```ts
import { GameBehavior, Sky, behavior } from "myco";

@behavior("game.DayCycle")
export class DayCycle extends GameBehavior {
  start() {
    const sky = this.getComponent(Sky)!;
    sky.timeOfDay = 6;      // dawn
    sky.daySpeed = 0.1;     // an hour every 10 s of game time
  }
  update() {
    const sky = this.getComponent(Sky)!;
    if (sky.light.body === "moon") {
      // night: light the torches
    }
    sky.settings.clouds[0].coverage = 0.5 + 0.4 * Math.sin(this.world.time.time / 60);
  }
}
```

- `timeOfDay` (-1 follows the asset), `daySpeed`, `currentTime` (read-only).
- `settings`: the sky's layers as plain data, changed freely; `resetSettings()` goes back to the asset.
- `sunDirection`, `moonDirection`, `light` (`{ body, direction, color, intensity }`).
- `rebake()`: rebake the lighting on the next frame.

## Six-image cubemaps

```json
{ "format": "myco.cubemap@1", "px": "skies/right.png", "nx": "skies/left.png",
  "py": "skies/up.png", "ny": "skies/down.png", "pz": "skies/back.png", "nz": "skies/front.png" }
```

`px`/`nx` are +X/-X (east/west), `py`/`ny` up/down, `pz`/`nz` +Z/-Z (south/north). Tools disagree on face
orientation; if a seam shows, swap or rotate the files.

## Cost

- The live sky is one draw; in atmosphere mode it costs roughly 0.3–0.8 ms of GPU at 1080p on a mid-range desktop
  GPU when it fills the screen, and gradient mode about a tenth of that.
- A bake (128² per face by default) is six small draws, prefiltering and an asynchronous read-back: an estimated
  1–3 ms of GPU, about four times that at 256². See ADR 0112 for the budget.

## Known limits

- Single scattering: deep twilight is a little darker and less orange than real life; the night sky is a tint,
  not moonlit air.
- Clouds are a flat layer without shadows on the ground.
- A driven light's gizmo shows its authored rotation, not the sun's.
- KTX2 cubemaps aren't supported yet.

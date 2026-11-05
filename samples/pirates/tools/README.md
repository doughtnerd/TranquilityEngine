# King of Pirates asset generator

Procedural, replaceable placeholder assets. No npm dependencies (Node's `zlib` only).

```
node samples/pirates/tools/generate.mjs
```

Output goes to `samples/pirates/models/`, `textures/` and `audio/`. Everything is seeded (no clock, no `Math.random`), so a second run is byte-identical. Files no longer generated are removed from those folders, so don't hand-place assets there.

Files: `lib.mjs` (RNG, PNG and WAV encoders, OBJ mesh builder), `models.mjs`, `textures.mjs`, `audio.mjs`, `generate.mjs`.

## Conventions

- Y up, ships point along +Z, the water line is y = 0, 1 unit is about 1 m (a ship is about 4.2 long, 1.4 wide).
- Every OBJ uses `pirates.mtl` (shared; textures referenced as `../textures/x.png`), has UVs and flat normals, and splits into named objects (engine meshes) where parts need different handling.
- Budgets: ships under 3k triangles, props under 1k.
- Team colours: the ship's `Sails` object is its own mesh using the near-white `sail.png`, so tint its material, or swap in `sail_team0..7.png` (red, blue, green, yellow, purple, orange, teal, pink).
- Pickups lie flat (icon faces up) so they read from a top-down camera.

## Models (triangles)

| File | Tris | Objects | Notes |
| --- | ---: | --- | --- |
| `ship.obj` | 464 | `Hull`, `Sails` | hull, stern castle, bowsprit, 6 cannons, 2 masts, 4 sails, jib, pennant |
| `cannonball.obj` | 80 | `Cannonball` | 0.24 m sphere |
| `flag.obj` | 140 | `Buoy`, `Cloth` | red/white buoy, pole, skull flag |
| `powerup_wind.obj` | 76 | `Crate`, `Icon` | blue medallion with pinwheel fins |
| `powerup_ghost.obj` | 276 | `Crate`, `Icon` | purple medallion with scalloped rim |
| `powerup_storm.obj` | 92 | `Crate`, `Icon` | slate medallion with lightning spikes |
| `rock1.obj` .. `rock3.obj` | 64, 90, 142 | `Rock1..3` | boulder, flat reef, spire with stones |
| `island1.obj` | 300 | `Land`, `Palms` | about 5.6 m across, 2 palms |
| `island2.obj` | 466 | `Land`, `Palms`, `Stones` | about 8 by 5.4 m, 3 palms |
| `dock.obj` | 288 | `Dock` | 3 m pier piece, 1.2 m wide |
| `wreck.obj` | 213 | `Hull`, `Mast`, `Debris` | listing hull piece, snapped masts, planks, barrel |

## Textures (PNG, 128x128 RGBA)

`wood`, `sail`, `sail_team0..7`, `rock`, `sand`, `palm`, `flag`, `foam` (tileable, alpha, for scrolling over water), UI icons `icon_wind`, `icon_ghost`, `icon_storm`, `icon_cannon`, `icon_flag`. Wood, sail, rock, sand, palm and foam tile.

## Audio (WAV, mono 16-bit 22.05 kHz)

`cannon_fire`, `cannonball_splash`, `wood_crunch`, `thunder`, `powerup_pickup`, `flag_capture`, `ui_click`, and two seamless loops: `rain_loop` (4 s), `ocean_loop` (8 s).

## Checking

The engine's OBJ loader (three's `OBJLoader` + `MTLLoader` through `loadMeshes`) parses every model, with all materials and textures resolved; all meshes have positive signed volume (outward winding). There is no committed test: Vitest only includes `src/**/*.test.ts`.

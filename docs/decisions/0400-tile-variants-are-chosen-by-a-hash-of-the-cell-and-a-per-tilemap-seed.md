# 0400. Tile variants are chosen by a hash of the cell and a per-Tilemap seed

- **Status:** Accepted
- **Date:** 2026-11-24
- **Deciders:** Chris Carlson
- **Supersedes:** — (amends 0103)
- **Related:** 0103, 0289, 0392

## Context

ADR 0103 says auto-tiling re-picks the painted cells and their 8 neighbours, and that ties between equally fitting
terrain tiles "go by `weight` at random". Taken literally, each paint rolled a fresh `Math.random()` for every
terrain cell in the 3 × 3 neighbourhood (`runtime/autotile.ts`), so painting one cell reshuffled the variants of
neighbours whose shape had not changed, and the same strokes never painted the same map twice (review item Q4). The
random brush and `Tilemap.fillRect` with several ids also rolled `Math.random()` per cell.

The owner chose to follow Unity: deterministic placement. Unity's `RuleTile` random output picks a variant from the
cell position (a noise lookup), and LDtk's random rule output is seeded per rule with a "re-roll" button; neither
changes a placed variant while what the cell must look like stays the same.

## Decision

We will draw every variant choice from a hash of the cell and a seed stored on the Tilemap.

- **The seed** is the Tilemap component's `variantSeed` field (a number, default 0; hidden in the Inspector). It is
  per Tilemap, not per layer: one Re-roll covers the map, and the layer format (version 2, ADR 0392) is unchanged.
  Existing scenes read as seed 0.
- **The hash** is `cellRandom(seed, x, y, stream)` in `runtime/cellHash.ts`: a uniform number in [0, 1) from 32-bit
  integer mixing (MurmurHash3's finaliser), the same on every machine. `stream` separates the uses: auto-tiling draws
  from `TERRAIN_STREAM`, the random brush and `fillRect` from `RANDOM_BRUSH_STREAM`, so a scattered layer doesn't
  line up with the terrain variants under it.
- **Auto-tiling** keeps 0103's matching (most specific fitting pattern, the corner-cleared retry, the loose fallback).
  Among the equally best tiles it calls `pickWeighted` with that cell's hash as the one random number, so weights are
  honoured over many cells. A cell's choice depends only on its terrain's tiles, its neighbourhood and the seed: it
  keeps its variant until the shape it needs changes, and the same strokes on the same map always give the same map.
  `paintTerrain` (the module function) takes the seed instead of a random function.
- **Re-roll.** `Tilemap.retileTerrain(layer?)` (new, public) re-picks every terrain cell of a layer, or of every
  layer, for its neighbourhood as it is, with the current seed. The editor's **Re-roll variants** button (under the
  Tilemap's fields, next to Open Tile Palette) picks a new seed (`newSeed`), re-tiles, and writes `variantSeed` and
  `layers` as one undo step, "Re-roll tile variants". Scripts do the same by setting `variantSeed` and calling
  `retileTerrain()`.
- **The random brush and `fillRect` are deterministic too**, for the same reasons: painting the same cells with the
  same tiles gives the same picks, and a map rebuilt from the same strokes is the same map. A script that wants a
  different arrangement each run sets `variantSeed` first (from its own random source). Re-roll gives the random
  brush new picks for later strokes but cannot re-pick cells it painted before: cells store plain tile ids, so the
  map doesn't know which cells came from a random brush.

## Alternatives considered

- **Keep a neighbour's tile while it still fits best, roll only cells whose shape changed** (Q4 option b). It stops
  the reshuffle, but the map still depends on the order of strokes and on luck, and nothing can reproduce it; a
  re-roll would need a separate rule anyway. The hash gives the same "keeps its variant" without history.
- **A seed per layer** (in `TilemapLayerData`). Uncorrelated layers for free, but a layer format change and a
  Re-roll per layer; the stream already decorrelates terrains from scattered tiles, and two terrain layers with the
  same variant counts lining up has not been a problem in Unity, where the position alone decides.
- **Leave the random brush on `Math.random()`.** Tiled and Unity's random brush do roll each time. Rejected for one
  rule across every variant choice: "same strokes, same map" would otherwise hold for terrain only.

## Consequences

**Positive**
- Painting no longer reshuffles neighbours; maps are reproducible from their strokes and seed.
- One seed and one button control every variant choice; weights still decide the mix.

**Negative / costs**
- Repainting a random-brush cell gives the same tile; to get another, re-roll the seed or pick the tile.
- `fillRect` with several ids no longer varies between runs unless the script sets `variantSeed`.
- The hash and its constants are now part of what a seed means: changing `cellRandom` would change what
  future re-tiles pick (stored cells stay as they are, since cells store tile ids).

## Deprecates

The `random` parameter of `paintTerrain` in `runtime/autotile.ts` (replaced by `seed`). `pickTerrainTile` keeps its
`random` parameter; callers pass the cell's hash.

## Open questions

None.

## References

- Review item Q4 (round 3 owner decision: follow Unity, deterministic placement).
- Unity 2D Tilemap Extras, `RuleTile` output "Random" (position-based noise); LDtk auto-layer rules' random seed and
  re-roll.

# 0161. `Assets` caches path lookups and sidecars behind a generation that sources bump when they change

- **Status:** Proposed
- **Date:** 2026-11-10
- **Deciders:** Chris Carlson
- **Supersedes:** —
- **Related:** 0015 (assets through `import.meta.glob`), 0040 (import settings sidecars), 0115 (per-platform import settings), 0158 (audio events; the M2 bench found this cost)

## Context

`Assets` (`src/engine/scene/Assets.ts`) resolves every lookup from scratch. `Assets.get`/`url`/`has` run `normalizeAssetPath` (two regex replaces) and walk the source list calling `has` then `get`; `Assets.importSettings` goes through `sidecarValue`, which runs `splitSpriteRef` (two more regex replaces and an `indexOf`), builds the sidecar path string with `sidecarPath`, and walks the sources again. Parsed sidecars are already cached (`parsedSidecars`, a `WeakMap` keyed by the raw JSON object, so an edited sidecar is re-parsed), but the path work and the source walk are not.

The audio M2 bench measured this at ≈ 0.35 µs per voice start on the core (two lookups per clip: its URL and its sidecar), the largest single cost left in `Audio.play` after M2's follow-ups (m2-decisions entry 23), and roughly 1 µs of a three-clip layered event. Any per-frame or per-spawn caller (sprites, particles, prefab instancing, audio) pays the same.

Nothing can be cached today because sources can change without telling anyone: the editor's project sources are mutable maps (`MapProject.writeText` replaces an entry; renames and deletes remove one), and `addSource`/`removeSource`/`clearSources` reorder the list. A cache needs to know when its answers might be stale.

## Decision (proposed)

We would add a **generation** to `Assets`, bumped whenever any answer could change, and cache lookups against it:

1. **Change signal.** `AssetSource` gains an optional `subscribe?(onChange: (path?: string) => void): () => void`. A source that can change (the editor's project maps, a hot-reload source) calls `onChange` after it adds, replaces, renames or deletes an entry, with the path when it knows it. Static sources (`fromGlob`, `fromObject`, an exported game's bundle) don't implement it and never invalidate. `addSource`, `removeSource` and `clearSources` subscribe or unsubscribe and bump the generation themselves.
2. **Generation.** One integer in `Assets.ts`, incremented on every change signal. (A path-scoped invalidation is possible later; one global counter is simpler and changes are rare next to lookups.)
3. **Caches**, each entry stamped with the generation it was computed at and recomputed when the stamp is stale:
   - raw path → normalised path (pure; never stale, so a plain bounded `Map`);
   - normalised path → `{ source index, value }` for `get`/`url`/`has`;
   - path → sidecar raw JSON (`sidecarValue`), so `importSettings` reaches its existing `parsedSidecars` cache without the path work.
   The resolved-per-platform cache keeps working unchanged (it keys on the parsed object).
4. **Bounds.** The maps are capped (e.g. 4,096 entries, cleared when full); a game's working set of asset paths is far smaller.
5. **Behaviour is unchanged:** same answers, same errors for a missing asset, a sidecar edit still re-parses. Only the cost moves: a repeat lookup becomes two map reads and a generation compare.

## Alternatives considered

- **A `version` number on each source, summed per lookup.** No subscription to manage, but every lookup walks the sources to sum versions, which is most of today's cost.
- **Cache per caller** (the audio runtime keeps its own clip → URL and sidecar maps). Fastest for audio, but each subsystem re-solves invalidation, and the editor's sidecar edits would need wiring into each.
- **Never cache; make normalisation cheaper** (string checks instead of regexes). Worth doing anyway, but leaves the source walk and the sidecar path build.
- **Invalidate on a timer or per frame.** Wrong answers in between, or a cost every frame.

## Consequences

**Positive**
- Repeat lookups become map reads: the audio play path loses ≈ 0.35 µs per voice; sprites, particles and prefab spawns gain the same.
- One invalidation rule for every caller.

**Negative / costs**
- Mutable sources must call `onChange`; a source that forgets serves stale answers until the next generation bump. The editor's project sources and any hot-reload source need it, with a test that a write is seen.
- A small amount of memory for the caches.
- `AssetSource` grows an optional member (additive; existing sources keep working uncached-but-correct only if they're static).

## Deprecates

Nothing.

## Open questions

- Path-scoped invalidation (bump only entries under a changed path) if editor writes turn out frequent enough to matter.
- Whether `normalizeAssetPath`'s regexes should become string checks regardless.

## References

- `src/engine/scene/Assets.ts`, `src/engine/scene/importSettings.ts` (`sidecarPath`, `splitSpriteRef`); the editor's project sources (`MapProject`).
- `docs/design/0157-audio-core/m2-decisions.md` entry 23 (the measurement).

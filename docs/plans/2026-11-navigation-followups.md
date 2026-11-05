# Navigation follow-ups (November 2026)

Gaps left after the built-in navigation port ([ADR 0065](../decisions/0065-built-in-navigation-foxfire-port.md)), W0–W7, as of 2026-11-04. This list is only Myco's own work: the WASM boundary, the engine and editor integration, the file format, and the sample.

Issues that come from Foxfire's C# are handled separately. They will be fixed in Unity first, and the port then matched to those changes. They're listed in Skybreaker's `Packages/com.foxfire.navigation/Documentation~/Myco port findings.md`.

## Runtime and boundary

- [ ] **Merged groups.** A group absorbed by a merge keeps its body agent "following" without moving. Disable or remove it the way Foxfire disables the merged group (`NavGroupMergeSystem`), and let `NavGroup` report that it merged.
- [ ] **Counters.** `tickStats` reports only agents, paused, commands and chunk flags. Add the per-tick time, path searches, slices and graph and overlay rebuilds, so the counters panel shows them.
- [ ] **Bake stage timings are 0 in WASM** (there's no clock). Pass `performance.now` in as an import, or time the stages from TS.
- [ ] **One-shot queries:**
  - `findPath` crosses chunks only after a tick has built the route graphs.
  - Flight and hybrid one-shot paths stay within the chunk that holds the start.
- [ ] **Overlays build synchronously** in the tick that needs them. The plan/collect split is kept, so they can move to a worker.
- [ ] **Removing a NavGate** leaves its gate as it was last set. On detach, restore the bake's starting state.
- [ ] **Per-step allocation:** `NavAgent.areaCosts` is turned into JSON every step for agents that have costs. Compare against a version counter instead.

## Bake file and assets

- [ ] **Flight volumes are large on disk:** 1.1–2.2 MB per 128 m chunk, of which the volume is about 95%, and about 10× smaller gzipped. Options:
  - compress the sections inside `myco.nav@1` (`DecompressionStream` in browsers, zlib in Node);
  - or a sparser base grid, if Foxfire changes its layout.
- [ ] **Several NavChunks in one scene** write `<scene>.<id>.nav.bin` for every chunk after the first. Decide whether that's the rule or whether one scene means one chunk.
- [ ] **Chunks inside prefab instances** bake with the outer scene's path. Decide the prefab-chunk story: per prefab asset or per instance.
- [ ] **Bake All** rewrites unopened scenes with `JSON.stringify` when it fills in a `bake` field, which loses their formatting. Use the format-preserving writer the Project panel uses.
- [ ] **Stale-bake records** live in `.myco/nav/` (gitignored), so whether a bake is out of date is known only on the machine that baked it. Consider keeping the input signature in the bake file and comparing against that.
- [ ] **Engine library consumers** must ship `myco_nav_bg.wasm` beside the bundle (`dist/engine/`). Document this where the library build is described.

## Editor

- [ ] **Dropdown labels.** Agent type and area dropdowns show ids, because `choices` can only return values. Add `{label, value}` choices to `registry.ts` and use names.
- [ ] **Edit-mode overlay:**
  - It doesn't draw landing links. Add a `debugBakeLandingLinks(bytes, walk, fly)` free function.
  - A bake rewritten at the same URL is picked up only when the document or URL changes.
- [ ] **Agent group selection.** The overlay's "Agent group" picks by position in the project's agent types (resolved through the bake's agent table). Store the agent type id instead, so reordering types doesn't change the selection.
- [ ] **Sample in edit mode.** Opening the navigation sample's main scene shows almost nothing, because the geometry is in the chunk scenes. Either open the chunks alongside it in edit mode, or add a preview ground.
- [ ] **Visual check of the sample:** camera framing, HUD readability, storm transparency, the terrain's normals, agent sizes against their pivots, the barrier lifting, and walker group pace (about 2.5 m/s against walkers' 6 m/s).

## Code health

- [ ] **Raycast duplication.** `nav-query/src/raycast.rs` (Myco's addition) has private frame, unfold and polygon helpers that duplicate `straight_path.rs` and `surface.rs`. Merge them.
- [ ] **Clippy warnings** remain in `nav-recast`, `nav-query`, `nav-bake`, `nav-math` and `nav-format` (about 57). `nav-wasm` and `nav-crowd` are clean.
- [ ] **Multiplayer.** Navigation runs only in authoritative Worlds, and clients see agents through replication. Client-side prediction of agents isn't designed.

## Waiting on Skybreaker

- [ ] **xxHash3 test vectors from Unity**, to confirm chunk ids and fingerprints match Unity's exactly. So far only the empty-input vector is checked.
- [ ] **Match the port to Foxfire's fixes** once they land in Unity: the corner trap, seam reporting, default coverage, DotRecast guards, and the rest of the findings note.

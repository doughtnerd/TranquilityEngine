# RFC 0162 review: senior engineer

**Verdict: approve with changes.** The spikes are good evidence and the split (core continuous, main budgeted) follows 0157/0158. But the record is written as one 17-week milestone, and its authoring model (occluders and zones as physics-layer components) does not fit the physics plugin as built.

Top 3 concerns:
1. **`AudioOccluder` as "a collider on a layer" does not work** with the physics plugin: one layer per collider, a collision matrix, 3D only.
2. **Defaults silently change existing projects** (HRTF 16 to 8, occlusion default on, bed on) with no flag or migration, and the budget rests on container p50/p99 where 0157's gate is p99.9.
3. **M3 is too big to be one milestone.** Split into four shippable steps, the first behind no new project surface.

## Issues

1. **blocking: occluder layer model.** `Collider.layer` is a single string from `physics.layers` (`src/plugins/physics/runtime/Collider.ts:21`; project default `["Default"]`, `src/engine/core/settings.ts:126`). A level wall already has a gameplay layer, so it cannot also be on `AudioOccluder`. A new layer with no `collisionMatrix` entry collides with every layer (`physicsSettingsModel.ts:79`), so the occluder would physically block the player. The record also never says which project setting gets the layer added. Change: `AudioOccluder` owns its own collider (a trigger/sensor on the reserved layer), added as a hidden child, or the record names the physics change needed (multi-layer membership or query tags). State the layer is reserved and injected by `parseSettings`, excluded from the collision matrix, and verify rays hit sensors in Rapier (the spike's scene used plain colliders, `occlusion/README.md` "Method").
2. **blocking: physics 2D and service start.** Occlusion goes through `myco.physics3d` (ADR 0135 service); `Physics2D.raycast` is a different service (`Physics2D.ts:57`). The flappy sample and every 2D game have no 3D service, and audio has no way to start it (0135: started when a scene contains a component that needs it). Change: say M3 occlusion is 3D-only (with `AudioOccluder` declaring it needs `physics3d`), or add `AudioOccluder2D`. A source or zone with no occluder in the World must cost zero rays.
3. **major: behaviour change for existing projects.** `voices.hrtf` defaults to 16 (`settings.ts:101`, range 0..32, line 115); presets are bundles the editor offers while the file stores numbers (api-and-models:130). Changing "the high preset" does not change stored numbers, but changing `DEFAULT_VOICES` retunes every project with no key. The bed also changes the sound of every distant voice, and `AudioSource.occlusion` "default on" adds rays for every spatial source. Change: `audio.spatial` gains `"hrtf+bed"` or a new `audio.bed: boolean`, default off until the listening pass; default stays 16 until then; occlusion is a no-op without occluders.
4. **major: budget evidence is the wrong percentile.** 0157's budget is p99.9 (0157:193); the record's 0.21 ms is built from p50/p99 on a shared container (README spikes, "Performance targets"). Architecture §6.2 (line 674) says the lab VM's high preset already averages 9.4 ms per 4-quantum burst against a 7.5 ms limit, and the design README (line 67) calls the reserve spent. 0.21 ms is 8% of a quantum added to a preset that already misses. Change: do not raise the high total in the record; make "M3 on" a preset (`high+spatial`) until the lab-VM run exists, and gate acceptance on E5.5's run.
5. **major: record's wire changes are under-specified.** `panner` is 2 bits (`batch.rs:22`), so kind 2 fits, but ambisonic clips need a voice-kind bit (no position, rotated, 16 channels) and PLAY's flags are 16-bit with bits 0-6 used. Occlusion gain and `lpHz` already exist in SET_PARAMS (`batch.rs:28-37`); the "≈100 ms core smoothing" and Doppler pitch smoothing are not fields. LISTENER (0x20) payload is empty in the schema (`batch.rs:316-321`, test at 408). Zone weights and sends have no opcode. Change: add a wire table to the record (opcodes, bit allocations, ABI 1.x to 2.0 decision, schema hash regeneration per `wire.schemaHash.test.ts`).
6. **major: event `filter` overlaps existing `lowpass`.** Event automation already targets `volume | pitch | lowpass` with "lowest wins" (`eventFormat.ts:78-80`); per-voice low-pass exists but applies only to voices with a binding (build log, E2). The record adds a second, unconnected `filter` key. Change: extend `EVENT_TARGETS` with `highpass` and `reverbSend`, or define `filter` as the static default of the same target; say whether the one-filter-per-`group` costs a new core table.
7. **major: ambisonic clip identity.** A 4-channel WAV is also quad. The record has a "sidecar flag" only for FuMa (0040 import settings, `Assets.importSettings`, `Assets.ts:97`). Change: sidecar `ambisonic: { order?, convention: "ambix" | "fuma" }`, required for any clip over 2 channels; an `AudioSource` of such a clip ignores `spatial`. State whether 16-channel clips go through `audio-decode`'s C ABI (spike lists it unverified).
8. **major: Doppler inputs missing.** Velocity from position deltas needs the listener's velocity too, and teleports and camera cuts give spikes. Change: listener velocity from `AudioListener`, a per-frame max-speed clamp and a reset on teleport (large delta), `Audio.setListenerVelocity` or `AudioListener.dopplerEnabled`.
9. **minor: Babylon fallback ambisonic.** "Truncated to 1st order" means W,Y only, which is not a rotation by listener yaw. Say the fallback plays W as mono or does yaw rotation of X/Y on main.
10. **minor: zone IR asset kind.** Needs a 0143 entry (`audioIR` or an `audio` import setting `ir: true`), not just "a stereo WAV".
11. **minor: bus `reverb` effect vs zones.** `BusEffect.reverb` sends to "the shared reverb return" (`settings.ts:29-30`). Say what happens to it when zones exist (replaced, or the fallback return when no zone is active).

## API

- **`AudioSource` today:** `spatial: boolean`, `minDistance`, `maxDistance`, `rolloff`, `output`, `priority` (`AudioSource.ts:66-77`). Proposed `occlusion`, `dopplerLevel`, and an implied `reverbSend` follow no stated scheme. Suggest: `occlusion: boolean` (default true, but inert without occluders), `dopplerLevel: number` (0..2, default 1), `reverbSend: number` (0..1, default 1, the amount into whatever zones are active). `speedOfSound` in `audio.*` is fine; add `audio.occlusion.budgetMs` as a number clamped 0.05..2 and `audio.bed: boolean`, `audio.zones.max`.
- **Events:** the `spatial` object (`eventFormat.ts:10`, 456-462) is where `occlusion`, `dopplerLevel`, `reverbSend` belong, not new top-level keys. The record's "event-level `occlusion` flag" has no location. `sends: { reverb, <bus names> }` mixes a fixed key with user bus names; use `reverbSend: n` plus `sends: [{ bus, level }]`. Both are additive under `@1`: lenient parser (`eventFormat.ts` header) already drops unknown keys, so an older engine reading a new file loses filters silently; say so.
- **`AudioReverbZone`:** `shape` (box|sphere), `size`/`radius`, `ir` (AssetRef kind audioIR, or a preset name), `wet` (dB or linear: pick one, buses use linear 0..2), `blendDistance`, `priority` (for the 2-zone cap), `bus` filter? Also a way to set a zone from script: `AudioReverbZone.enabled` is enough.
- **`AudioOccluder`:** `material` (choices from a table), plus optional `transmissionDb` and `cutoffHz` overrides; the material table must be a data file, not code.
- **Script surface:** nothing for one-shots. Add `OneShotOptions.occlusion` and `dopplerLevel`; `Audio.debug()` gains zones, bed voices, rays used. `AudioDebugInfo` is a public type, so a field list is an API change (0157 versioning).

## Milestones and estimates

M2's record said ≈ 11 person-weeks (0158:169); the build log records no actual person-weeks, only a 37.5 task-day plan for the remainder and agent-built waves done inside two calendar days (`build-log.md:506-577`). M1 was sold as 31 person-weeks (0157:168). By that evidence the record's 13 + 4 weeks is plausible for engineer-time but un-trackable. Split:

| Step | Content | Weeks | Flag |
|---|---|---|---|
| M3a | Wire (LISTENER, kind 2, clip arena to 16 ch), bed + MagLS asset, HRTF-to-bed crossfade, listening pass | 4 | `audio.bed` (off by default) |
| M3b | Ambisonic clips, sidecar, decode path, Babylon fallback | 2.5 | same flag; clips only play when on |
| M3c | Reverb zones: IR prep in decoder worker, zone planner, sends, event `filter`/`sends` | 5 | `audio.zones` |
| M3d | Occlusion + Doppler (main-side only: no core change except smoothing) | 3 | `audio.occlusion` |
| Editor | Components, gizmos, debug views (spread over c and d) | 4 | none |
| Reserve (10%, as 0157) | | 1.9 | |

About 20 person-weeks, 4 more than the record because of testing and tooling. M3d can ship first (no wasm change, if gain/lpHz suffice) and is the cheapest user-visible win. Tests to add: golden scenes for bed and zones (the metered build, `check:audio-metered`), a parity test for the MagLS table (Rust vs TS), a Playwright spec for zone gizmos, schema-hash and round-trip vectors, and the ray-budget bench under the real `audioSystem.ts`.

## Conflicts

- **0157:** amends "spatial (M3) is a separate lazy module" (line 213) and the high preset total; the record has these. Missing: it silently changes the `hrtf` default (point 3) and the "HRTF for the nearest 16" statement (0157:161).
- **0158:** `myco.audioevent@1` stays `@1` but gains keys; 0158's lenient parse makes that safe for parsing, not for behaviour.
- **0074:** adds fields to `AudioSource`; fine. `Audio.playOneShot` options are unmentioned.
- **0135/0133:** audio depends on physics only through an optional service; the record must not make audio hard-depend on `myco.physics`.
- **0143:** IR needs an asset kind or import setting.
- **0161 (Proposed):** zone IR and clip lookups should use its cache if accepted; note the dependency or its absence.
- **Plugin boundary:** the zone and occluder gizmos must go through `src/editor/sdk` (`plugins.test.ts`, build log lesson 3), like the audio plugin's existing registrations (`src/plugins/audio/editor/index.ts:27-80`); the audio plugin has no gizmo or component-inspector contribution yet, so check the SDK has one (a possible hidden SDK task).

## Cheaper alternatives

- **Occlusion without a physics layer:** raycast all layers once per source and treat any hit as occluded, with a default material, for the first release; `AudioOccluder` becomes an optional material override on a node's existing collider (look up by collider's node, no extra colliders).
- **Doppler on main only:** pitch is already a per-voice parameter (`SET_PARAMS` mask bit 1, ramped per frame in E2), so Doppler needs no core work at all.
- **Zones as bus sends first:** one reverb zone per scene via the existing bus convolver, switched by a trigger and automated by a global parameter (0158), with the IR preparation problem avoided by loading on scene load. Real zones follow.
- **Bed at 1st or 2nd order for phones** only if the lab/phone run says so; do not lower the default on the spike evidence.

## Questions for the author

1. Which collider carries the `AudioOccluder`, and how does it avoid blocking gameplay (sensor, matrix, hidden child)?
2. Is M3 occlusion 3D-only? What does a 2D game get?
3. Is the bed off until the listening pass, and what happens to existing projects' `voices.hrtf`?
4. Does the 0.21 ms hold at p99.9 on the lab VM, and which preset is "high" when the total already misses the 7.5 ms burst rule?
5. What are the opcodes and flag bits for zones, sends, listener and ambisonic voices, and is that an ABI major bump?
6. How are ambisonic clips identified (sidecar vs channel count), and do 16-channel files pass `audio-decode`?
7. Does `filter` replace or extend the event `lowpass` automation target?
8. Who owns IR preparation in the decoder worker (a new decoder-ABI entry point, hence a rebuild of the 1 MB decoder wasm)?

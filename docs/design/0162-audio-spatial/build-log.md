# Spatial audio M3: build log

The coordinator's log of each wave review ([waves plan, "Wave reviews"](../../plans/2026-11-audio-spatial-m3-waves.md#wave-reviews)): what landed, the numbers measured, deviations from the design, decisions taken while the owner was away, and reserve days used. Tickets are GitHub issues #112–#163. Work merges into the M3 integration branch, and each milestone goes to master only with the owner's approval.

**Integration branch:** `claude/inspiring-euler-5qf03k` on origin (this build session may push only that branch; locally it's also called `claude/audio-spatial-m3`). It started at `origin/master` `918171a`.

## For the owner (summary, newest first)

The owner asked (2026-11-11, evening): "Go through each of the waves as instructed until the milestone is complete. If any decisions need to be made, use your judgement … and I will review everything in the morning." The coordinator reads that together with the earlier standing rules, which it keeps: **no merge to master, no draw on the 14-day reserve and no default change outside the plan's flips without the owner.** Milestones are left ready on the integration branch, with their checks run, as proposals.

**Needs you:**
- Merges to master as each milestone becomes ready (none yet).

**Decisions taken (each with its revert):** see "Decisions" below, D1 onwards.

## Decisions

Numbered; superseded entries are marked, not rewritten.

- **D1 (W0) master's `./eventTree` imports.** `918171a` ("Fixed bad imports") merged `eventTree.ts` into `EventTree.tsx`, but 11 imports still say `./eventTree`. They resolve on a case-insensitive filesystem (macOS) and fail on Linux: typecheck, the build and five test files failed at baseline. Fixed on the integration branch (`76bbec4`) by importing `./EventTree`. *Revert:* `git revert 76bbec4` (only if the file is renamed back instead).
- **D2 (W1, A6a) unknown `occlusion.defaultMaterial` falls back to `concrete`.** §2.1 says "the first plus problem", and the first material is `none`, which would silently turn occlusion off for a typo. The fallback is the key's own default (`concrete`), as every other §2.1 key falls back to its default; if `concrete` was removed from the table, the first material. *Revert:* one line in `resolveDefaultMaterial` (`occlusionMaterials.ts`).
- **D3 (W1, D0) D0 edited physics files outside its list.** `backend.ts`, `core/PhysicsWorld3D.ts` and `physics-rapier/runtime/rapier3d.ts`: Rapier's predicate filter lives in the backend plugin and the collider-to-node map in the shared core, so the query can't exclude nodes inside the listed files alone. Accepted (no audio file touched, boundary test green). Design names to update at write-back: `groupsFor` is `rayGroupsFor(world, layers?)` (undefined for every layer), `excludeNodes` a `ReadonlySet<GameObject>`.
- **D5 (W1, D2b → D2a) wet occlusion across several walls multiplies.** Architecture §3.2 gives the wet factor for one material, `1 − (1 − occGain)·wetOcclusion`. With several hits on one ray, the wet factor is the **product of each hit's own factor**, so each wall takes its share of the reverb (D2b's accumulator combined `w` as `1 − Π(1 − w)`, which over-darkens the wet path behind two walls). D2a applies it in `occlusionMath.ts` (noted on #144). *Revert:* D2a's wet-folding function.
- **D6 (W1, E6) the ambisonic block lives in `AudioImportSettings.tsx`**, the audio kind's import view (ADR 0143), not `AssetInspector.tsx` (a generic shell). §7/§10's file name to correct at write-back.
- **D7 (W1, B2) decoder facts and the FuMa gain.** Symphonia already decodes 4/5/9/16-channel WAV, so "the limit 2 → 16" is a refusal of every count but 1, 2, 4, 9, 16. FuMa's largest factor is √2 (W) at orders 1–3, so §2.4's "keep f32 when the factor exceeds 4" never triggers (implemented and tested anyway). New export `myco_decode_set_convention` (decoder ABI 0x102; **C2a moves to 0x103**, since §10 gave it 0x102 too). The import gain √2 reaches main as `ClipInfo.importGain` and is folded into `clipVolume` and the event clip starter by the coordinator (`AudioSource.ts`, `dc368047` glue commit). Until B3, a clip over 2 channels plays its W channel on both outputs; a *spatial* plain voice on one pans W with the stereo law (louder than mono): a one-line fix at `voices.rs:1005`, left to B3 (#129). Grants: `protocol.ts` (`ClipInfo.importGain`), `clipRegistry.ts` (the gain map), `streams.test.ts` (a 3-channel fixture became 4).
- **D8 (W1, C1) no core call-site change.** The shared reverb runs on `prepare_ir` + one instance with the same facade signatures and the same region size (kernel → state → scratch); an instance with no tail partitions adds no planner load (the spike counted transforms).
- **D9 (W1, coordinator) `AudioOccluder` registered and exported** (`runtime/index.ts`, `src/myco.ts`): public per §1.5.
- **D10 (W1, A1/K1) wire details.** STATUS `zoneSlots` is a u16 at 128 with a reserved u16 at 130 (the design gave the `zones` section no count); zone state 5 (evicting, from C5/C7) is in `ZoneState`; extra constants `ZONE_HEAD_BINS`, `ZONE_TAIL_BINS`, `ZONE_KERNEL_MAX_HEAD_PARTS`, `MAGLS_TAPS_HIGH_RATE`, `STREAM_WIDE_CHUNK_FRAMES`, `STREAM_MAX_CHANNELS`. The generator gained counted padded arrays, per-group caps (MALFORMED on read, OVERSIZE on write) and blob headers. L-A1a found that the generated `StatusBlock::read` panics on a body under 128 B; A1 fixes it in K2 (a reader must refuse, never panic).
- **D4 (W1, B1) B1 edited `decoder/decoderClient.ts` and `decoder/handler.ts`** (a few lines each) to carry `convention` from the registry to `decoder/clips.ts`; nothing else owns them in W1 (B4 takes `handler.ts` in W3). Accepted.

## Wave 0 (2026-11-11, base `origin/master` `918171a`)

**Baseline** (clean `918171a`, before any M3 change):
- `npm ci`: ok.
- `npm run typecheck`: **fails** (the `./eventTree` imports, D1). After D1: green.
- `npm test`: 6 files failed. Five are the `./eventTree` imports (green after D1); `piratesSample.test.ts` timed out (a known flake). After D1 and K0: 416 of 417 files passed, 4,343 tests; `navigation.test.ts` failed once in the full run and passed alone (flake, added to the list).
- `npm run build`: failed at its typecheck step (D1); green after D1 and K0.
- `cargo test` in `native/audio/`: green.
- `npm run check:audio-metered`: pass (every scene within ±1.6%; `all` −0.22%).
- `npm run test:e2e`: not run at W0 (it changes no decision before the first wave end; first run at the W1 wave end). Known from master: `selection.spec.ts:77`.
- Rust toolchain as `native/audio/rust-toolchain.toml`; `wasm-opt` not installed. Clippy not installed.

**Known flakes** (rerun alone once before treating as a failure): navSample, selectionBench, server.test, piratesSample, hrtfLoopback, streamRebuild, gltf.test, e2e codefiles, audio-core.spec beside other specs (from the plan), plus `navigation.test.ts` (seen at W0).

**Landed**
- D1 import fix (`76bbec4`).
- **K0** (`f331840`, #162): `backend.ts` gains every M3 `PlayRequest` field (all optional), `AudioVoice.setVelocity?`/`setOcclusion?`/`setDopplerRate?`, `AudioPanner`, `SendCurve`, `DEFAULT_SEND_CURVE`, the `AudioDebugInfo` additions (`beds`, `zones`, `occlusion`, `memory`, the §1.6 and C24 counters, bus and voice columns) and the `ZoneIrService` interface. `decoder/protocol.ts` gains `prepareIr`, `generateIr`, `releaseIr`, `irPrepared`, `irFailed` (C9), and `convention` on `decodeClip` and `streamOpen`; `handler.ts` routes the IR messages to the new stub `decoder/irPrepare.ts` (it refuses until C2b). Additions beyond the plan's text: `releaseIr` (the service's `release` needs a message), `convention` on `decodeClip` (B1 passes it; the plan has it on streams only), `ZoneIrService.reprepareAll?` (architecture §2.2 rate change). Typecheck and decoder tests green.

## Wave 1 (pilot)

Leads started 2026-11-11: A1 (+K1/K2) strongest; A6a + C6, B1, D0 mid; after A1's first commit (`20781e6`, merged as `88cf6b6`), B2 and C1 strongest.

**Merged so far**
- A1 phase 1 (`88cf6b6`): `InitParams` gains `max_beds`, `max_zone_slots`, `zone_max_frames`, `max_wide` and a `Default` (48 kHz, 4,096 logical, 128 mixed, 32 buses, 16 MiB arena; M3 regions 0); every literal uses `..InitParams::default()`; the twelve new modules declared as doc-comment files.
- B1 (`a84b427`, #127): `ambisonic` sidecar key, the §2.4 registry rules, `convention` carried to `decoder/clips.ts` (B2 applies it). Not split (the lead judged the brief would cost as much as the work).
- D0 (`1774eef`, #142): `raycastInto` and `rayGroupsFor` in `worldServices.ts`; 3D physics and Rapier implement them with node exclusion inside the query, sensors and layers filtered, no allocation in engine code (Rapier's own `castRay` allocates a hit wrapper internally); a structural allocation test.

- E6 (`b9dfe29`, #157; wave 2, started early): the Asset Inspector's ambisonic block (D6), writes only non-default keys.
- A6a + C6 (#124, #140): every §2.1 key parsed and inert, bus `bed`/`bedPriority` resolved by helpers, `zones.standby` and the slot memory accounting (1.7 / 9.2 / 18.1 MB), the §2.2 material table and parse (D2). Two leaves, both first pass.
- D2b (#145; wave 2, started early): `AudioOccluder`, `nearestOccluder`, material compile/combine/cache, `occlusionNote` (D5, D9).
- K1 (`5cd9c17`, A1's second merge): the whole M3 wire (D10).
- B2 (#128): 16-channel clips through the arena and decoder, `lagrange_n`, FuMa → AmbiX before int16 rounding (D7). Two leaves, both first pass.
- Wasm rebuilt once after K1 and B2 (`3301bcc`): **mixer 178,598 → 190,026 B** (230 KB warning, 256 KB gate), decoder 749,095 → 751,489 B (900 KB), AAC decoder 1,075,734 B (1,280 KB). Metered gate passes (all −0.09%), baseline unchanged. All 110 audio test files pass on the rebuilt wasm.

**Leaf first-pass results so far:** L-A6a, L-A6b, L-B2a, L-B2b, L-A1a, L-A1b, L-A1c first pass; L-C1a (the stagger planner port) failed: a debug-mode test search ran for over 12 minutes and never finished; its work was saved as WIP and C1's lead took it back. B1, D0, D2b and E6 leads judged their leaves not worth splitting and did them.

**Lessons for later briefs**
- Leads used their own session's attribution trailer, not the one in the brief: fine (it names the model that did the work). Briefs now say "use your session's trailer".
- Concurrent vitest runs collide on `node_modules/.vitest-cache` (ENOTEMPTY); a rerun passes.

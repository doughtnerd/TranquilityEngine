# Spatial audio M3: build log

The coordinator's log of each wave review ([waves plan, "Wave reviews"](../../plans/2026-11-audio-spatial-m3-waves.md#wave-reviews)): what landed, the numbers measured, deviations from the design, decisions taken while the owner was away, and reserve days used. Tickets are GitHub issues #112–#163. Work merges into the M3 integration branch, and each milestone goes to master only with the owner's approval.

**Integration branch:** `claude/inspiring-euler-5qf03k` on origin (this build session may push only that branch; locally it's also called `claude/audio-spatial-m3`). It started at `origin/master` `918171a`.

## For the owner (summary, newest first)

The owner asked (2026-11-11, evening): "Go through each of the waves as instructed until the milestone is complete. If any decisions need to be made, use your judgement … and I will review everything in the morning." The coordinator reads that together with the earlier standing rules, which it keeps: **no merge to master, no draw on the 14-day reserve and no default change outside the plan's flips without the owner.** Milestones are left ready on the integration branch, with their checks run, as proposals.

**Needs you:**
- Merges to master as each milestone becomes ready (none yet; M3a is due after W4).
- **Review D11** (the zone stagger planner was redesigned because the spike's search took 20–300 ms on the audio thread; the bounded one keeps 95% of the spike's balancing). Options to trade back quality are listed there.
- **Review the A3 numbers** (W2 section): the MagLS ILD check passes by 0.01 dB in the 1–2 kHz band, and the HRIR set has nothing below −45° elevation, which makes the floor-below listening item (reserve R1, SADIE II) the likeliest reserve draw at M3a.
- **Mixer size** is at 79% of its 256 KB gate (203,040 B); the 230 KB warning is likely in W3–W4. Options in "Budgets".

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
- **D11 (W1, C1) the zone stagger planner is bounded.** The spike's planner searched 20,000 nodes per cap step; in release it took 20–300 ms per plan (mean 56 ms; the design estimated ≤ 50 µs, but the spike never timed it). It runs on the audio thread when a zone slot starts, so this was a design bug. C1's lead redesigned it (bisection, a 32-node budget, pruning, local search, a sequential fallback): ≈ 65 µs mean / 0.2 ms max native, never worse than sequential, **95% of the spike's modelled reduction** (4 × 2 s peak 2.57 against the spike's 2.43 and sequential 4.71). Chosen because the render path must never do unbounded work (every engine and middleware keeps it so). *Owner options:* `NODE_BUDGET` 128 (mean 2.25, ≈ 0.6 ms worst), or the full search in the decoder worker with the phase sent in ZONE_CONFIG (a wire change). *Revert:* `NODE_BUDGET` in `audio-dsp/src/convolver/stagger.rs`.
- **D12 (W2, D1) SET_VOICE_FX applies on arrival**, not at its stamped frame: `scheduler.rs` is frozen after K2 and its pending record (7 f32) can't hold SET_VOICE_FX's 10 fields. Effect: a stamped ramp on a voice already playing starts up to one lookahead early; a record for a voice not yet started still lands right. *Revert:* route SET_VOICE_FX through the pending queue (a scheduler change).
- **D13 (W2, D1) a filter update moves the cutoff at most one octave.** The leaf's click test failed for an 8-octave high-pass sweep in 128 frames (2.20× the input's largest step against the 2× bound). D1 stretches large sweeps so each 32-frame coefficient update moves ≤ 1 octave (`MAX_UPDATE_OCTAVES`): now 1.23× (low-pass) and 1.12× (high-pass). Bound kept, not loosened. *Revert:* the constant in `fxfilter.rs`.
- **D14 (W2, D1) `VoiceSlot.lp_hz` moved into the pool entry.** The slot was full at 192 B and `layout.rs` is frozen. Main re-sends `lpHz` at every promotion, so this is safe; a voice that gets a pool entry late (pool full, nothing fading) starts unfiltered until the next `lpHz`. `lpHz` between 20,000 and 24,000 Hz now counts as off (no golden uses one).
- **D15 (W2, A3) `clipRegistry.ts` takes format 4 reserved clips** (A3 edited it outside its list; nobody else owned it that wave). The bed matrix uses only ACN channels 0, 1, 6, 8, 9, 11. `magls-o3.bin` is derived from the IRCAM data, so `hrir-licence.md`'s terms apply to it too.
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

- C1 (#133): convolver split into `kernel.rs`, `instance.rs`, `stagger.rs`; the shared reverb bit-identical (digest test recorded before the change), same region size, no core call-site change (D8); the planner bounded (D11). Mixer +1.7 KB.
- A1 (#119): K2 complete (ABI 2.0, the regions sized in their feature files, record stubs, the counters and STATUS writer at 15,904 B worst case, the `bus.rs` hook, `chain.rs`, the preset's four parameters and the headroom function on main) and A1's acceptance. Three leaves, first pass. The generated STATUS reader's panic on a short body (found by L-A1a) predated M3 and is fixed in the generator.

**Wave-end checks (`cae70ec`, with W2's A2, A3 and D1 merged too, run in a separate worktree while W2/W3 agents worked):**
- `npm run typecheck`: green. `npm run build`: green.
- `npm test`: 425 of 427 files. `clipRegistryWorker.test.ts` timed out once under load and passed alone (17/17; added to the flake list). `componentCategories.test.ts` failed for real: `AudioOccluder` had no Add Component category (the coordinator's registration missed it); fixed in `ea303c9`, and every later brief names that test.
- `npm run test:e2e` (Chromium): **198 passed, 4 skipped, 0 failed** (7.6 min). (`npm run test:e2e:install` failed offline; the preinstalled browser was used.)
- `cargo test` (all of `native/audio/`): green. `npm run check:audio-metered`: pass, all +1.70% against M2's baseline (worst `virtual` +4.2%, from D1's filter pool); baseline unchanged.
- M1/M2 goldens and parity digests bit-identical after K2, D1 and C1. STATUS worst case 15,904 B. `raycastInto` never hits the source's own capsule and allocates nothing in engine code.
- Sizes: mixer **203,040 B** (79% of 256 KB), decoder 751,489 B, AAC decoder 1,075,734 B.

## The pilot's measures (wave 1)

Asked for by the tree ("The pilot") and the owner. Times are agent wall time from the tool's usage reports; tokens are each agent's totals.

| Measure | Result |
|---|---|
| Leaf first-pass success | **W1: 7 of 8** (L-A1a, b, c; L-A6a, b; L-B2a, b pass; **L-C1a failed**: the spike code it ported had an unbounded search, so its test never finished, D11). W2 so far: 3 of 4 (L-A2b, L-A3a, L-A3b pass; **L-D1a stopped** on a spec gap, an unmeasured click bound, D13). Both failures came from the spec, not the leaf: the leaf did what it was told and stopped rightly |
| By leaf kind | tests from a table 2/2; byte-layout readers and writers 3/3 (L-A1a found a real generator bug); ports of existing code 1/2; small maths and parsing 2/2 (+ B1's, done by its lead) |
| Lead time on skeleton and briefs | A1 15–25%, B2 35–45%, C1 15–25%, A6a+C6 35%, A2 10%, A3 25%, D1 30%. Mid leads with small leaves (B1, D0, D2b, E6) chose not to split, 0% |
| Agent wall time per table day | W1's seven rows (27.5 table days + 2.5 contract days): ≈ 3.2 agent-hours, **≈ 6.4 agent-minutes per table day** (from 1.6 min/day for B1 to 15.6 for C1, whose planner was redesigned). The calendar: wave 1 took ≈ 1 h 50 min from the first lead to the last merge, overlapped with W2 starts |
| Tokens by model | strongest ≈ 2.4 M (A1 0.49, C1 0.34, D1 0.31, A3 0.29, B2 0.26, A2 0.25, plus K4/A4/C3 running); mid ≈ 0.67 M (B1, A6a+C6, D0, E6, D2b); cheapest ≈ 1.6 M over 12 leaves (≈ 0.1–0.28 M each) |
| Mixer and decoder size per Rust task | mixer: K1 +0.2 KB, B2 +11.2 KB (N-channel kernels), K2 +5.0 KB, D1 +6.3 KB, C1 +1.7 KB; decoder: B2 +2.4 KB |

**What changes for wave 2 on (the tree's "What it changes" rules):**
- No leaf *kind* needed more than one re-run, so no kind moves back to its leads. Byte-layout leaves, the riskiest kind in the plan, all passed.
- **New rule from the two failures:** a leaf whose spec carries an unmeasured performance or perceptual bound (a search's cost, a click bound) stays with its lead, or its lead measures the bound first and pastes the number (as A2 did for L-A2b's tolerance, which passed). Applied to the remaining leaves: L-C3a (state cases) and L-K4a (thresholds already numeric) keep their leaves; L-D2aa (smoothing, folding) gets measured bounds in its brief.
- Leads spent over a third on skeletons only for B2 and A6a+C6 at skeleton time (both near 4–5 days), and both finished cheaply after. So the "stop splitting tasks under 4 days" rule isn't triggered; leads already skip leaves under about half a day (B1, D0, D2b, E6, L-A2a), which the briefs now allow explicitly.
- The coordinator merges a leaf directly when its lead's work is complete and the leaf is one disjoint test file (A2): saves a lead turn.
- Rolling starts worked: W2's A2, A3, D1, D2b, E6 and W3's K4, A4 started while W1 finished, within the owner's three-strongest-lead limit.

**Lessons for later briefs**
- Leads used their own session's attribution trailer, not the one in the brief: fine (it names the model that did the work). Briefs now say "use your session's trailer".
- Every brief now names `componentCategories.test.ts` for a new component and carries the mixer headroom.
- The boundary guard is `src/plugins/plugins.test.ts` (the first briefs named a wrong path).
- Concurrent vitest runs collide on `node_modules/.vitest-cache` (ENOTEMPTY); a rerun passes.

## Wave 2 (in progress)

**Merged**
- A2 (#120): SN3D/ACN encode (orders 1–3, polynomial), Ivanic–Ruedenberg rotation, the MagLS bed decoder (`MaglsFilters` 65,544 B, `BedDecoderN` 40,964 B, as §3.1). Analytic tests at 64 directions per order within 1e-5; native and wasm bit-identical (a probe digest run in both). 256 voices encode + decode: wasm p50 ≈ 152 µs against the 142 µs target, **on par with the spike's own code measured alongside (138–153 µs) on the loaded container**; the wave-end bench is the record. L-A2a not split (its lead judged a complete brief would be the implementation); L-A2b first pass.
- A3 (#121): `bake-magls` (deterministic; `--check` in `build:audio`), `magls-o3.bin` 32,800 B (bake 2.5 s), the 16 → 2 bed matrix (worst 1.73 dB from equal power away from ±90°, louder ear within 0.26 dB everywhere), the format-4 loader on main. **12 of 12 azimuths; ILD against M1's HRTF: 0.92 / 1.56 / 1.69 dB in the 200–500 / 500–1k / 1–2 kHz bands, against the 1.7 dB limit** (the margin is thin but deterministic; other cutoffs and ridge values were no better than 1.64 dB, so the spike's settings stay). The HRIR set has no responses below −45°, so −60°, −75° and −90° reuse −45° (floor-below listening risk). Coordinator follow-ups: `Cargo.lock`, the engine library ships the asset (`vite.engine.config.ts`), the README's build steps (D15).
- D1 + K3 (#143): the mixed-voice pool (448 B per entry), log-Hz ramps capped at one octave per update (D13), SET_VOICE_FX on arrival (D12), mono-once, automation's low-pass migrated bit-identically, ambisonic voices never filtered, `fxVoices`; K3's hooks plus `sends::begin_quantum` and `sends::tap_aux` (C4 fills them; the aux accumulator goes in `Zones`, noted on #138). M2 goldens bit-identical. Mixer +6.3 KB; metered +1.7%.
- D2b (#145) and E6 (#157): in W1 above.

**Running:** C3 (zones core), A4 (core bed, W3), K4 (main skeleton, W3). Next: C2a when a strongest slot frees, then B4.

## Budgets

| Budget | Now | Limit | Note |
|---|---|---|---|
| Mixer wasm | 203,040 B (79%) | 256 KB gate, warning 230 KB | M3's estimate was +40–50 KB; +24.4 KB so far, with A4 (the bed decoder), C3, C4 and B3 still to link. **If the warning trips:** (a) a `wasm-opt -O3` pass (`build.mjs` already runs it when installed; reserve R2), or (b) the owner moves the warning with a measured reason (the M2 precedent). Not drawn on without the owner |
| Decoder wasm | 751,489 B | 900 KB | C2a adds the IR preparation (≈ 28 KB est.) |
| Metered cost | +1.70% all, worst +4.2% | +10% per scene | baseline kept at M2 |

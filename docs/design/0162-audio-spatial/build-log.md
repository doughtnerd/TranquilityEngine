# Spatial audio M3: build log

The coordinator's log of each wave review ([waves plan, "Wave reviews"](../../plans/2026-11-audio-spatial-m3-waves.md#wave-reviews)): what landed, the numbers measured, deviations from the design, decisions taken while the owner was away, and reserve days used. Tickets are GitHub issues #112–#163. Work merges into the M3 integration branch, and each milestone goes to master only with the owner's approval.

**Integration branch:** `claude/inspiring-euler-5qf03k` on origin (this build session may push only that branch; locally it's also called `claude/audio-spatial-m3`). It started at `origin/master` `918171a`.

## For the owner (summary, newest first)

The owner asked (2026-11-11, evening): "Go through each of the waves as instructed until the milestone is complete. If any decisions need to be made, use your judgement … and I will review everything in the morning." The coordinator reads that together with the earlier standing rules, which it keeps: **no merge to master, no draw on the 14-day reserve and no default change outside the plan's flips without the owner.** Milestones are left ready on the integration branch, with their checks run, as proposals.

**Needs you:**
1. **P1, the mixer size (recommendation: yes).** The mixer wasm is 254,039 B of its 256 KB gate. A `wasm-opt` pass would save ≈ 21 KB (measured: 230,348 → 209,149 B with `-O3`, 208,054 with `-Oz`); `build.mjs` already runs it when `wasm-opt` is installed. Making every machine build the same optimised wasm means adding `binaryen` (pinned) as a dev dependency, which needs you (a new dependency; reserve item R2). Without it, B3 already traded CPU for size (its rotation does ≈ 2× the work, est. 5 → 10 µs a voice) and C4 only fitted after a size-recovery pass (−8.8 KB, no behaviour change). If you approve, B3's rotation trade should be reverted (D21).
2. **The bed flip (A6b), held.** Beds on and HRTF voices 32/16 → 8 for every project. Its plan gate includes "mixer under 230 KB", which can't be met as M3 stands (the mixer passed 230 KB at A4, which is the bed itself). Everything else in its gate passed (A3, A4's goldens, A7's bed bench). It's kept as `flips/a6b-beds-on-hrtf-8.patch`, rebased and tested on the tip (`git am` it). **Recommendation:** approve the flip with the 230 KB criterion replaced by "under the 256 KB gate" (or by P1's optimised size).
3. **M3a, M3b, M3c to master:** see "Milestone readiness" at the end of this log.
4. Review D11 (the bounded zone planner), D13 (filter sweeps), D17–D20 (the wide, zone, occlusion and Doppler flips merged under the plan's flip rule), the A3 numbers (the MagLS ILD margin and the floor-below listening risk), and D19 (events keep their own Doppler).
5. Your runs: the lab-VM benches (the wasm MagLS decode is noisy here: ≈ 30 µs against the model's 20) and the listening items per milestone.

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
- **D16 (W3, K4) `AudioSource.occlusionGain`.** §1.2 lists both a boolean field `occlusion` and a read-only `occlusion`; the read-only value on `AudioSource` is `occlusionGain`. The one-shot handle keeps `occlusion` (§1.1), where nothing clashes. *Revert:* rename.
- **D17 (W5, B5) the wide memory flip merged.** `wideInitParams` = `audio.ambisonic.maxClips`: every core project lays out the `Wide` region (2.22 MiB per ring after B4's stall test, below) and the private decoders. The plan schedules it, its gates passed (B4's ring, C3's regions, K2's headroom with a high-preset init test under the Memory maximum), and it reverts in one line; the owner's overnight instruction covers judgement calls in line with the plan. *Revert:* `wideInitParams` returns 0.
- **D18 (W5, D2a) the occlusion flip merged.** The pass is live by default (`AudioSource.occlusion` was already true, K4). `pirates` sets `audio.occlusion.layers: []`: its only colliders are navigation helpers (the sailable-water disc, 0.75 m footprint cylinders; the island meshes have no colliders), which would muffle sound at random. Gates passed (D0's exclusion, the no-physics path, overrun halving). *Revert:* one line in `core/occlusion.ts` (the environment default) and the `pirates` key.
- **D19 (W4, D4) events keep their own Doppler.** A source playing a sound event passed its own default `dopplerLevel` 1, overriding the event's §2.5 default 0; the coordinator removed `dopplerLevel` from what a source passes to its events (Doppler is authored on the event, as in Wwise and FMOD). `occlusion` and `reverbSend` still pass through, with the event's own keys winning. *Revert:* `AudioSource.eventSpatialOptions`.
- **D20 (W6, D3) the Doppler flip merged.** The pass went live in D3's first commit (`dopplerLevel` already defaulted to 1); the flip commit sets `dopplerLevel: 0` on `sound-lab`'s orbiting hum and crowd sources and in `stress`'s generator and regenerated scene (§1.6). Gates passed (teleport guard, `maxSpeed` clamp). *Revert:* the sample keys and the default.
- **D21 (W4, B3) size for CPU in the ambisonic rotation.** To fit the mixer, B3 made A2's `rotate_ramp_add` run one encode pass per input channel (≈ 2× the rotation work, est. 5 → 10 µs a voice) and computes the Ivanic coefficients at run time; A2's identity digest changed on purpose (native = wasm still). *Revert* after P1 lands.
- **D22 (W3, B4 → coordinator) wide stream rings are 32,768 frames.** B4's 300 ms stall test starved at 19 of 32 credit phases with 16,384 frames and at none with 32,768: the plan's named response, applied by the coordinator (wire constant regenerated, +1 MiB per wide ring). *Revert:* the constant in `audio-wire/src/schema.rs`.
- **D23 (W3, C3 + size task) the mixer under its gate.** C3 replaced `plan_stagger` in the core by `plan_one` (plans one new zone exhaustively; zones only ever start one at a time; 4 × 2 s started one by one peak 3.13 against 3.08 batched, sequential 5.87), and a size-recovery task saved 8.8 KB with no behaviour change (an explicit-tag core slot moves a 6.4 KB static to `.bss`; a resampler clamp without formatting; shared record readers). Metered counts went slightly down.
- **D24 (W3, C3/C4) fixed `Zones` memory without zones.** The aux accumulator (`max_buses × 1 KB`) and C4's per-bus chain gains (`max_buses × 512 B`) live in `Zones`, so every core project pays ≈ 48 KB at 32 buses even with zones off (as the `Fx` pool). Aux sends work without zones.
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

## Waves 2–7 (rolling starts; merged in dependency order)

**Merged**
- A2 (#120): SN3D/ACN encode (orders 1–3, polynomial), Ivanic–Ruedenberg rotation, the MagLS bed decoder (`MaglsFilters` 65,544 B, `BedDecoderN` 40,964 B, as §3.1). Analytic tests at 64 directions per order within 1e-5; native and wasm bit-identical (a probe digest run in both). 256 voices encode + decode: wasm p50 ≈ 152 µs against the 142 µs target, **on par with the spike's own code measured alongside (138–153 µs) on the loaded container**; the wave-end bench is the record. L-A2a not split (its lead judged a complete brief would be the implementation); L-A2b first pass.
- A3 (#121): `bake-magls` (deterministic; `--check` in `build:audio`), `magls-o3.bin` 32,800 B (bake 2.5 s), the 16 → 2 bed matrix (worst 1.73 dB from equal power away from ±90°, louder ear within 0.26 dB everywhere), the format-4 loader on main. **12 of 12 azimuths; ILD against M1's HRTF: 0.92 / 1.56 / 1.69 dB in the 200–500 / 500–1k / 1–2 kHz bands, against the 1.7 dB limit** (the margin is thin but deterministic; other cutoffs and ridge values were no better than 1.64 dB, so the spike's settings stay). The HRIR set has no responses below −45°, so −60°, −75° and −90° reuse −45° (floor-below listening risk). Coordinator follow-ups: `Cargo.lock`, the engine library ships the asset (`vite.engine.config.ts`), the README's build steps (D15).
- D1 + K3 (#143): the mixed-voice pool (448 B per entry), log-Hz ramps capped at one octave per update (D13), SET_VOICE_FX on arrival (D12), mono-once, automation's low-pass migrated bit-identically, ambisonic voices never filtered, `fxVoices`; K3's hooks plus `sends::begin_quantum` and `sends::tap_aux` (C4 fills them; the aux accumulator goes in `Zones`, noted on #138). M2 goldens bit-identical. Mixer +6.3 KB; metered +1.7%.
- D2b (#145) and E6 (#157): in W1 above.

- K4 (#163): the main-thread skeleton: the M3 frame order for both backends, `voiceFx`, stubs with final signatures, the §1 surface declared, the fakes. L-K4a first pass.
- A4 (#122): the core bed (slots, hosts, kind 2, the equal-power crossfade, decode before host effects, the gain fold with `chain::fill`, the MagLS commit, the ladder's bed-idle step). Goldens within 1e-5 dB; no BED_CONFIG → bit-identical to M2. Mixer +27.3 KB. `Beds` is 268 KB for 2 beds + 1 private decoder at 48 kHz (the design's 208 KB left out the header and FFT scratch).
- C2a (#134): IR preparation in the decoder; prepare 1.15 / 2.32 / 5.46 ms for 1 / 2 / 4 s (design 1.3 / 2.5 / 5.3); the 44.1 → 48 kHz resample ≈ 4 ms per second of IR (in the worker); decoder 804,255 B (900 KB gate). Review items: the −80 dBFS trim is absolute, the 32-tap resampler, the preset model (two bands, a 2 kHz crossover).
- C3 (#136): core zones, both slot paths, the ladder's zone steps, the aux accumulator; slot state 3.10 / 6.07 MiB at 2 / 4 s (D23, D24).
- C2b (#135): the worker's IR handler and kernel send to the worklet, `ZoneIrService` (cache, re-preparation from kept bytes, failures); the worker unloads kernels itself.
- A5 (#123, inert) and the A6b flip (#125, held: "Needs you" 2).
- A7 (#126, open for the ambisonic fit terms): bed scenes, goldens, metered baselines. Container µs p50/p99, native | wasm: `bed-64` 203/448 | 247/505, `bed-256` 718/1,492 | 838/1,737, `bed-xfade` 413/857 | 511/1,040. Fit: `BED_VOICE` 0.27 / 0.35 µs (model 0.5), MagLS decode ≈ 18 native and ≈ 30 wasm, noisy (model 20: the lab VM settles it), matrix decode ≈ 2.2.
- B3 (#129): the core ambisonic voice (listener ramp, rotation into a bed or a private decoder, the W send, `maxClips` steal); a 90° turn within 0.05 dB, 0.014 dB at 720°/s (D21).
- B4 (#130): `Wide` rings, 1–16-channel worker streams with `convention`, the FuMa import gain on streams (D22).
- B6 (#132): `makeAmbisonic.mjs`, 19 loopback tests (image azimuth through a bed and a private decoder, orders 1–3, a listener turn, yaw, FuMa twins). The `ambi-o3` bench scene is a follow-up.
- E3 (#154): Project Settings > Audio for M3.
- C4 (#138) with the size recovery: zone sends and aux in the core; a send follows a ducked bus within 9.8e-5 dB; a voice with sends differs from M2 by ≤ 1.49e-8 (the one allowed golden difference: 388 of 2,048 samples, ≈ 1 ulp).
- B5 (#131) with the wide flip (D17): the listener on main, ambisonic sources and one-shots, `maxClips` stealing on main, the > 5 s stream default, the FuMa first-play fix.
- D2a (#144) with the occlusion flip (D18): ray ages 1 / 5 / 20 frames at 64 / 256 / 1,024 sources (≤ 3 / 5 / 22), no per-frame allocation.
- D4 (#147, D19), D3 (#146) with the Doppler flip (D20), E5 (#156), F1 (#150).
- D6 (#149): `filters-256` and `m3-worst-*` scenes, filter goldens, the occlusion bench (`npm run bench:audio-spatial`). Filters ≈ 1.0 µs per pass; worst-case deltas against each preset agree with §7.2 (high +304 µs wasm vs ≈ 243 model; default +102 vs 159; low +50 vs 46).
- C5 (#139) with the zone memory flip (merged under the same rule as D17: gates C3's regions and K2's headroom with a high-preset init test; revert `zoneInitParams` → 0): the zone registry, weights and sends (× the occlusion pass's wet factor), the planner with hysteresis, both slot paths, the kernel LRU and preload, the 5 s timeout, the shared return; the real-wasm A → B → C walk passes on both slot paths.

**Leaves since the pilot:** L-A2b, L-A3a, L-A3b, L-K4a, L-C3a, L-C2aa, L-C5a first pass; L-D1a stopped on a spec gap (D13). Most mid-model leads judged their leaves under half a day and did them (L-B1a, L-A5a, L-B6a, L-D2aa, L-D3a, L-D4a, L-E3a, L-E5a, L-F1a, L-C5b), as the adjusted briefs allowed. The rule "paste measured numbers into a leaf brief" held: every leaf briefed that way passed first time.

**Coordinator glue and fixes:** the FuMa import gain into `clipVolume` (B2); `AudioOccluder` and `AudioReverbZone` registered, exported and given Add Component categories; the bed and zone memory mirrors in `coreDriver.ts` (A4, C3); `voices.rs`'s seek-fade tail for wide rings (B4); `AudioSource._voiceId` (D2a); `bench:audio-spatial` in `package.json` (D6); the A3 follow-ups (Cargo.lock, shipping `magls-o3.bin`, the README build steps). One incident: a stray edit to `babylonBackend.ts`/`babylonMapping.ts` appeared in the coordinator's own checkout during F1 (F1 says it didn't write there); it was saved to the scratchpad and reverted, and every brief now says never to write to the main checkout.

**Running now:** C3b (in-core IR preparation), C7 (zone tests and benches), D5 (the API surface and `Audio.debug()`, incl. the `m3Shed` STATUS field), E1 (zone gizmo), F2 (Babylon zones inert). Then E2, E4, E7, E8, E9, E10.

## Budgets

| Budget | Now | Limit | Note |
|---|---|---|---|
| Mixer wasm | **254,039 B (97%)** | 256 KB gate, warning 230 KB | M2 178,598; by task: K1 +0.2, B2 +11.2, K2 +5.0, D1 +6.3, C1 +1.7, A4 +27.3, C3 +20.4 (after its own −14.7), B3 +7.1, B4 +1.6, C4 +3.4, size recovery −8.8. C3b still to come (≤ 6 KB asked). **P1** ("Needs you" 1) restores ≈ 21 KB |
| Decoder wasm | 804,255 B | 900 KB | C2a +52.8 KB (design est. +28) |
| AAC decoder | 1,128,486 B | 1,280 KB | |
| Metered cost | +1.39% all against M2's baseline | +10% per scene | baseline kept at M2; new scenes (bed, filters, m3-worst) have their own baselines |
| M3 fixed memory | default ≈ 9.2 MB zones + beds + wide + `Fx` + `Zones` aux/gains | owner-accepted ≈ 20.9 / 10.7 / 3.0 MB (Revision 4) | Beds +60 KB over §3.1; wide rings +1 MiB each (D22); `Zones` aux/gains ≈ 48 KB fixed (D24) |

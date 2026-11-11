# 0162 spatial audio: round 2A, senior engineer's review of `architecture.md` and C1-C24

Read in full: `architecture.md`, `contracts-architect.md`; 0157's `architecture.md` §2.4, §5.1, §6.1-§6.3, §3.6 (the sections cited). Checked against `api-and-models.md` (mine, "API") and the tree: `voices.rs`, `automation.rs` (`VoiceAuto`), `biquad.rs`, `convolver.rs`, `stream.rs`, `layout.rs`, `worldServices.ts`.

## 1. Verdict

**Approve with changes.** The architecture is sound and in several places better than my draft: the audio thread's work is bounded and the ownership split is clean (§5.1); occlusion budgets by ray count instead of a coarse timer; the HRTF-to-bed switch uses an equal-power law, which is the correct response to MagLS not matching phase; the core folds sharing-bus gains so no wire field is needed; the standby slot answers the sound designer's "tail must ring out"; REPLAY becomes a state table (ZONE_CONFIG with a waiting-for-kernel state) instead of an ordering rule. I adopt most of their wire shapes (§2.2).

**One blocking issue** (I1: `myco_audio_init_spatial` cannot place regions before the arena). Majors: the kernel blob layout and a flag that does not exist (I2), the second-biquad memory estimate (I3), per-voice state for sends is placed nowhere (I4), the aux send of the record is dropped (I5), Master "always first" overrides `bedPriority` (I6), doors (I7).

Counts: **S1-S20: 6 met, 11 partly met, 3 not met.** **C1-C24: 3 my API already meets (C1, C16, C22), 19 I will change to adopt (C2-C5, C7, C9-C15, C17-C21, C23, C24), 2 need their change (C6, C8).**

## 2. Contract status

### 2.1 My S1-S20 against their document

| # | Status | Exact change needed |
|---|---|---|
| S1 occlusion and send staleness | **met** | Their §5.2 has the same bounds. I drop my "re-plan every 4 frames" and take their 1.5x for 500 ms |
| S2 listener staleness, axes | **partly** | Their same-batch same-`rampFrames` rule gives 0 skew; I drop my "33 ms lag". **They must state the engine-to-AmbiX axis map** (`(X,Y,Z) = (-z,-x,+y)`; §3.5 gives none) and which way the quaternion rotates |
| S3 state ownership | **met** | One change on my side: `foldLp` is core-side (theirs), not folded by main |
| S4 wide rings | **not met** | Different design. Adopt theirs (separate `Wide` region, 16 ch x 38,400 frames, 256 KB chunks, count = `maxClips`): it does not steal 2-channel rings, and its 0.8 s ring tolerates the same stalls as M1. My "RING_BYTES about 270 KB" was wrong (307,200 B, A157 §5.1); my adjacent-slot scheme goes |
| S5 MagLS asset | **partly** | Same asset and size. Failure behaviour: adopt theirs (beds decode through the equal-power matrix until resident). Id: see C6 |
| S6 memory per preset | **partly** | Their bed and decoder rows match mine. Differences: private decoders (+48/96 KB), zone totals with the standby slot (3.3 / 9.2 / 18.0 MB, owner item), the second biquad (I3: not 40 B). **They must say where per-voice send, hp and yaw state lives** (I4): the voice slot has 192 B and `send[4]` ramps alone need 64 B |
| S7 cost model | **met** | Theirs is the same rows on the lab-VM coefficients (1.2 µs a biquad) and more conservative than my container figures. See §5 for two corrections (mono voices, send cost) |
| S8 counters | **partly** | C24 lists them; no health thresholds. They add green/amber/red for the occlusion age (assumed amber above 8 frames, red above 30), `bedDenied`, `kernelRefused`, `irFailures`, `m3Shed` |
| S9 STATUS size | **partly** | Their `spatial` section replaces my header growth (I adopt it). **They must state the worst-case total**: about 15,728 + 150 B against 16,384 B (headroom about 500 B) |
| S10 failure behaviours | **met** | Their §8 covers mine and adds the worker-missing path. Mine changes: ambisonic clips use private decoders (maxClips), not a stereo-decode fallback, so low preset gets binaural for one clip |
| S11 rebuild cost | **partly** | They give the 1-3 s gap and 100 ms fade, not the preparation time. Add: 1.3 / 2.5 / 5.3 ms per 1 / 2 / 4 s IR in the worker, and the in-core PCM path's 0.25-0.8 s |
| S12 bed cost attribution | **met** | C7 per-bed work units plus `costUs` in debug |
| S13 adaptive cap and M3 | **partly** | They say the cap's floor grows and propose a ladder (owner). Missing: whether the cap demotes **bed voices first** (it sheds by `score` like any mixed voice; they should say so) and that it never touches zones or beds |
| S14 kind-change hysteresis | **not met** | They keep M1's 1.2x and 3-frame dwell and only **warn** above 4 switches per voice-second. The sound designer asked for a minimum time in a kind. Proposal: a 0.5 s dwell on main for HRTF to bed changes only (bed to HRTF may promote at once: a near source should sharpen) |
| S15 bus-tree edit, bed host change | **met** | §2.1 Moving, 45 ms dual encode, Draining 2 quanta |
| S16 order in the quantum | **partly** | Their order matches (voices, bed decode before mixdown, zones after voices). Zone wet goes to a return **bus** (theirs) not the output (mine): follows the owner's routing ruling |
| S17 sample rates | **partly** | MagLS above 88.2 kHz and zones doubling at 96 kHz are covered; not stated: which rates zones support. State 44.1 and 48 kHz tested, 96 kHz allowed with the doubled memory |
| S18 physics ray contract | **partly** | C14's allocation-free `raycastInto` is better than my `_worldRaycast` options. **Missing: the audio plugin cannot import `PHYSICS_3D` from the physics plugin** (`plugins.test.ts`); the interface must live in `engine/core/worldServices.ts` beside `WorldRayHit` |
| S19 listener, multi-World | **not met** | Not addressed for zones, rays or LISTENER. State: only the World with the view sends LISTENER, runs rays and zone planning; zones are inert in other Worlds; the editor audition uses the editor camera |
| S20 shared constants | **partly** | §5.3 lists constants with sources but not that they are generated from `schema.rs`; quote by name |

### 2.2 Their C1-C24 against my `api-and-models.md`

| # | My doc | What I do |
|---|---|---|
| C1 flags | **meets** (bit 7, panner 2) | Adopt "core falls back to equal-power when the bus target is 0xFF"; my main-side host check goes |
| C2 BED_CONFIG | differs | Adopt theirs (`u8 bedSlot, u8 owns` per bus): stable slot identity is what their dual-encode move needs |
| C3 SET_VOICE_FX | differs | Adopt theirs with one addition (I5): `+f32 aux; u16 auxBus; u16 pad`, mask bit3, 52 B |
| C4 LISTENER | differs | Adopt theirs (32 B, world-to-listener); `rampFrames` 0 is the snap |
| C5 ZONE_CONFIG | differs | Adopt (idempotent table, REPLAY for free). Clarify: the core re-plans only when a slot starts, not on every record (`sharedReturnGain` changes per frame) |
| C6 blobs | **needs their change** | Layout: M1's convolver stores **packed** bins (head 128, tail 2,048 per partition, bin 0 = DC and Nyquist), not 129 and 2,049. CLIP_BEGIN has no `flags` field: use `format 5 = zone IR PCM`. Ids: keep MagLS 0xFFFF0001 (inside the HRIR block, format tells them apart) and kernels 0xFFFF0100-01FF |
| C7 STATUS spatial | differs | Adopt; drop my 144 B header |
| C8 init | **needs their change** | Reject a second init call (I1). One `myco_audio_init` with `max_beds, max_zone_slots, zone_max_frames, max_wide, max_fx` appended |
| C9 decoder | differs | Adopt; presets generated in the worker (`myco_decode_generate_ir`), not main; 50 ms cut fade |
| C10 settings | differs | See §4 |
| C11 components | differs | See §4 |
| C12 materials | differs | Take their five rows' numbers; keep my `none` and optional attack/release |
| C13 events | differs | Adopt, plus `sends.<bus>` (I5), and one-shot `lowpass`, `highpass`, `yaw`, `sendCurve` stay |
| C14 ray query | differs | Adopt, behind a core-level interface (S18); D0 grows |
| C15 debug | differs | Merge: their `beds[].denied`, `zones[].rank/by`, `memory.*`; my `kindDwellMs`, `lowpassBy`; panner string union kept (ambisonic is not 0, 1 or 2) |
| C16 sidecar | **meets** | None |
| C17 filters | differs | Adopt (hp in `VoiceAuto`), with the memory corrected (I3) and mono voices filtered once |
| C18 work units | new | Adopt; priced in §5 |
| C19 benches | differs | Adopt their scene names; add `m3-worst-*` |
| C20 voice table | differs | Adopt names (`audibility0`, `sendLevel[4]`) |
| C21 Babylon | differs | Adopt; the `ConvolverNode` risk stays open (I11) |
| C22 SDK | **meets** | No SDK contribution is needed: `registerViewportTool` already draws overlays and handles (`ViewportToolContext.overlay`, used by physics and navigation) |
| C23 presets | differs | Adopt, including `maxClips` and `maxIrSeconds` |
| C24 counters | differs | Adopt their names |

## 3. Issues

1. **blocking: `myco_audio_init_spatial` cannot add regions.** Regions are a pure function of `InitParams` and precede the arena, which is last and starts on a page boundary (`layout.rs`, 0157 §5.1 "deterministic", needed for soft recovery). A call after init would have to relocate the arena or leave the regions without room. Fix: one `myco_audio_init` with the new parameters (ABI 2.0 anyway). `set_limiter_lookahead` is not a precedent: it sets a scalar.
2. **major: kernel blob and PCM flag.** C6's 129 and 2,049 bins do not match `convolver.rs` (head `HEAD_BINS` 128, tail `fft::BINS` 2,048, packed). CLIP_BEGIN has five words and no `flags`. Fix in §2.2 (format 5).
3. **major: the second biquad is not 40 B.** `Biquad` is about 120 B (five f64 coefficients, 2x4 f64 history, last, rate); `VoiceAuto` is sized by `max_logical`. The hp biquad is about 480 KB at 4,096 logical voices (128 KB low), not 160/320 KB (§6.1). Acceptable (about 7% of the M1 block) but the table must be corrected. My pool of `max_mixed/2` entries would be 40 KB; I adopt their in-`VoiceAuto` design because it keeps the M2 goldens trivially bit-identical.
4. **major: where do sends, hp and yaw live?** `send[4]` as ramps is 64 B, `hp` another biquad, `yaw`, `bed` share ramp, ambisonic read state: `VoiceSlot` is at most 192 B (`voices.rs:152`). They must say which struct holds each and whether `VOICE_SLOT_BYTES` becomes 256 (+256 KB at 4,096 logical voices).
5. **major: the aux send is gone.** 0162 §6 lists `sends: { reverb?, <effect bus name>? }`; C13 reserves other keys. Either the owner drops aux sends from M3 or C3 carries them (my proposal, +8 B). It is a scope call for the coordinator; cost in §5.
6. **major: "Master always ranks first among candidates"** (§2.1) overrides owner decision 6 (highest `bedPriority` gets a bed). Their own sort (priority, then depth, then index) already puts Master first on ties at the default 128. Drop the override; keep the implicit grant when nobody asks `own` (owner item: root owns a bed).
7. **major: doors.** Neither document handles an opening door except by disabling the collider. My `openness` field (0..1) costs nothing in the core and answers the sound designer's door question; add it to `AudioOccluder` (C11).
8. **minor: sends see the occlusion low-pass.** §4's order puts the filter before sends, so a muffled source sends dull signal to its zone; 0162 §3 scales wet only by `wetOcclusion`. Defensible (Wwise does it) but say it; I change my §4.5 to match.
9. **minor: `maxClips` is three limits** (wide rings, private decoders, concurrent ambisonic voices). State it caps concurrent ambisonic **voices** (stream or arena, bed or alone) and the lowest priority is stolen.
10. **minor: preset generation "on main"** (§2.2) contradicts C9 (the worker prepares from an asset URL). Generate in the worker; main never holds a time-domain IR.
11. **minor: Babylon `ConvolverNode`.** §10 and C21 assume an insertion point Babylon's V2 public API lacks (`_inNode`/`_outNode` only; 0157 declined them). My F2 first checks the pinned version; zones may be inert on the fallback.
12. **minor: bed in `equalPower` mode.** An order-3 16 to 2 matrix cannot reproduce the equal-power law's fold at +-90 degrees (a discontinuity); expect Gibbs error. Acceptance: within 2 dB of `EqualPowerPanner` except within 10 degrees of the fold; say so.
13. **minor: send curve default.** Theirs 0.5 to 1 (+6 dB) is "gentler" per the record than my 1 to 3; adopt it, and state the curve is relative to the dry distance gain (both documents omit the meaning).
14. **minor: LP_TOP 20,000 Hz** versus the existing off threshold (`lowpass_on`: below 24,000). Occlusion's `none` cutoff of 22,000 would be on. Use one: 20,000, and treat anything at or above it as off in the schema.
15. **minor: `sharedReturnGain` by listener weight** is listener-based, against owner decision 1's spirit for the bus reverb. Unavoidable (the bus reverb is bus-level), accepted; recommend on the owner list as stated.

## 4. Conflicts: my resolution (for the coordinator to rule)

| Conflict | Proposed resolution | Reason |
|---|---|---|
| BED_CONFIG | theirs: `u8 bedSlot, u8 owns, u16 reserved` per bus | stable slot ids carry decoder state across replans and let the core validate |
| SET_VOICE_FX vs SET_FX | theirs (mask, ramp, `hpHz`, `send[4]`, `yaw`) plus aux (+8 B, 52 B) | 4 sends are needed (slots 0-2 with a standby slot); aux is in the record |
| LISTENER | theirs: 32 B, world-to-listener, `rampFrames` 0 = snap | the core wants the inverse anyway; my flags word was only a snap bit |
| Zone opcodes | theirs: one ZONE_CONFIG table | idempotent, REPLAY needs no ordering, waiting-for-kernel is a state |
| MagLS clip id | 0xFFFF0001 (theirs); kernels 0xFFFF0100-01FF | both inside the already reserved space |
| Init export | **mine**: one `myco_audio_init` with the new parameters | regions must precede the arena (I1) |
| `bedPriority` | theirs: 0..255, default 128 | same scale as `priority` |
| `zones.maxActive` | 0..2 (record: "at most 2"); wire stays 4 slots | memory; the range can widen later |
| `maxIrSeconds` vs `maxSeconds` | theirs: `maxIrSeconds` | clearer |
| `doppler.maxSpeed` | 150 (theirs) | a car or a fast projectile should not trip a teleport guard |
| `reverbSend` range | 0..2 (mine); name `reverbSendCurve` (theirs) | boosting a source's wetness is normal; "send curve" alone is ambiguous with aux sends |
| `audio.ambisonic.maxClips` | theirs, adopted | a real memory knob tied to the wide rings and private decoders |
| `equalPower` with beds | theirs: beds kept, decoded by the baked matrix | the record says "decodes beds to equal-power stereo"; clips need a decode in that mode |
| Zone presets | `room, corridor, hall, cave, open` (mine) | zones are places; `plate` is a studio effect |
| Zone return | theirs: `output` bus per zone (default Master); owner's item | one extra field, Wwise aux-bus parity |
| Occluder fields | mine: trims, `cutoffScale`, `openness`; their optional absolute overrides are unrepresentable in `@field` without a sentinel | `@field` has no "unset" |

## 5. Performance model and task-table delta

**S7 check.** Their typical high (0.24 ms p50) agrees with the record's 0.22 ms net; their rows come from the frozen lab-VM coefficients and are the right ones for budgeting. Worst high **0.71 ms p50 is arithmetically right** (80+124+49+90+346+74-55) and **the filters are 49% of it**: 288 x 1.2 µs. Two corrections: (a) a **mono voice needs one filter pass, not a stereo biquad**: filtering the mono source before it is copied to both channels halves the term (about 0.17 ms saved at high worst, 0.08 at default); (b) sends are mono-in and pre-panner, so 0.15 µs is right and my 0.3 was high. A third: the worst-high scene counts 288 filtered voices of 256 mixed; the extra 32 are clips, which cannot be filtered (16 channels), so the term is at most 256.

**Does my table price what their architecture needs?** No. Delta (days, on my 146.5 of tasks):

| Item | My task | Delta |
|---|---|---|
| Per-voice hp biquad in `VoiceAuto`, mono-once filtering, no pool migration | D1 (4) | -0.5 (net: -1 migration, +0.5 mono path) |
| Private ambisonic decoders capped by `maxClips`, steal logic, settings and editor control | B3, A6, E3 | +2.0 |
| Wide stream rings as a separate region, 256 KB chunks, `STREAM_OPEN.convention` FuMa per chunk | B4 (5) | +1.5 |
| Standby zone slot: planner with 3 slots and ring-out, Releasing/Evicted states, kernel LRU, proximity preload, 5 s timeout, memory accounting | C3, C5, C6 | +3.5 |
| Shared-return scaling by 1 - listener weight (listener weights on main, ramped scale in the core, bit-identical at weight 0) | C3, C5 | +1.0 |
| Core-side `foldLp` | A4/D1 | +0.5 |
| Baked 16 to 2 equal-power matrix, `equalPower` bed mode, acceptance test | A2, A3 | +1.2 |
| Allocation-free `raycastInto`, sensor flag, subtree exclusion, core-level interface | D0 (2) | +1.5 |
| Lateral multi-ray (top 4 on high) and ray-count EMA with overrun halving | D2a | +1.5 |
| In-core PCM IR preparation spread over quanta (their worker-missing path); this was my reserve R3 | new | +3.0 (reserve -3.0) |
| Equal-power crossfade law for kind changes involving 2 | A4 | +0.5 |
| STATUS `spatial` section, zone-slot telemetry, `bedSwitches` | A1, C3 | +0.5 |
| Zone return bus (`output`) in core and Inspector | C3, E2 | +0.5 |
| `mode=fit` sweeps for the C18 coefficients and the `m3-worst-*` scenes | A7, C7, D6 | +3.0 |
| Savings: host resolved in the core (no main bed-host check); sends need no pan matrix | A5, C4 | -1.0 |
| **Net on tasks** | | **+18.7 d** |

Reserve falls by R3 (3 d) to 14 d. **Net on the total: +15.7 days (about +3.1 pw): 179.2 days, about 35.8 pw** (was 163.5 d, 32.7 pw). If the owner adopts the load-shedding ladder (§7.3), add about 2 days (cut ring-out tails, session `maxActive` - 1, faster bed idle, `m3Shed` reporting). The critical path is unchanged (the zone spine grows by about 2 days: C3 and C5).

## 6. Agreements

- Ray-count budgeting with an EMA instead of `performance.now()` per ray; ranking by pre-occlusion audibility (`audibility0`); tier at most half the rays.
- Equal-power crossfade for any change involving a bed (MagLS is not phase-matched; a linear fade dips).
- Core-side gain folding with no wire field; their exactness analysis (three bounded cases) settles the record's open check.
- `ZONE_CONFIG` as a state table with a waiting-for-kernel state, 100 ms fade-in after REPLAY, kernels kept across a soft reset.
- Wide rings as their own region and `maxClips` as the memory knob; worker-to-worklet kernel upload; in-core fallback preparation.
- Sends taking the bus-chain gain to the root (muting a bus mutes its reverb); lowest cutoff wins; one filter per voice.
- Per-source zone weights with equal-power normalisation of overlaps.
- Doppler on main into `pitch` with OpenAL's formula, no core state.
- Their §12 industry table and the "Practice" lines; the staleness table; the failure table.
- Bed idle after 2 quanta (decoder history), so silent buses cost nothing.

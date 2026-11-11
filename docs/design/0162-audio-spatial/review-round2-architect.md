# 0162 round 2A: the architect's review of `api-and-models.md` and `contracts-senior.md`

Reviewed at `e2adf6ea`. **[API §n]** is the senior engineer's document, **[ARCH §n]** mine, **[A157 §n]** 0157's architecture.

## 1. Verdict

**Approve with changes.** The API, settings, data models and task table are sound and mostly better than what I assumed: BED_CONFIG as one host array, SET_FX with an aux send, LISTENER with a snap flag, ZONE_CREATE/UPDATE/DESTROY with zone events, wide streams that reuse the narrow ring slots, and no new SDK contribution point. On every one of those I withdraw my shape and adopt theirs (§5). The coordinator's checks confirm three of my points: the high preset is 32 HRTF voices, the ray query has to change (D0 / C14), and bus reverb is bus-level.

Before the build plan, six things must change:
- zone state must live in a fixed region, not the arena (issue 1);
- the ray budget must not rest on `performance.now()` (issue 2);
- the ray query must skip the source's own colliders and must not allocate (issue 3);
- the filter pool must not run out in an indoor scene (issue 4);
- the per-voice filter coefficient is wrong (issue 5);
- IR blobs must go worker → worklet, not through main (issue 6).

Two decisions are the owner's to make: where zone wet output goes and the zone slot count (§6).

## 2. My contracts C1–C24 against [API]

**Counts: 9 met, 13 partly met, 2 not met.** Both "not met" are cases where I adopt their shape.

| # | Status | Exact change needed |
|---|---|---|
| C1 voice flags | **met** | none (bit 7 `ambisonic`, panner 2; `flags2` in the slot is internal) |
| C2 BED_CONFIG | **not met: adopt theirs** | `u16 host[busCount]` (§5). I change [ARCH §2.1] to "host" wording |
| C3 SET_VOICE_FX | **partly** | adopt SET_FX 0x0A. If the owner rules in a standby zone slot (§6), add `send2` (mask bit 5, 48 B total) |
| C4 LISTENER | **partly: adopt theirs** | 36 B, listener → world, `flags` bit0 snap (§5) |
| C5 ZONE_CONFIG | **not met: adopt theirs** | ZONE_CREATE gains `u16 returnBus` in its reserved word (if the owner picks bus routing, §6). The shared reverb's listener-weight scale needs a home: ZONE_UPDATE with `voiceId` 0xFFFF = "the shared return" (`f32 wet` = 1 − the listener's zone weight) |
| C6 blobs, channels | **partly** | format 4 id 0xFFFF0100 adopted (mine collided with the HRIR range). Format 3 uses ordinary ids: fine. The PCM in-core preparation path stays reserve R3: fine. Arena 1/2/4/9/16: met. Wide streams: adopt their adjacent-slot rings (S4 condition) |
| C7 STATUS `spatial` | **partly** | adopt their 144 B header and the `beds` and `zoneEvents` sections. I drop per-slot schedules and peaks (debug only). `bedSwitches` is counted on main from kind changes, so STATUS doesn't grow |
| C8 init and layout | **partly** | parameters on `myco_audio_init` adopted. The `Zones` region must hold the state blocks, sized at init (issue 1). No `WideStreams` region (their ring reuse) |
| C9 decoder worker | **partly** | `myco_ir_*` exports and the worker keeping encoded bytes: met. Kernels must go over the worker ↔ worklet port, not "main sends it as ordinary CLIP_CHUNKs" ([API §4.6]; issue 6) |
| C10 settings | **partly** | adopt `zones.maxSeconds`, `bedPriority` −100..100 default 0, `zones.maxActive` 0..2, `doppler.maxSpeed` 100, `occlusion.smoothingMs`. Drop my `ambisonic.maxClips` (their rings make it unnecessary). Add `voices.hrtf` default preset 8 if the owner agrees (§6) |
| C11 components | **partly** | adopt `sendCurve`, the occluder trim, scale and openness fields, `ringOut`, their presets. `AudioReverbZone.output` (bus) depends on the owner's routing ruling |
| C12 materials | **met** | theirs, with attack and release and `none` |
| C13 one-shots, events | **met** | `sends.reverb` plus one aux bus; `occlusion` in `spatial`; one-shot `lowpass`/`highpass` |
| C14 physics ray query | **partly** | `_worldRaycast(..., { layers, includeTriggers })` plus `hit.node`. Also needs an allocation-free form (an `out` object, a precomputed groups mask) and **exclusion in the query** (issue 3) |
| C15 debug info | **met** | `lowpassBy` with `parent`; `zones[].why` is better than my fields |
| C16 sidecar | **met** | |
| C17 per-voice filters | **partly** | the fx pool that replaces `VoiceAuto.filter` is acceptable if M2's goldens stay bit-identical; the pool size must change (issue 4) |
| C18 work units | **partly** | name the coefficients in `cap::wu`: `BED_VOICE` 500, `BED_DECODE` 20,000, `AMBI_ROTATE` 2,000, `AMBI_READ` 8,000, `ZONE_BASE` 8,500 + `ZONE_PER_S` 4,500, `SEND` 300, `BIQUAD` 1,200 (exists). Then `workBed`/`workZones` sum them (S12) |
| C19 benches | **partly** | adopt their scene names; add `m3-worst-high`, `m3-worst-default`, `m3-worst-low` ([ARCH §7.2]), all `pace=1` |
| C20 voice table | **met** | |
| C21 Babylon | **met** | F2's "inert on the fallback" outcome is acceptable best effort |
| C22 editor SDK | **met** | no new SDK point. I correct my C22 |
| C23 presets | **met** | |
| C24 counters | **partly** | adopt their names; add `irFailures`, `zonesFaded` (their `why` covers the reason) and `dopplerClamps` on main |

## 3. Their S1–S20 against [ARCH]

| # | [ARCH] status | What I change in round 3 |
|---|---|---|
| S1 staleness | met | add their "zone active set re-plans every 4 frames". The command latency is 1 quantum p50 and 3–5 at p99 after the post ([A157 §4.2]), not "at most 1 frame" exactly, but it is under one frame at 60 Hz |
| S2 listener | met | adopt the 0.001 rad threshold and the axis map `(X, Y, Z)_ambix = (−z, −x, +y)`. Head-turn budget: ≤ 50 ms is met (same batch and `rampFrames` as the directions, so no skew) |
| S3 ownership | partly | agreed except one value: the sharing chain's snapshot low-pass moves to main as they propose (`lpBy` 6), so the core folds **gains only**. I drop `foldLp` from [ARCH §4.3] and C17 |
| S4 wide rings | partly: adopt | 16,384 frames over adjacent slots. Condition: B4's test includes a **300 ms decoder stall** (the 0157 messaging spike's case). A main stall doesn't matter, because chunks go worker → worklet. If the stall test fails, use 32,768 frames (k doubles) |
| S5 MagLS | met with 0xFFFF0100 | one difference: if the blob is missing, beds still run on the stereo decode (their cardioid matrix) instead of being refused, so bus routing and meters don't jump. Minor; either works |
| S6 memory | partly | adopt their bed numbers (272 / 168 KB with the `BedVoice` pool), the fx pool sizes (as amended by issue 4) and the possible 256 B slot (+256 KB at 4,096 logical). Zones per the owner's ruling (§6), in a fixed region (issue 1) |
| S7 cost model | partly | the filter coefficient is **1.2 µs per biquad** (`BIQUAD`, frozen in [A157 §6.1]), not 0.85; a pair costs 2.4 µs (issue 5). Adopt 0.3 µs per send and 2 µs per rotation per quantum. **HRTF 32 → 8 at high saves ≈ 24 × (7.4 − 0.5) ≈ 166 µs** (frozen `c_hrtf` 7.4 [A157 §6.1]; kernels are capped per quantum and don't change). The typical high scene is ≈ 0.29 ms p50 before the saving, so **net ≈ 0.13 ms (est.)** instead of the record's 0.22. I update [ARCH §5.3, §7] |
| S8 counters, health | partly | add a health column: `oldestOcclusionAgeFrames` amber > 8, red > 30 at 0.25 ms; `fxPoolFull`, `bedsRefused` amber when non-zero; `occlusionOverruns` amber > 1 per second; `zonesRinging` informational |
| S9 STATUS size | met | confirmed: no other STATUS growth (my C7 extras dropped, `bedSwitches` on main) |
| S10 failures | met, one record point | the stereo decode for ambisonic clips on low (`maxBeds` 0) contradicts the record ("decodes to binaural on its own"). I recommend one standalone decoder always (48 KB, cost only while used). For the owner |
| S11 rebuild gap | met | acceptable gap: the rebuild's own 1–3 s. Zones stay silent until resident, then fade in over 100 ms. Old-context tails aren't kept |
| S12 bed cost | partly | confirmed: `workUnits` includes the new terms, with the C18 weights |
| S13 cap | ruled | **score order is unchanged** (a bed voice is just a voice: no "bed first" rule). The cap never turns off a zone or a bed. The ladder ([ARCH §7.3]) is on the owner list |
| S14 kind dwell | partly | adopt the dwell, expressed as **500 ms** (not 30 frames, which varies with frame rate). [ARCH §3.1] will state the three timers together: the 1.2× hysteresis, the 3-frame mixing dwell and the 500 ms kind dwell. A flapping source then changes kind at most twice a second |
| S15 bed host changes | met | [ARCH §2.1]: Moving (45 ms dual encode) and Draining (2 quanta of decoder history flushed, not cut) |
| S16 render order | met except | wet destination: owner item (§6) |
| S17 rates | partly | supported 44.1–96 kHz; at 96 kHz zone memory and decode cost double; zones refused above 96 kHz with a warning; a rate change rebuilds |
| S18 rays | partly | adopt; plus allocation-free and exclusion (issue 3). Rays read the last stepped physics state, and moving occluders lag by at most one fixed step |
| S19 listener, Worlds | met | I add it to [ARCH §3.5]: only the World with the view sends LISTENER, casts rays and plans zones; editor audition follows the same rule |
| S20 constants | met | quoted by name. Values that depend on the owner: `MAX_ZONE_SLOTS` (2 or 3) and the eviction fade (150 ms if 2 slots) |

## 4. Issues

1. **Major. Zone state from the arena at ZONE_CREATE** ([API §3.1, §4.2]). Blocks of 1.6–3.1 MB come and go in an arena that is never compacted ([A157 §5.2]). A growth inside `onmessage` can stall the worklet, and a refusal mid-game silences a zone. **Change:** a fixed `Zones` region of `slots × state(maxSeconds)`, sized at init like every other region ([A157 §5.1]: only clips live in the arena). Kernels stay in the IR clip blocks as they propose. `myco_audio_zone_budget_bytes` then sizes the region, not the arena's maximum.
2. **Major. The occlusion budget uses `performance.now()` around each ray** ([API §3.2]). The clock is coarsened to 0.1 ms or worse on pages that aren't cross-origin isolated (the occlusion spike's caveat), so a 0.06 ms budget is noise, and timing each ray costs time too. **Change:** a ray **count** per frame = `budgetMs / rayCost`, with `rayCost` an EMA (α 0.1) over batches of ≥ 16 rays where the clock resolves them, else 3.5 µs ([ARCH §3.2]).
3. **Major. Own-collider skip after the hit.** "Own-node skip" in `occlusion.ts` compares `hit.node` after a first-hit query. A source inside its own capsule then gets its capsule as the first hit and never sees the wall behind it. Each call also allocates (`Physics.ts:83-85`), against "main allocates nothing per frame" ([A157 §6.4]). **Change (D0):** the query takes `excludeNodes` (the source's subtree and the listener's node) and fills a reused `out` hit; `groupsFor(layers)` is computed once per settings change.
4. **Major. Fx pool `max(16, max_mixed/2)`.** In the spike's indoor scene 80% of rays are blocked, so more than half the mixed voices need a filter, and a full pool plays occluded voices unfiltered (brighter behind walls). **Change:** `max_fx = max_mixed` (high 256 × ≈ 320 B = 80 KB). That is cheap and removes `fxPoolFull` as a sound-quality failure.
5. **Major. Filter cost** (S7: "pair 0.85 µs"). 0.85 µs is the convolution spike's per-**instance** filter over 4 summed voices. A per-voice biquad is `BIQUAD` 1.2 µs ([A157 §6.1]). The worst high case (288 filtered voices) is ≈ 0.35 ms, the largest M3 term ([ARCH §7.2]). **Change:** the cost rows use 1.2 µs per active biquad.
6. **Major. IR blobs through main** ([API §4.6]: "main sends it as ordinary CLIP_CHUNKs"). That puts up to 3.2 MB per zone on main's port and through main's GC, and contradicts 0157's rule that main stays off PCM paths. **Change:** the worker sends CLIP_BEGIN/CLIP_CHUNK format 3 to the worklet over the existing worker ↔ worklet `MessageChannel`, as M1b clips do; main gets `irPrepared` with timings only.
7. **Major (industry rule). The send is taken after the dry distance gain**, with a default curve rising 1 → 3 ([API §1.2, §4.5]). With `inverse` rolloff from 1 to 100 the dry path falls ≈ 40 dB and the curve gives back only 9.5 dB, so distant sources go dry, the opposite of a room. Wwise attenuates the aux send with its own distance curve, independent of the dry curve [U]. **Change:** take the send **before** the distance gain (after voice volume, fade and automation) and default `sendCurve` to a gentle fall (1 at `minDistance` to 0.5 at `maxDistance`, est.). The listening pass tunes it.
8. **Minor. `AudioSource` "spatial only" defaults.** Their `reverbSend` defaults to 1 everywhere and is ignored for flat sources: fine. Their `dopplerLevel` default 1 is spatial only: agreed.
9. **Minor. FuMa clips stored as f32 whatever `clipFormat` says** ([API §2.4]) double a 16-channel clip's memory. Scale FuMa's channels into int16 headroom at import instead (the max SN3D/MaxN ratio is known per order), or document the cost.
10. **Minor. The 30-frame kind dwell is frame-based** (S14). Use 500 ms.
11. **Minor. The send scale reaches 8×** (`reverbSend` 2 × curve 4). This is safe behind the limiter but can clip a zone's input before normalisation. Clamp the product to 4.
12. **Minor. Eviction with a 150 ms fade** (S20, [API §11.7]) cuts a ringing tail whenever a third zone is needed. This is acceptable only if the owner keeps 2 slots (§6).
13. **Minor. The zone registry's 64-zone cap with a linear test** is fine (0.05 ms). State that zones past 64 warn by name.

## 5. The wire and settings conflicts the coordinator listed: proposed resolutions

| Conflict | Proposal | Reason |
|---|---|---|
| BED_CONFIG: `bedSlot`+`owns` vs `u16 host[busCount]` | **theirs** | one value per bus, and the core can't be sent an inconsistent owner set; slots are a core detail |
| SET_VOICE_FX (4 sends, hp 10 off) vs SET_FX (2 sends + aux, hp ≤ 20 off) | **theirs**, plus `send2` (mask bit 5, 48 B) only if the standby slot is ruled in | the aux send serves event `sends.<bus>`, which I missed; 20 Hz as "off" is fine; sends = zone slots |
| LISTENER 32 B world→listener vs 36 B listener→world + flags | **theirs** | the snap flag handles camera cuts; the direction is a convention, now written once with the axis map |
| ZONE_CONFIG vs ZONE_CREATE/UPDATE/DESTROY | **theirs**, with `returnBus` in CREATE's reserved word and ZONE_UPDATE `voiceId` 0xFFFF for the shared return | explicit lifecycle and zone events suit ring-out and REPLAY better than a table diff |
| MagLS id 0xFFFF0001 vs 0xFFFF0100 | **0xFFFF0100** | mine falls in the HRIR's reserved range (0xFFFF0000..=0xFFFF00FF, `envelope.rs`) |
| `myco_audio_init_spatial` vs extra `myco_audio_init` params | **theirs** (extra params) | ABI 2.0 anyway; one deterministic layout call |
| `bedPriority` 0..255 / 128 vs −100..100 / 0 | **theirs** | symmetric about the default, and the default isn't a magic number |
| `zones.maxActive` 0..3 vs 0..2 | **0..2** | the active count; a standby slot (if ruled) is extra and not user-set |
| `doppler.maxSpeed` 150 vs 100 | **100** | unmeasured either way; 100 u/s guards a 360 km/h step, and the listening pass tunes it |
| `reverbSend` 0..1 vs 0..2 | **0..2** | matches bus gains and Unity's headroom; the product is clamped (issue 11) |
| `ambisonic.maxClips` (theirs lacks it) | **drop it** | their adjacent-slot rings bound wide streams by the preset's ring count without a new region (S4 condition) |
| `equalPower`: beds with an equal-power decode vs no beds | **beds with their stereo decode matrix** | the record says "decodes beds to equal-power stereo"; keeping beds makes bus effects, meters and folding behave the same in both modes, and their cardioid matrix is the decode |
| Zone IR presets | **theirs** (room, corridor, hall, cave, open; generated in the worker) | better described; one generator shared with `convolver/ir.rs` |

## 6. The owner list: my recommendations (not settled)

- **Default preset HRTF count: 8.** Beds exist on default (`maxBeds` 2). This saves 8 × 6.9 ≈ 55 µs, and one rule, "8 where beds exist", reads better than a preset exception.
- **Zone memory peak: a standby slot** (3 slots on high and default, 2 on low), so tails ring out and a swap doesn't cut one (sound designer review). Peak 18.0 / 9.2 / 3.3 MB against 12.2 / 6.2 / 1.5 MB with 2 slots and the 150 ms eviction fade. If memory wins, the 2-slot design is coherent; then the editor should warn when a layout makes swaps likely.
- **Load-shedding ladder:** steps (1) cut releasing tails with a 100 ms fade and (2) one active zone fewer for the session, triggered like the cap (real trouble only, once the cap sits at its floor). Never change beds or `voices.hrtf`.
- **The root owning a bed by default: yes** (both documents agree): distant voices are 3D out of the box.
- **Zone wet routing: a return bus per zone** (`output`, default Master), added before that bus's effects. It gets a fader, ducking and a meter at no cost, and follows Wwise's aux buses. Theirs (the output before MASTER, like the shared reverb) bypasses every bus.

## 7. Agreements

- The bed resolution algorithm ([API §2.1]) matches [ARCH §2.1]: priority, losers share, the root as fallback.
- Gain folding happens in the core from BUS_MIX gains and automation multipliers. Ducking needs no main fold, and the < 0.05 dB test is the right check. Snapshot low-pass folding moves to main (`lpBy` 6).
- One per-voice filter path shared with automation's low-pass (lowest wins), bit-identical to M2 for automation voices.
- Off-thread IR preparation with the worker keeping encoded bytes; re-preparing on a rate change and on REPLAY; zones silent until resident.
- Doppler on main into `pitch`, with OpenAL's form, the teleport guard, and a reset when dt > 0.25 s.
- `stagger` planning only at create or destroy; the shared reverb as instance 0, bit-identical.
- STATUS to 144 B with `beds` and `zoneEvents`; 15,856 B worst case fits.
- The industry map in [API §1.6]; occlusion per hit in dB with the lowest cutoff; the −60 dB floor.
- The critical path and the named reserve. The ≈ 33 pw total against the record's 22 is mostly priced tests and tooling; the coordinator should carry it to the owner as is.

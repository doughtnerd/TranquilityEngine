# 0166 interactive music: senior engineer's review of the architect's round-1 documents (round 2A)

Reviewed: `architecture.md` (**Arch §n**) and `contracts-architect.md` (**C1-C18**), in the architect's worktree. Also read first, as asked: spike S1 (`streams-align/README.md`) and spike S3 (`beat-clock/README.md`). My contracts S1-S14 are in `contracts-senior.md`; my document is `api-and-models.md` (**API §n**), unchanged until round 2B.

## 1. Verdict

**Approve with changes.** The architecture is sound and follows the spikes closely: prime-then-stamp, the gate, design A for beats, dispatch before `update`, hold-and-resync on rebuild, and the pool all match S1 and S3. It is simpler than mine in one place (the due list needs no per-voice op storage) and more complete in another (every stamped record, not only STOP, FADE and SET_PARAMS gain and pitch, applies inside its voice). I will **adopt their in-voice mechanism and drop my `Timed` op table.** One issue blocks agreement (the voice slot has no room for what §4.3 and §4.4 put in it), six are major, nine are minor. Nothing reopens scope.

## 2. My contracts S1-S14 against their document

| # | Status | What is needed |
|---|---|---|
| S1 prime lead | **Partly met** | Accepted: lead = 1.25 Ê + L + Δ̄ (Arch §4.1) is the consistent reading of the record's two formulas; seed 40 ms gives 100 ms at 60 Hz. EMA gains 0.5/0.1, re-plan storm 3, far re-target and the lead warning are given. **Missing:** the figure the guide quotes for the least delay between a parameter change and a quantised landing (their numbers imply about 110-140 ms plus the distance to the grid point; state it in §4.2). See issue 9. |
| S2 gate | **Partly met** | §4.3 gives complete, ready, on time, late, a held member STOPped (no longer counted) and RESET. **Missing:** a voice demoted to virtual while held; stamped records for a held voice (issue 3); the core's own give-up (issue 10); where membership lives (issue 1). |
| S3 pool | **Met** | The mirror frees a ring when `streamClose` is posted, and the close is posted in the STATUS handler at voice end (§2.3), which removes the one-STATUS lag. The worker posts STREAM_CLOSE on its own port (`decoder/streams.ts:453`), so close-then-open order holds. Refusal then retry, stinger dropped (§4.1). **Change:** a refusal that can never resolve (issue 5). |
| S4 beat contract | **Partly met** | Window, coalescing, correction by shifting t₀ by the slip and the dispatch slot are given (§4.5). **Missing:** the tolerances I test to as a contract (I propose at least 95% of steady beats in the ideal frame, 0 missed, doubled or phantom on the spike's traces) and the largest correction applied without a glitch. |
| S5 STATUS | **Met** | About 0.2 KiB per block. I recompute the worst case under C2 and C4 in 2B (§3: unchanged at 16,248 B). |
| S6 memory | **Partly met** | Rings, encoded copies and main-side tables agree with mine. **Wrong or missing:** the group table "16 x 16 B" cannot hold membership (issue 1); curve state "16 / 64 / 64 KiB if the slot grows" is avoidable (C6 below); no mixer wasm estimate (mine: +14 KB est. against the 320 KB tripwire; they should confirm or give theirs). |
| S7 cost | **Met, with a note** | §7 reproduces spike S4's scenes and states the gates (the stamped scene within +60k instructions, split counter 0). Issue 11. The 10% gate for the new scenes is not stated; I assume M3's. |
| S8 failure | **Met** | §8 rules every row: a stem that fails to fetch or decode plays without it with one warning (all fail: refuse); a worker crash re-primes; recovery limit 3 per 60 s. |
| S9 hidden tab | **Mostly met** | Commit-ahead under `play`; switch changes planned while hidden (better than my "held until resume"); STATUS-driven tick; a `count 0` loop needs nothing (the worker wraps). **Missing:** the audible gap on resume under `mute` (their open point 6 changes it). |
| S10 rebuild, rate | **Mostly met** | Gap up to one bar plus lead; re-entry at `sameTime` from the heard position; origins as musical position plus heard time. **Not addressed:** the 44.1 to 48 kHz splice rule for a loop wrap (I have only read it from code too); both of us leave it to a reserve item (RS3). |
| S11 constants | n/a | Mine. They quote `syncGroup`, "at least 16 groups", "at least 200 ticks"; I rename and size to match (C3, C18). |
| S12 frame order | **Met** | C17 takes the same slot. I adopt their system name `engine.AudioBeat` and `after: ["engine.UIDocumentEvents"]` (transitively after `engine.Lobby` and `PredictionSmooth`). |
| S13 rhythm | **Partly met** | A runtime toggle rebuilds the context through the device path (§4.6), replacing my "no live toggle". **Not addressed:** the `outputLatency` sanity rule (0, constant or above a bound, giving a "reliable" bit), the fallback when the browser clamps the hint, the glitch policy at hint 0. Their "every music command is stamped" makes my API §1.5 line "refuse asap" moot: `immediate` is now + lead. I follow them. |
| S14 loop tail, `while` | **Mostly met** | Commit point E_k - L - Δ̄ - 10 ms, latency about 60 ms, tails as decoded span voices (§3.5). **Missing:** whether a tail may be refused (the clip ceiling can refuse a span); say one warning and the loop continues. |

## 3. My answer to C1-C18

| # | Answer |
|---|---|
| C1 music ring class | Met by API §3.1, §4.3, §4.5: `max_music_rings` in `InitParams` (0..16), STREAM_OPEN `music` flag, music opens take only music rings and the reverse. **Difference:** I report a full pool as stream event **4** (`musicFull`), not 3, so a bug signal (`musicRingRefused`) is not confused with an error end; they should adopt 4. |
| C2 primed bits | Change in 2B. My `primed` section lists only primed rings by stream id. Theirs needs the epoch: a re-target restarts a ring, and a STATUS in flight would show the old epoch's primed state so main would stamp early. New section `musicRings {u32 streamId; u32 epoch; u32 flags}` (bit0 primed, bit1 bound), every open music ring, at most 16 = 192 B. |
| C3 PLAY sync group | Met by API §4.1 with changes: my `gate` u16 becomes a 10-bit `groupId` (1..1023) and a 6-bit `groupSize - 1` (1..64; they need 32); distinct from PLAY's `group` (the automation group). Core group table: 16 entries (mine was 8). A decoded single voice (a stinger) is ungated (id 0). |
| C4 group-start events | Change in 2B. One event **per group** (`{groupId u16, flags u16, slipFrames u32, startFrameLo u32, startFrameHi u32}`, 16 B, at most 8 per STATUS) replaces my per-voice list; the record's "per voice" is redundant when all members start on one frame. Counters `streamStartsLate`, `groupsLate`, `maxSlipFrames` stay. Added (+0.5 d): the core also counts an ungrouped stream voice that starts after its stamp, which is what `streamStartsLate` is for. Worst case: 15,904 - 144 + 168 + 192 + 128 = **16,248 B**, unchanged. |
| C5 fade law, start phase | Changes in 2B. FADE `flags` gain `law` (bits 1-3: 0 linear, 1 sCurve, 2 equalPowerIn, 3 equalPowerOut) and a `startPhase` u16 in a new word (FADE 28 B); SET_PARAMS gets `law` in `flags` bits 8-10 and `startPhase` in an appended word (60 B). STOP keeps its layout; a stop with a law is sent as a FADE to 0 with `stopAtEnd`. **My FADE `from` field goes** (issue 2). |
| C6 curve state | **Not in the slot.** The slot is 192 B by my field count (API §3.1; the assert is only `<=`) and the one spare byte is the only free byte. Answer: a fixed pool of 255 curve entries (my `Timed` region shrinks to 255 x 32 B = 8,160 B), linked from the spare byte; a curve fade with the pool full degrades to linear and counts `curvePoolFull`. This beats a parallel array (16 / 64 / 64 KiB) because only music uses curves. |
| C7 split counter | Met in kind: `splitQuanta` becomes "quanta the due-list overflow split" (their `dueOverflow`); I add `voiceSplits` (class S voice-local splits) so a regression is visible. Both in the STATUS header. |
| C8 `primeGroup` | Met by D1a and D1b (group open, breadth-first prime, cancel). 2B adds re-target (same message, new epochs) and `groupOpened` diagnostics (+0.5 d). Issue 4 on bytes. |
| C9 settings | Met by API §2.1 (`music.rings`, `rhythmMode`). A runtime change rebuilds the context (Rh1 includes it). |
| C10 backend seam | Not in API. 2B adds a `MusicBackendCaps` description to `backend.ts` (primes, stamps with laws, heard clock, rhythm) and the operations they list (+0.5 d in P7). The Babylon table (API §8) already matches their platform matrix. |
| C11 debug | API §1.6 lacks: tick, matched rule or common parent, group states and primed n/N, last prime time with Ê and lead, `missedBeats`, recoveries by cause, stinger outcomes, the high-water mark. 2B adds them (+0.5 d in P10). |
| C12 input, calibration | **One disagreement.** They make `Audio.timeAt` subtract `Audio.calibration`. I keep `timeAt` physical (raw heard time) and put the correction in `positionAt().judged` (API §1.1). Baking calibration into a clock function makes it wrong for every non-judging use and hides the sign. Their stale flag I accept: `Audio.calibrationStale` after a device change, value kept (mine cleared it). |
| C13 validation | Met (API §2.3, §2.6). 2B adds: a tail lies after its region's end and inside the file; `pitch` on `AudioSource` and `EventOptions` is ignored for music with one warning, not only pitch automation (issue 12). |
| C14 span clips | **Unpriced in my table.** A registry entry for a frame span (decode `[start, end)`, own id, at most 30 s, counted against the ceiling). New row R4c below (+3 d). |
| C15 callback fields | Met by API §1.1. 2B adds `skippedCues: string[]` on a coalesced cue event, answering their open point 4 at no cost. |
| C16 Replayer hand-off | Met by P9 and Z4; +0.5 d for the `musicGroups` hook and the last-record log. |
| C17 `engine.AudioBeat` | Adopted: name, phase, order, `beginFrame`. It acts only in the World that has the view (as `engine.Audio` does); the system catalog test and the `worldsConfig` fixtures list it. |
| C18 ticks, conversion | Met: 960 per beat (>= 200). One module, `engine/audio/musicGrid.ts`, serves runtime, validator and editor. 2B states the rounding rule exactly: position to integer ticks, seconds summed per tempo span as `ticks x 60 / (bpm x 960)` in float64 in tick order, frames = `Math.round(seconds x rate)` once per stamp. |

## 4. Issues

### Blocking

**1. The voice slot cannot carry what §4.3, §4.4 and C6 put in it (Arch §4.3, §4.4, §5.3, §6).** The slot is 192 B and full; `reserved` is the one spare byte. Arch §4.4 spends it on the "due" bit; C6 asks for curve state; §4.3 needs each voice's group. A 16-entry group table of 16 B (§4.3, §6) holds no membership list, yet the gate must check every member's ring and a voice-to-group lookup needs a field or a scan. **Change:** use `flags2`, which has 7 free bits: `due` (1), `gated` (1), group index (4, for 16 groups); `reserved` becomes the curve-pool link (C6). The group table is 16 entries x (id, size, present, state, stamp, start frame, up to 32 member voice ids), about 160 B each = 2.5 KiB. I specify this in 2B; the architect's §4.3 and §6 should say it.

### Major

**2. A fade-in is specified as a FADE (Arch §3.2, §4.4, C5).** §3.2 sends "PLAY B (gain 0), FADE B to 1". A FADE moves the voice's `fade` ramp, which starts at 1 and multiplies `gain`, so "FADE to 1" does nothing and PLAY's gain 0 never opens. A fade-in is a stamped **SET_PARAMS gain** ramp from 0 with a law (class G, gain only); the fade-out is a FADE to 0 with `stopAtEnd`. That is why my `from` field goes and their `startPhase` comes in. §3.2 and §3.7 ("5 ms fade-in (class G)") need the wording.

**3. Stamped records for a voice that has not started (Arch §3.6, §4.4).** In a crossfade the incoming group's gain ramp and the outgoing fade carry the same stamp T - X. If B's group is late, B's ramp frame has already passed when B starts. Rule needed: a due record for a SCHEDULED or held voice waits and applies at the voice's start sample, in frame order, is not counted in `lateCommands`, and its ramp runs from that start (so a late B fades in over the full X after A has gone: the hole §3.6 admits). Say too that a held voice's record stays in the pending queue across quanta rather than being consumed by the due list.

**4. Every prime re-fetches the encoded bytes (Arch §4.2).** Main "fetches through `Assets` on each prime and transfers the bytes; it keeps no copy". Every transition then moves about 35 MiB (8 MP3 stems of 4.4 MiB) through the main thread, and the fetch sits inside Ê: cached it is milliseconds, cold it is hundreds, so Ê is bimodal and the asymmetric EMA (0.5 up, 0.1 down) swings. **Change:** the worker keeps the encoded copy of each *closed* music stream of the playing container (their §11 "worker-side encoded cache", pulled into M4), bounded by the encoded-memory figure plus one set (35 MiB on low, the owner's call under decision 4), so a re-prime costs open, seek and first chunk only. Cheapest alternative: keep as drafted and measure on the phone first. I price the cache at 3 days (D1c), conditional.

**5. A refusal that can never resolve retries forever (Arch §4.1, §8).** "Refuse this grid point, retry at the next allowed point after rings return." On low (8 rings) a segment of 5 or more streamed stems cannot fit beside the playing one; no ring returns, so the planner evicts, refuses and retries at every bar for the whole piece. **Change:** classify at admission: a group that cannot fit even with every other group closed, or needs more than the pool minus the playing group, is a **permanent refusal**: one warning naming the numbers ("needs N rings, this preset has M"), the transition dropped, no retry. The lint (API §2.6) reports the same number at load.

**6. Stem starve and resync (Arch §8, §11, open point 7).** Three details. (a) The core does not stay starved: a starved stream voice resumes by itself with a 5 ms fade-in once 4,096 frames are back (`stream.rs` header), so "the starved stem fades out and holds" happens only if main STOPs it on seeing it in `starved`; say so, or the stem resumes skewed under the new group. (b) The resync primes a second set beside the playing one: impossible on low with 5 or more stems, and it takes the whole pool on default with 6, so it fails exactly when it is needed. (c) A slow worker is the cause, so the re-prime is likely slow too; the recovery limit (3 per 60 s) is the only brake. I accept the resync for M4 and price it (P12, 3 d, new: in neither the record's table nor mine). A core-side group hold on starve (their §11) would cost about 3 days in C2b and delete P12 and the two-set need; I recommend it to the owner as the alternative but do not take it unasked.

**7. `Audio.timeAt` minus calibration (Arch §4.6, C12).** See C12. This is public API semantics, so I flag it for the coordinator's ruling; my reading stays until then.

### Minor

**8. Class split and control-rate curves (Arch §4.4).** I accept the split (class G inside the gain loop, class S a voice-local split), the 256-record due list and the overflow counter. Two additions. A curve fade stamped at sample k retargets at k and then at each quantum end; define u at both so a mid-quantum start has no kink. The error is stated as about 3.5e-5 (-89 dB) for a 250 ms equal-power fade; below about three quanta (8 ms) an S-curve is a two-step staircase, fine under 20 ms as they say. My seam goldens (T2) null to 1e-5 against an offline reference, so the reference must use the same piecewise-linear law; I write it that way, or the tolerance is 1e-4.

**9. The estimate Ê (Arch §4.1, §4.2).** The lead adds Δ̄ to an Ê that already includes the STATUS cadence and the frame wait (`t_seen - t_open`); the double count is at most one frame and harmless, but state it. Ê must not be sampled while the tab is hidden (STATUS at 128 ms inflates it, and the 0.5 up-gain makes it slow to recover) or on a cold fetch (issue 4). One EMA per backend mixes Vorbis (1.7 ms open) and MP3 (0.3 ms): keep one, but say it tracks the slower case the planner meets.

**10. Core give-up for a group that never starts (Arch §3.6, §4.3).** The only timeout is main's (`T + max(2 x lead, 1 s)`). If main stalls or the page is hidden, held voices and rings stay. Let the core abandon a group not complete and ready one second after its stamp: end its voices and report the group with an `abandoned` flag (+0.5 d, in C2b).

**11. The ÷ 1.45 factor and the raised allowances (Arch intro, §7.1, §7.2, open point 3).** I agree to raise the default and low worst allowances to about 0.08 and 0.06 ms as tripwires (CLAUDE.md). Two cautions: the 1.45 compares the container's p50 base scenes with the ADR's 1.19 ms, which is a p99.9 figure (spike S4 marks it [U]), so the factor is soft either way; and the model predicts the typical scene at 34 µs against 43-63 measured. Set allowances from the measured numbers, not the model, and label the factor "est.".

**12. "No pitch automation on music tracks" (Arch §3.5, open point 8, C13).** Agreed; I had the same rule. It must also cover the `pitch` field of `AudioSource` and `EventOptions.pitch`, both of which would move stems against the grid: ignore with one warning for music. Yes, a scope restriction the owner should see.

**13. Music seek (Arch §3.9).** "`handle` seek to a musical position (via [API])" has no API in the record or in mine. It is a small transition (exit immediate, enter at a position, 5 ms crossfade). Owner decision whether to add `handle.music.seekTo(position)` (+1.5 d); until then it stays out.

**14. Cue coalescing drops names (Arch open point 4).** Add `skippedCues` (C15). No cost.

**15. Hidden tab under `mute` (Arch §3.8, open point 6).** Running the `play` path under `mute` is cheap to build and keeps playlists stepping; on low it holds both ring sets while silent. The owner's call; I price nothing extra.

**16. Stinger concurrency (Arch §3.4, §5.3).** Four concurrent stingers per instance with a stealing fifth is a new constant; it belongs in the format limits (API §2.5). A stinger is a one-member group only if it needs the gate; a decoded one does not.

## 5. Agreements

- Prime-then-stamp with the worklet-side bit, the gate in the core, breadth-first priming, the pool class and the record's refusal rule, all as spike S1 measured.
- Design A, the window, the coalescing, shifting t₀ by the slip, dispatch before `update` with `beginFrame` idempotent per frame (spike S3's confirming run: 66 of 69 beats in the ideal frame; none missed, doubled or phantom).
- A stamped PLAY does not split (confirmed independently; `scheduler.rs:38-40`, `voices.rs:375-396`), and their class G and class S analysis of the rest.
- Lead = 1.25 Ê + L + Δ̄ (Arch §4.1, open point 2): the consistent reading; I accept it.
- Refusal then retry at the next grid point and a dropped stinger (open point 5), with issue 5's carve-out.
- Hot reload at `sameTime`, music seek never through per-stem SEEK, rhythm mode as a thin layer, the platform matrix, the failure table, the health thresholds and the three benchmark tiers.

## 6. My task table against their design

Their design is simpler than I priced in three rows and more complex in several. Firm changes for 2B (days):

| Row | Change | Why |
|---|---|---|
| Z1 | 3.5 to 4 | FADE `law` and `startPhase`, an appended SET_PARAMS word, the `musicRings` section, per-group events |
| Z2a | 4 to 3.5 | no op table or routing change: `pop_due` into a due list with a flag |
| Z2b | 5 to 4.5 | class G inside the gain loop; control-rate curves are simpler than my per-sample shaped ramps (-1.5), the curve pool and quantum-end retargets add 1 |
| **Z2c (new)** | +3 | class S voice-local split for dir, lpHz, bus, score, SET_PAUSED, SEEK, SET_LOOP, SET_VOICE_FX |
| Z3 | 4.5 to 5 | more stamped goldens (class S) |
| Z4 | 4 to 4.5 | start-phase REPLAY |
| W1 | 4 to 4.5 | group size bits, `musicRings`, per-group events |
| C2b | 4.5 to 5.5 | ungrouped late counter, core give-up, held-voice ordering (issues 3 and 10) |
| D1b | 3 to 3.5 | re-target, `groupOpened` |
| P2 | 4 to 5 | permanent refusal, evicting a primed successor, Ê rules |
| P7, P9, P10 | +0.5 each | backend caps (C10), Replayer hand-off (C16), debug fields (C11) |
| **P12 (new)** | +3 | starve resync (issue 6) |
| R4a | 4 to 3 | tail voices are span-clip voices; no extra ring |
| **R4c (new)** | +3 | span clips in the registry (C14) |
| R5 | +0.5 | four-concurrent stinger steal |

**Firm: +13.5 days** (M4-0 +3.5, M4a +6.5 with P12, M4b +3.5). Conditional and not in that sum: **D1c** worker encoded cache +3 (issue 4), **seek** +1.5 (issue 13), and a core group hold on starve +3 less P12's 3. The total moves from 291 to about 304.5 days (60.9 person-weeks) before the reserve; I recompute the reserve and §10.2's comparison in 2B. The gap to the record's 45-55 person-weeks does not close: their design does not shrink it.

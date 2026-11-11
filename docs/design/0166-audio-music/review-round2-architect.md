# 0166 round 2A: the architect's review of `api-and-models.md` and `contracts-senior.md`

Reviewed: the senior engineer's revision 1 (`api-and-models.md`, **[API §n]**; `contracts-senior.md`, **S1–S14**) against my `architecture.md` (**[Arch §n]**) and `contracts-architect.md` (**C1–C18**). I re-checked the code wherever a finding depends on it. Settled per the coordinator: a stamped PLAY doesn't split the quantum (we both found it).

## 1. Verdict

**Approve with changes. No blocking issues; 7 major, 8 minor.** The format, the gate field, the Timed table, the STATUS growth and the public API fit my timing and failure rules with small changes. The changes that matter:
- STATUS: the `primed` list needs the epoch, and `groupStarts` should be one item per group, not per member. Together they make the budget roomier, not tighter.
- Timed routing: it should go by record (every per-voice record in the voice), not by SET_PARAMS field. Otherwise the format's own `quantize: lowpass` and every stamped play in a reverb zone still split the quantum.
- Rhythm mode needn't refuse `exit: immediate`.
- Bridges work on low.
- The task table can lose about 18 days and the reserve about a third of its size.
- I don't support folding M4-0 into M4b (§4, issue 5).

## 2. My contracts against their document

| # | Status | Exact change needed |
|---|---|---|
| C1 music ring class | **met** | [API §3.1, §4.3]: STREAM_OPEN `music` flag, rings `G..G+M`, event 4 `musicFull`. |
| C2 primed bits | **partly** | `primed {u32 streamId}` has no epoch. Make it `{u32 streamId; u32 epoch}` (issue 1). |
| C3 sync group | **met** | `gate` in PLAY's reserved u16: 12-bit id, size 1..16 [API §4.1]. 16 suffices: decoded stingers and tail voices go ungated (id 0), not in a stem group. |
| C4 group-start event, counters | **partly** | One item per late **member** (16 B × 16). Make it one item per group: `{u16 groupId; u16 members; u32 slipFrames; u64 startFrame}` (issue 2). Counters as given are fine. |
| C5 fade law, start phase | **partly** | Curve on FADE only (bits 2–3) and `from`: good. No start phase, so a curve fade already running at a rebuild can't resume mid-shape. Either add a u16 phase or state that the Replayer sends the remainder as a **linear** FADE from the computed value (my preference: the latter, documented; issue 13). |
| C6 curve state per voice | **met** | The Timed side table (255 × 128 B, 32 KB) with a link in `reserved` beats my slot growth (64 KB on default and high). I adopt it in 2B. |
| C7 split counter | **met** | `splitQuanta` plus `timedOverflow` [API §4.4]. |
| C8 `primeGroup` / `groupOpened` | **partly** | D1a/D1b exist but the message isn't specified anywhere in [API §4]/§6. It needs: group id; per member stream id, epoch, bytes, start frame, region, music flag; re-target with new epochs; `groupOpened` marked diagnostics only. |
| C9 settings | **met** | `music.rings`, `rhythmMode` [API §2.1]. |
| C10 backend seam | **partly** | `backend.ts` is listed but no operations or capability flags are given. Add the music operations (admit/prime, primed state, stamp group, cancel, group events) and a capability record the player branches on (§8 rows). |
| C11 debug fields | **partly** | [API §1.6] has most of them. Add `primeLastMs`, recoveries by cause, missed beats, stinger outcomes (`late`, `skipped`), the pool high-water mark, and `groupTimeouts`. |
| C12 input mapping | **met, I change** | Their split is cleaner: `Audio.timeAt` stays the raw clock map and `MusicPositionAt.judged` = offset − calibration. I drop "timeAt minus calibration" in 2B. |
| C13 validation | **met** | Pitch automation dropped, length tolerance 1,024 frames, one rate per segment, tail ≤ loop [API §2.3, §2.6, §11.13]. |
| C14 span clips for tails | **not met** | R4a says tails are "decoded, or a short-lived ring". Add a clip-registry span decode (`[start, end)` of an asset as its own clip id, ≤ 30 s) and a task for it (issue 10). |
| C15 callback fields | **met** | `MusicEvent` [API §1.1]. |
| C16 Replayer hand-off | **partly** | Z4 and P9 cover it in passing. Say explicitly that `Replayer.restore` passes music-group voices to the player and excludes them from `reopenStreams` (`core/replay.ts:500`). |
| C17 beat system | **met, I change** | Their `engine.AudioMusic` (after `engine.Lobby` and `engine.PredictionSmooth`, before `engine.UpdateScripts`). I adopt the name and order. |
| C18 positions | **met** | 960 ticks per beat; one conversion, golden-tested in G1 [API §2.2]. |

## 3. Their contracts S1–S14

| # | Answer, or what I add in 2B |
|---|---|
| S1 | [Arch §4.1, §5.3]: **lead = 1.25 Ê + L + Δ̄** for an unprimed group, **L** for a decoded or already-primed one. Ê is seeded at 40 ms, so the first lead is 100 ms at 60 Hz. Ê is an asymmetric EMA (0.5 up, 0.1 down) with floor 0. Re-plans **never** become refusals: only the pool refuses; three in a row warn (`replanStorm`). The record's max(horizon, 1.25 × EMA) can't meet its own deadline T − L − Δ̄ (my open point 2), so the guide should use mine. **Guide figure:** the least time from a parameter change to a quantised landing is lead plus the wait to the grid point: ≥ L (21.3–33 ms) for decoded or primed targets, ≈ 100 ms default for streamed ones, plus up to one grid interval. In 2B I'll add an explicit floor and say Ê is per backend and resets on a new context. |
| S2 | [Arch §4.3] has the core rows. In 2B I add the missing ones as a table: **incomplete** at the stamp's quantum → treated as not ready (wait); **member STOPped while held** → it leaves the group and the size decrements; **member virtual** → still a member, same readiness rule (a virtual stream voice binds and consumes); **longest wait** → the core waits without limit, and main stops the members at T + max(2 × lead, 1 s) (`groupTimeouts`); **RESET** clears the table. A group's entry is freed at its start (on time) or after its late report, so 8 entries suffice for ≤ 4 instances. |
| S3 | [Arch §2.3, §4.1]: main counts a ring **free when it posts `streamClose`**. Close and later opens share one worker→worklet port, in order. No STATUS arithmetic, no one-STATUS window. A refused transition retries at the next allowed grid point after rings return; a refused stinger is dropped. A primed-but-unstarted successor is evicted before any refusal. |
| S4 | [Arch §4.5]: tolerance as the spike gives it; the window is `[Audio.time, Audio.time + Δ̄)`; dispatch slot as yours. **Corrections:** a late group shifts the anchor's heard time by slip/sr, of any size. Indices never re-fire, so no double or skip; a correction larger than one beat makes the next dispatch coalesce. 2B adds this sentence. |
| S5 | [Arch §1, §5.2]: no other STATUS growth in M4; `primed` visibility is ≤ 16 ms + one display frame. Issues 1 and 2 change the sections: +64 B and −240 B, so about 312 B spare. The next growth raises `STATUS_BUFFER_BYTES`. |
| S6 | [Arch §6] has the per-preset totals. Music rings sit outside `clipMemoryMB`. In 2B I'll add the lint threshold: warn when the encoded bytes of two sets of a segment's streamed stems pass 48 / 96 / 160 MiB on low / default / high (est.). Your Timed figure replaces my curve-state row. |
| S7 | [Arch §7.1]: gate < 0.01 µs per waiting member; a Timed gain op ≈ 0.1 µs; a voice-local split ≤ one voice (≈ 2.7 µs reference); a curve law ≤ 0.15 µs per fading voice at control rate (683 ns wasm per voice if per sample: fine either way). Metered thresholds 10%. Allowances: my open point 3 (raise default and low worst to ≈ 0.08 / 0.06 ms). |
| S8 | [Arch §8]: **graceful at prime and at play.** A stem that fails to fetch or decode while priming is dropped from the group (one warning); the segment refuses only if every streamed stem fails. A mid-play stream error fades that stem (50 ms, today's path) and the group plays on. Worker crash mid-prime: re-prime once the channel is back; past the recovery limit, stop. `groupStarts` can't go missing: the core carries reports over, and main's group timeout covers a stuck gate. I'd rather not have all-or-nothing at load: a missing layer is better than silence (Wwise plays a missing media file as silence [U]). |
| S9 | [Arch §3.8]: a `count: 0` loop needs nothing committed (the worker wraps). "A segment ahead" means the next playlist item is committed when the current one starts; `rounds: 0` just keeps doing that. A `musicSwitch` change while hidden is rare (scripts don't run while rAF is stopped) and is planned with Δ̄ = the STATUS interval, not held. Resume gap: 0 under `play`; under `mute`, up to one bar + lead. |
| S10 | [Arch §3.7]: the gap is up to one bar + lead. The music **re-enters at the heard position** (`sameTime`) on the next bar, with a 5 ms fade-in, not from the last grid point. The 44.1/48 kHz splice question doesn't arise for music: releases splice the same file at the same rate, and cross-file seams are primed starts. |
| S11 | Accepted. In 2B I'll quote the names in my constants table. `QUANTIZE_RAMP_MS` 20 is a timing constant, so I take it into my table at 20 ms (est.), with issue 3's routing fix. |
| S12 | [Arch §4.5]: nothing reads the clock between `engine.AudioMusic`'s `beginFrame` and `engine.Audio`'s, which is a no-op at the same rAF time (`clock.ts:148`). The order after Lobby and PredictionSmooth is fine. |
| S13 | [Arch §4.6]: a change goes through the rebuild path (no live toggle beyond that). **2B adds:** `Audio.latency.reliable` is true when 0 < `outputLatency` < 0.5 s and the value isn't exactly 0. A clamped hint is just read back and shown. Glitch policy: a milestone exit check on the owner's devices; underruns show in the existing counters. **No refusal of `exit: immediate`** (issue 4). |
| S14 | [Arch §3.5]: the `while` commit point is E_k − L − Δ̄ − 10 ms (the splice margin), **not** a prime lead, when the exit continues the same files. A prime lead applies only when some stem changes file at E_k (a streamed alternative), issue 9. Tails are decoded span voices (C14), no ring. A tail may be refused while the loop continues: yes, one warning (`tailRefused`). |

## 4. Issues

1. **major, [API §4.4] `primed`.** Without the epoch, a re-target race stamps into a flush. Re-plan of a `sameTime` or explicit-position entry re-targets the group to new epochs [Arch §4.1 rule 2], and a STATUS taken before the new STREAM_OPEN reached the worklet still lists the old epoch's ring as primed. Main stamps, the ring flushes, and the group goes late. **Change:** `{u32 streamId; u32 epoch}` per item (+64 B worst case); main accepts only its current epoch.

2. **major, [API §4.4] `groupStarts`.** Sixteen per-member items for one late 16-stem group carry the same slip and frame 16 times (256 B of the 136 B margin's neighbourhood). **Change:** one 16 B item per group (id, member count, slip, start frame; ≤ 8 per STATUS, carried over). It saves 240 B and is all the beat clock needs [Arch §3.6, §4.5].

3. **major, [API §3.1, §11.2] Timed routing by field.**
   - `quantize` may target `lowpass` [API §2.3]. That is a stamped `lpHz`, which stays queued and splits every voice. A bar-quantised low-pass on 8 stems at 120 BPM is 0.5 splits/s, above S4's 0.375/s p99.9 threshold.
   - Outside music, a stamped PLAY of a mixed voice with non-default sends is followed by a **stamped SET_VOICE_FX at the same frame** (`core/coreBackend.ts:1459`, A162 C3). So every `at`-scheduled spatial play inside a reverb zone splits today, and still will.

   **Change:** route by record. Every queued per-voice record (STOP, FADE, SET_PARAMS any mask, SET_PAUSED, SEEK, SET_LOOP, SET_VOICE_FX) goes to the voice's Timed entry. Gain and pitch use the shaped/linear ramp, and the rest use the in-voice split loop Z2b already builds (the voice renders `[from, k)`, applies, then `[k, to)`) [Arch §4.4 class S]. It is the same loop, so this is about +1 d in Z2a/Z2b, and `splitQuanta` then really reads 0.

4. **major, [API §1.5], S13: rhythm mode refuses `exit: "immediate"`.** In my planner every music change is stamped, `immediate` included: T = now + lead [Arch §4.1, §4.6]. There is no asap music record to refuse. Refusing removes a rule kind from rhythm games for no timing gain. **Change:** drop the refusal and the `rhythmAsap` warning. Rhythm mode's own rule is that recovery re-entry is stamped and callbacks are held during it.

5. **major, [API §11.1, §10.2 (a)]: "M4-0 has little consumer outside music; fold curved FADEs into M4b through the queue".** I disagree, for four reasons:
   - **There are consumers outside music:** the stamped SET_VOICE_FX above (issue 3), and stamped SET_LOOP releases of event sustains (`scheduler.rs:20-21`). Any stamped `handle.stop` or fade also counts.
   - **Music doesn't split "once per transition".** Bar-quantised ramps on every bar (R6), loop-tail and alternative hand-overs at each wrap (stamped STOP of the outgoing pass), stinger steals, and both legs of a bridge all split. At ordinary tempi that is above the 0.375/s rate where S4 puts splits into p99.9.
   - **One split is 538 µs native here, ≈ 0.37 ms reference** [S4], on a high preset already at 1.34 ms against 1.3 ms p99.9 [Arch §7.2]. A split quantum is the underrun the lab VM will find.
   - **The saving is small.** Folding drops Z2a and half of Z2b/Z3, about 11 d, but M4b then needs shaped FADEs in the queue path anyway (the curve state has to live somewhere: your Timed entry or my C6). The real difference is about 7 d.

   Keep M4-0, repriced at ≈ 21 d (issue 6).

6. **major, [API §10]: the task table.** Row by row against what [Arch] needs (est., days):

   | Row | Theirs | Mine | Why |
   |---|---|---|---|
   | Z1 + W1 | 3.5 + 4 | 2.5 + 3.5 | Z1 builds M4a's STATUS sections; keep FADE, counters and the envelope in Z1, and sections, gate and init in W1 |
   | Z2a + Z2b | 9 | 9 | +1 for issue 3, −1 because the voice-local split is one loop for all records |
   | Z4, Z5 | 4, 3 | 3, 2 | the REPLAY rule is mechanical (issue 13); Z5 reuses S4's scene code |
   | C2a + C2b | 9.5 | 7 | the gate is one state machine plus a branch in SCHEDULED; C3 carries the hard cases |
   | D1b | 3 | 2 | cancel is `streamClose`, which exists |
   | P2 | 4 | 5 | Ê, re-target, eviction and retry belong here |
   | P5 | 3 | 1.5 | per-stem automation is 0158's; ring release is the generic end path |
   | P7 / K3 | 3.5 / 2.5 | 3.5 / 1.5 | `Audio.timeAt` is in both |
   | P9 | 4.5 | 6 | rebuild, worker crash, rate change, starve resync and group timeout are missing or unpriced [Arch §8] |
   | P10 / P11 / Ed10 polish | 3 / 2 / part | 3.5 / 0 / 0 | one debug task, three rows today |
   | R2 | 3 | 2 | a switch is a parameter → target feeding R1 |
   | R3b | 5 | 3 | a bridge is two chained plans with sequential priming (issue 7) |
   | R4a | 4 | 3 + 2 (span clips in the registry, new) | C14 |
   | R4b | 4 | 2.5 | release splice exists (`core/streams.ts`), only the condition and commit point are new |
   | R5 | 5 | 3.5 | grid plan + `ifTooLate` + `dontRepeat` + a 4-voice cap |
   | Bench1 | 4 | 3 | Z5's infrastructure |

   Net about **−18.5 d**: tasks ≈ 272.5 d (54.5 pw). The player rows (P1–P6, P8–P11, R1–R6) go from 71.5 to ≈ 64.5 d. That is still far above the record's 4 pw, and I think honestly so: the record didn't price the prime/commit machine, recovery or tails.

   **Reserve:** 96 d on a table that already itemises tests, benches, e2e, docs and a listening rework is double-counting the record's multiplier, and M3 drew 0 of 14 days. I'd set **20% (≈ 55 d)**, keeping RS2, RS5 and RS8 whole. Total ≈ **327 d, 65 pw**: still over 45–55, an owner decision.

7. **major, [API §11.9, R3b]: "no bridge on low".** True only if A, the bridge and B must all be primed at once. In my sequence B is primed **when A's rings return** at the bridge's start [Arch §3.3]: the bridge must outlast A's fade-out + one STATUS + lead_B (≈ fade + 0.15 s), and a decoded bridge needs no ring at all. **Change:** R3b plans sequential priming, and the lint warns only for a streamed bridge shorter than that bound on a preset that can't hold three sets.

8. **minor, S1 / [API §1.3]:** adopt lead = 1.25 Ê + L + Δ̄ (S1 answer). `Audio.play(music, { at })` closer than the lead should start at the next stampable frame **on the grid point at or after `at`**, rather than "as soon as primed" off the grid.

9. **minor, R4b / S14:** the commit point is L + Δ̄ + 10 ms before the wrap, not a prime lead, except when a streamed alternative changes file at that wrap. This shortens the stated condition latency from ≈ 100 ms to ≈ 60 ms.

10. **minor, R4a:** "or a short-lived ring" for tails competes with the pool every pass. Use decoded span clips (C14), no ring, plus a registry task.

11. **minor, [API §9] M4a exit check** "8 stems start within one frame of the stamp" is too weak for the product's promise. Make it "on the stamp's sample, nulling against the reference", as C3's harness already asserts.

12. **minor, [API §3.2] group ids** 1..4095 with "skip live ids" is fine. State that the core frees a group's entry at its start or late report (MAX_GROUPS 8, S2 answer), so an id is never reused while the core holds it.

13. **minor, C5 / Z4:** state the REPLAY rule for a running shaped ramp: a linear FADE `from` the computed current value over the remaining frames. A curve's shape is lost for that one fade after a trap, which is acceptable and saves a field.

14. **minor, C8 and C10:** specify the `primeGroup` message and the backend's music seam in [API §4]/§6. They are the main seams between P1/P2 and D1a/B1.

15. **minor, [API §1.4, §11.6]:** I support `handle.onMusic(kind, fn)` (0.5 d, M4c). Without it a script-played music event has no callbacks, and the record intends callbacks for music, not only for music on a node.

## 5. Agreements

- PLAY doesn't split; M4-0 is about the queued records (settled).
- **Timed side table** instead of growing the slot: less memory, and unstamped voices stay bit-identical. I adopt it (C6).
- The gate in PLAY's reserved u16, 1..16 members, one batch per group; the music flag on STREAM_OPEN with no fallback to general rings; event 4.
- FADE `from` and the curve bits, envelope 1.2, **ABI 3.0**: the init signature changes, and 0162's R6 is the precedent. Every caller is in the repo, so no compatibility shim is needed.
- STATUS 168 B header with saturating counters, and `primed` as a level each STATUS (lost reports self-repair).
- `GridAnchor` as ticks plus heard time, recomputed through the rebased ClockMap.
- `Audio.timeAt` raw with `judged` separate (I adopt), `Audio.latency`, calibration through `Storage` per sink.
- `engine.AudioMusic` name and slot (I adopt); step 9 "music plan" in `engine.Audio` before `frameCommit`, which is my planner tick.
- Exit clamped to the exit cue, pre-entry only for `entryCue`, natural advance at the exit cue, post-exit on its own voices: all consistent with [Arch §4.1].
- `library` for bridges and stingers; `plays`/`rounds` names; `while` vocabulary `is`/`atLeast`/`below`.
- Two-tier validation, the 1,024-frame length tolerance, pitch automation dropped on stems.
- The mixer size raise recorded as a tripwire move; two seniors as the floor; M4a's pure-TypeScript rows starting with M4-0.

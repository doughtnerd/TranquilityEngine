# 0166 technical design: coordinator rulings (after round 2A)

These rulings settle the disagreements between `architecture.md` and `api-and-models.md`. They come from reading `review-round2-architect.md` and `review-round2-senior.md` and checking the code claims both reviews rest on. Both authors revise under them in round 2B.

Anything that changes product behaviour, scope or schedule goes on the owner's list instead (the end of this file). The owner's standing rules apply throughout:
- follow industry practice unless there is a measured reason not to;
- no feature flags;
- tests run at wave end and milestone end.

## Verified before ruling

- **A stamped PLAY does not split the quantum.** PLAY is written to its slot at once and starts at its sample offset (`native/audio/crates/audio-core/src/scheduler.rs:38-40, 218-221`; `voices.rs:375-396`). STOP, SET_PARAMS, FADE, SET_PAUSED, SEEK, SET_LOOP and SET_VOICE_FX are queued, and they split the quantum. The record's revision 2 is wrong here, and S4 was right; this is written back to the record at step 9.
- **Every stamped spatial play with non-default effects already splits a quantum today.** Its SET_VOICE_FX is sent at the PLAY's frame (`src/plugins/audio/runtime/core/coreBackend.ts:1458-1459`), and SET_VOICE_FX is queued. So M4-0 has consumers outside music.
- **FADE moves the voice's `fade` ramp, a separate multiplier that starts at 1** (`voices.rs:159`). It doesn't move `gain`.
- **Main's encoded-bytes cache is capped at 32 MB** (`src/plugins/audio/runtime/core/encodedCache.ts`). Eight 3-minute MP3 stems (≈ 35 MiB) don't fit.
- **The senior engineer's round-1 task table re-sums by script to 291 days** (M4-0 25.5, M4a 101.5, M4b 65, M4c 35.5, M4d 63.5; S 98, M 166.5, J 26.5).

## In-voice stamped records (M4-0)

- **R1. M4-0 stays its own first milestone.** The owner decided it, and the non-music consumers above are real. The fold into M4b is not offered to the owner again.
- **R2. The mechanism is the architect's:** a per-voice due list.
  - **Class G** (FADE, gain-only SET_PARAMS, STOP with or without a fade) applies by comparing the start sample inside the voice's gain loop.
  - **Class S** applies by splitting **that voice's** render only. It covers every other per-voice record: SET_PARAMS fields other than gain (pitch, low-pass, pan and the rest), SET_VOICE_FX, SET_PAUSED, SEEK and SET_LOOP. This takes the architect's major 3: a `quantize: lowpass` binding and stamped SET_VOICE_FX must stop splitting for everyone.
  - Records that aren't per voice (bus, master, listener, configuration tables) keep splitting the quantum, and are counted.
  - The senior engineer's Z2c (class S, +3 d) is in the table.
- **R3. Counters:** `splitQuanta` (whole-quantum splits) and `voiceSplits` (voice-local splits). The M4-0 exit check: `splitQuanta` reads 0 in the music scenes and in a scene of stamped spatial plays with sends.
- **R4. The voice slot stays 192 B** (blocking item 1 of the senior engineer's review). The due, gated and group-index bits go in `flags2`, and the curve-pool link goes in the spare byte. Curve state lives in a side pool of 255 entries. The group table is a separate region (≈ 2.5 KiB). The senior engineer owns the bytes; the architect states the entry count (R9) and the semantics.
- **R5. Crossfades use the `fade` ramp, not `gain`** (the senior engineer's major 2).
  - `gain` stays free for stem automation by parameters, so a crossfade and a parameter fade don't fight over one ramp.
  - A fade-in is a PLAY that starts with `fade` at 0 (a PLAY flag), then a stamped FADE to 1 with a law.
  - FADE, SET_PARAMS gain and STOP-with-fade carry a **law** (linear, sCurve, equalPower in/out) and a **start phase u₀** (C5).
  - REPLAY re-sends a running curve fade with u₀ at its current phase. The FADE `from` field is dropped.
- **R6. Curve laws run at control rate,** as the architect specified: a linear ramp retargeted at each quantum boundary from the smoothstep polynomial or the 1,024-point table.
  - The seam goldens use the same piecewise-linear law, with the tolerance the architect states.
  - Never `libm` per sample.

## The group gate, priming and the pool

- **R7. STATUS:**
  - The `musicRings` section is `{streamId, epoch, flags}`. The flags are primed and bound, and primed means at least 4,096 frames *in the current epoch* (the architect's major 1).
  - `groupStarts` has **one item per group** (group, start frame, slip), at most 8 per STATUS (the architect's major 2).
  - The music pool is stream event 4.
  - The senior engineer recomputes the worst case and the spare bytes.
- **R8. PLAY's gate field:** a 10-bit group id plus a 6-bit size, which is the senior engineer's encoding. The architect states when the core frees a group entry (minor 12).
- **R9. The core's group table** holds **16 entries** (the 4-bit index in `flags2`), unless the architect's freeing rule shows that 8 always suffice. In that case the spare bit stays reserved.
- **R10. A held voice's stamped records** (members of a late group) are **rebased by the group's slip** when it starts, so fades stay aligned to the music, not the clock (the senior engineer's major 3). The architect specifies it; the senior engineer prices it.
- **R11. A stem that starves mid-piece holds its whole group in the core** (the senior engineer's major 6; the architect's extension becomes the design).
  - Every gated member of the group takes the 5 ms starve fade together.
  - They resume together at one offset, once all of them have data again.
  - This replaces main-side resync at the next bar (P12), which needed a second set of rings exactly when the worker is slow.
  - The core gives up on a group that has been held, or never started, for longer than a timeout the architect sets. It reports the group, and main stops it and re-plans.
  - The cost is ≈ the conditional "core group hold" (+3 d), and P12 is dropped.
- **R12. The prime lead is lead = 1.25 Ê + L + Δ̄** (the architect's reading, accepted by the senior engineer).
  - Ê is measured from the prime request to the batch that sees every primed bit, **without** Δ̄ (the senior engineer's minor).
  - Ê is not sampled while the tab is hidden.
  - An `Audio.play(music, { at })` closer than the lead lands on the next allowed grid point, not off the grid.
  - The record's "max(horizon, 1.25 × EMA)" is corrected at step 9.
- **R13. A `while` region commits at L + Δ̄ + 10 ms before the loop end,** unless a stem changes file at that wrap. Then it commits one full prime lead before (the architect's minor 9).
- **R14. Refusals** (the senior engineer's major 5):
  - A need that **can never fit** the preset's pool (from the ring lint) is refused at once, with one warning, and not retried.
  - A transition refused for want of free rings retries at each allowed grid point until the rings are free, or until the target changes.
  - A refused stinger is dropped, and the `ifTooLate` rules apply.
- **R15. Bridges and loop tails:**
  - Bridges ≲ 30 s are decoded clips, like stingers and short loops (the record's format rule), so "no bridge on low" is false. The lint counts the rings a sequence actually needs at its peak.
  - Loop tails are **decoded span clips** (C14; the senior engineer's R4c, +3 d).
- **R16. The worker keeps the encoded bytes of a music instance's files** for the instance's lifetime, refcounted by path, so a re-prime moves nothing through main (the senior engineer's major 4).
  - This is within owner decision 4 (whole encoded files in the worker).
  - It makes Ê unimodal after the first prime.
  - D1c (+3 d) becomes firm.

## Clock, API and rhythm mode

- **R17. The early system is `engine.AudioMusic`,** in the update phase before `engine.UpdateScripts`. It calls `beginFrame` (idempotent) and dispatches callbacks. Each author offered to take the other's name; this is the one to use.
- **R18. `Audio.timeAt(performanceTime)` is the raw clock map.** Calibration is subtracted only in `positionAt(...)`'s judged offset (`judged`). This matches the record ("calibration is subtracted from input offsets") and both reviews.
- **R19. Every music change is stamped in both modes.** Rhythm mode refuses nothing: there is no asap music change to refuse (the architect's major 4). What it adds is stamped recovery re-entry and holding callbacks during recovery.
- **R20. Coalesced cue events carry `skippedCues: string[]`.** At most 4 stingers play at once per instance, and that limit goes in the format limits.
- **R21. Debug:** `Audio.debug().music` is one task, not spread over P10, P11 and Ed10. `Audio.timeAt` is one task, not in both P7 and K3. The wire is one task per record family, not split between Z1 and W1.
- **R22. Exit checks:** stems start **on the stamp's sample** (not "within one frame"), and goldens null against the offline reference.

## Budgets

- **R23. Allowances:**
  - High comes from S4's measured deltas divided by the measured container factor (÷1.45), not the assumed 2×.
  - Default and low are modelled, marked est.
  - The worst-case tripwires for default and low become ≈ 0.08 / 0.06 ms, recorded in the build log as tripwire moves (CLAUDE.md: gates are tripwires).
  - The mixer's size growth is recorded the same way.

## The task table

- **R24. The senior engineer rebuilds the table in 2B:**
  - Apply the architect's row-by-row cuts where a cut removes duplication (R21) or rests on a simpler design in architecture.md.
  - Where the senior engineer disagrees with a cut, keep the row and give the reason in the resolutions table.
  - Add the rows these rulings make firm: Z2c, R4c, D1c and the core group hold.
  - Drop P12.
  - Re-sum by script.
  - Give the total **two ways**: with a reserve of 20% and with a third (owner item 1).

## On the owner's list (not ruled)

1. **The estimate and the reserve.** The tasks come to ≈ 55–61 pw (round 2B will set the figure). With a 20% reserve that is ≈ 66–73 pw; with a third, ≈ 73–81 pw. The record's provisional range is 45–55 pw, which neither author's table supports.
   - The architect argues for 20%: M3 drew none of its 14 reserve days.
   - The senior engineer argues for a third: the listening pass, the phone and the editor are untested.
   - The owner may also take the scope cuts the senior engineer listed: drop `while` regions and loop tails (≈ 11 d with R4c), the rules table's audition and lint (≈ 4 d), the rhythm sample (4 d), Babylon beat callbacks (2 d).
2. **No pitch automation on music tracks** (and pitch on `AudioSource` and `EventOptions` ignored for music instances). The beat clock and loop prediction need a fixed rate. This narrows the scope; Wwise music tracks don't pitch either.
3. **`handle.onMusic(kind, fn)`** for scripts that play music with `Audio.play` and no node (+0.5 d). Both authors recommend it. It extends the owner's callback decision (component messages plus `handle.music`).
4. **A public music seek** (`handle.music.seek(position)`, +1.5 d). Seek exists internally for audition and hot reload; whether games get it is scope.
5. **A hidden tab under `audio.background: mute`:** commit ahead as under `play`, so music resumes in place (the architect's recommendation), or re-plan on resume, as the record says.
6. **The starve behaviour (R11):** when one stem runs dry, the whole group dips and resumes together, rather than one stem dropping out. This is a ruling, reported because it is audible.

## The owner's answers (2026-11-11)

The owner accepted every recommendation, recorded in [ADR 0167](../../decisions/0167-interactive-music-design-corrections-and-owner-decisions.md):
1. **The reserve is 20%** (58 d, the named items in the API's 20% column). No scope cuts are taken. 290.5 d of tasks + 58 d = 348.5 d ≈ **69.7 pw**.
2. **No pitch on music** (+0.5 d).
3. **`handle.onMusic(kind, fn)`** (+0.5 d).
4. **A public `handle.music.seek(position)`** (+1.5 d).
5. **A hidden tab under `mute` commits ahead, as under `play`** (0 d).
6. **The starve group hold (R11) stands.**
7. **0166's corrections go into ADR 0167, an amending record**, not a revision section. The owner asked whether every recommendation follows industry standards. This one didn't (CLAUDE.md and ADR practice keep accepted records immutable), so it was changed. Item 6 is the project's own design: the middleware surveyed treats starvation as a fault, and its handling is unverified.

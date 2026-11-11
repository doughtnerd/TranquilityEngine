**Verdict: approve with changes.** Top concerns: (1) the prime acknowledgement comes from the wrong place, so the plan can't rely on it; (2) rebuild, seek and worker respawn restart stems one by one, which brings back the permanent, silent skew that priming exists to prevent; (3) the worker fills rings depth-first, so the prime lead on the phone is about 2× the record's 100 ms.

Read: the record, goal.md, the spike README and its `streams-align`, `stream-throughput`, `beat-clock`, `cost`, `rhythm` READMEs, and the cited code.

## Issues

1. **blocking: the ack isn't ground truth.** §3 says "the worker acknowledges each stem when its ring holds at least 4,096 frames". The worker can't know that: chunks go worker→worklet and the ack worker→main, on different ports (S1 "Unverified", bullet 3). The worker posts `streamOpened` *before* any chunk (`decoder/streams.ts:312-315`).
   **Change:** the ack comes from the worklet shell when it commits the epoch's first chunk, or from ring state in STATUS. A committed ring can't empty before its stamp (the voice is unbound, the worker idles: `stream.rs:20-33`; `voices.rs:677-681`), except through RESET, so stamping A's STOP with B's PLAYs becomes safe.
2. **blocking: stems lose their group outside the start path.**
   - Hard rebuild: `reopenStreams` relaunches each stream asap from its own playhead (`core/coreBackend.ts:1406-1422`, `launchStream` at `:1388-1394`): each stem slips by its own amount.
   - Seek: each stream gets its own epoch (`core/streams.ts:15-18`), with the same result.
   - S1 Q1c: per-stem slips skew the piece permanently, unreported.

   **Change:** the record states that a segment's stems are one group in every path (start, seek, rebuild, worker respawn), and that the music player owns their recovery: re-prime the group, stamp one frame, enter at `sameTime`. Also add a **core group gate** as a defence: the voices of a group leave `WAITING` together once every ring holds `START_FRAMES` (S1 recommendation 3). A late stem then delays the whole group, reported, instead of skewing it.
3. **major: the worker fills depth-first.** On open, `pump()` loops while credit allows (`decoder/streams.ts:315, 506`), so stem N's first chunk waits behind N−1 full rings. S1's lead model assumes a seek plus *one* chunk per stem (MP3 0.19 ms), but each open really costs a full ring (MP3 1.12 ms, Vorbis 1.62 ms native p50, `results-decode.md`).
   - 8 Vorbis stems at wasm 2× and phone 8×: ≈ 8 × 1.62 × 16 ≈ 210 ms (est.), against a 100 ms default.

   **Change:** for a prime group the worker opens every stem and sends one chunk each before it tops any up. Seed the lead per preset (low: 250 ms) until the session has measured it. Make "measured prime time" a running p95, not a mean.
4. **major: slip reporting contradicts itself.** §2 says the core reports a slipped stream "with exact frames". §3 adds only a counter and the largest slip, which the beat clock can't use to correct one instance.
   **Change:** add a per-voice stream event "started at frame F" next to *starved*, *eos* and *error* (`voices.rs:1217-1222`), and keep the counters.
5. **major: loop wraps aren't decided by the core.** §2 says the core reports "a loop wrap whose count main couldn't know". In fact the worker wraps, and "loops never leave PLAYING" in the core (`stream.rs:72-73`; `decoder/streams.ts:18-21`). Main predicts wraps from the STATUS playhead (`core/streams.ts:19-30`).
   **Change:** loops with a `count` are predicted on main. A `while` loop is released through the existing `streamLoop` splice when its condition is read.
6. **major: no policy for an exhausted pool, and rings come back slowly.** Release goes STATUS (16 ms) → main's frame → worker `streamClose` → STREAM_CLOSE (`core/streams.ts:38-39`).
   - Switching A→B→A′ inside one fade needs three sets of stems: 12 rings for 4 stems, but low has 8.
   - A STREAM_OPEN with no free ring leaves its voice waiting in silence until main stops it (`stream.rs:39-40`).

   **Change:**
   - main mirrors pool occupancy and never primes without free rings;
   - one pending transition per container: a newer target replaces an unstarted one (STOP of a SCHEDULED voice is immediate, `voices.rs:1390-1396`); if still short, the oldest outgoing fade is shortened;
   - the pool is a core ring class, like narrow and wide (`stream.rs:61-65`), named on STREAM_OPEN.
7. **major: hidden tabs stop the planner.** The planner runs in the frame loop, and rAF stops while the page is hidden. Under `audio.background` `mute` or `play` the audio keeps going (`core/background.ts:4-10`), so a playlist reaching its exit cue gets no next segment.
   **Change:** keep one decision stamped ahead (the next playlist item stamped when the current one starts, cancellable while SCHEDULED), and run the planner from the STATUS handler while hidden.
8. **major: missed-beat burst.** "Missed beats fire together" means dozens of callbacks after a hidden tab or `pause` resume. ClockMap re-anchors after 250 ms (`core/clock.ts:34-35`).
   **Change:** after a re-anchor, fire nothing older than one bar, and deliver one event that carries `skipped: n`.
9. **minor:** a context swap restarts frame counts (`ClockMap` `rebase`, `core/clock.ts:89-104`). Store each instance's grid origin as a musical position plus a heard time, never as a raw frame, and recompute frames when the rate changes.
10. **minor:** define the ack deadline. The batch leaves on the frame after the ack arrives, so it is T − L − Δ̄, not T − L.

## Failure modes

| Trigger | Under the record | Should |
|---|---|---|
| Decoder worker crash | Each stem fails with a 50 ms fade and one warning; B6 respawns the worker for clip decodes only (`core/streams.ts:40-45`). Music stops | Player sees one group failure, respawns the worker, re-primes at `sameTime` on the next bar, fades in; rate-limited like rebuilds (`core/recovery.ts`) |
| Hard rebuild (trap, worklet stall) | Stems reopen one by one, asap (issue 2): permanent skew | Re-prime the group, stamp one common frame, re-base the beat clock |
| Device or rate change (new context) | As above, plus stale frame origins | As above. Tempo-map frames recomputed at the new rate; rhythm mode asks for calibration again on `devicechange` |
| Hidden tab, `mute`/`play` | No planner: playlist and `while` loops stall at the exit cue | One decision stamped ahead; planner driven by STATUS |
| Hidden tab, `pause` | Missed-beat burst on resume | Re-anchor; drop the backlog; one resync event |
| Music seek | Per-stem SEEK epochs: skew | Seek is a transition: prime the group at the target, stamp it, stop the old group |
| Main hitch during a pending transition | Undefined | Stamped stems play on time; an ack seen after its deadline re-plans, never stamps into a slip |
| Late ack mid-transition | Re-plan "to the next allowed grid point", which may be an exit cue 30 s away | A keeps looping; A's STOP goes only in B's PLAY batch, so no hole |
| Worker slow (phone, cold fetch) | 100 ms lead missed on every transition; repeated re-plans | Breadth-first priming, seed lead, p95 estimate, prefetch encoded bytes of a switch's targets |
| Pool exhausted | Voice waits silent, nothing reported | Admission on main; replace the pending transition; shorten the oldest fade; counter |

## Performance

- **The audio thread isn't the risk.** +43/+75/+99 µs p50 (S4) fits the allowances, and in-voice ramps remove the one real hazard (+538 µs per split quantum). Make "quantum splits from gain records = 0" a test assertion, not a benchmark.
- **The prime burst on the decoder worker is the risk.** The critical path, after issue 3, is N × (open + seek + first chunk). Vorbis opens cost 1.7 ms native (S2), roughly 27 ms each on a phone (est.). A crossfade doubles the stream count: on low, 8 music + 4 effects streams ≈ 30–43% of a phone core (S2, est.).
- **Memory and GC on main.** Each open transfers the whole encoded file (`core/streams.ts:9-10`), and the worker keeps a copy per stream (`audio-decode/src/lib.rs:270`). Two primed sets double that (≈ 70 MiB for 8+8 MP3 stems). A playlist that re-primes the same segment on every loop must reuse the cached bytes (`encodedCache.ts`), not fetch them again.
- **Method, in three tiers:**
  1. Instruction counts from the repo's meter in CI: machine-independent, the regression gate for ramps and the music scenes.
  2. The lab VM (the owner's run) for p99.9 and budget acceptance.
  3. The phone: request→ack p50/p99 for 8 cached Vorbis and MP3 stems; a 10-minute run of worker CPU at 12 streams for thermals; the audio thread on low; beat-callback frame error with real output latency.

  Container numbers stay p50/p99 only. §7 assumes the reference is 2× this container, but S4 measured ≈ 1.45× (`cost/README.md:104`); the allowances still fit, so state one factor.
- **Targets:** prime p99 ≤ 0.8 × lead; re-plans under 1% of transitions on default; `streamStartsLate = 0` and group spread 0 over a sample soak.
- **Observability** (debug panel): prime-time histogram, re-plans by reason, pool high-water mark and refusals, group start spread from STATUS playheads, skipped beats, music recoveries. Test the failure table with a fault-injecting `fakeDecoder.ts` (delay, reorder, crash).
- **Reversibility:** format and pool sizes are cheap to change; in-voice ramps are hard to reverse but right; the group gate is additive.

## Cheaper alternatives

- Use ring readiness in STATUS as the ack: no new message type, for about 16 ms of extra lead.
- The core group gate alone stops skew in every path; the per-path recovery code can follow in M4b.
- Defer `while` regions to M4b. Count loops need nothing new.
- On low, recommend decoded stems for loops ≤ 30 s.

## Questions for the author

1. Who owns stream recovery for music: the music player or the `Replayer` (`core/replay.ts:496-501`)?
2. Is the music pool a ring class in the core, or main-side accounting over one larger store?
3. What happens on a re-plan when the next allowed point is far away: is there a maximum wait that falls back to a bar?
4. What is music's behaviour in a hidden tab under each `audio.background` mode?
5. In rhythm mode, how does recovery after a rebuild avoid an asap restart?

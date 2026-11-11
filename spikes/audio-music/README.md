# Audio M4 (interactive music) spikes

This is step 2 of the M4 design pipeline: the survey, and the measurements that the decision record (0163) and the technical design will cite. The owner confirmed the goal and constraints on 2026-11-11, in [docs/design/0163-audio-music/goal.md](../../docs/design/0163-audio-music/goal.md). The shared rules for the spike agents are in [BRIEFS.md](BRIEFS.md).

Each sub-spike has its own README with its method, raw tables and an unverified list. This file collects the answers.

## How the numbers were taken

**Who ran what.**
- The agents built each spike and checked it for correctness while sharing the machine.
- The coordinator ran every timed run one after another on an idle machine (load ≈ 1.0, the benchmark's own thread), 2026-11-11 18:03–18:42 UTC. `timed-runs.log` records the load before and after each stage, and `timed-runs.sh` reproduces them.

**The machine:** this session's container, a shared 4-vCPU VM. A quantum is 128 frames, which is **2,667 µs at 48 kHz**.

**What these numbers are not.**
- This container is not the lab VM the 0157 budgets were set on.
- It is not the reference machine either; that one is assumed 2× faster, a provisional assumption.
- It is not the low-end phone. Phone numbers stay **unverified**, as the owner decided.
- Only **p50 and p99 can be trusted here**. p99.9 and max follow the VM's scheduling, not the code, and the lab-VM run is the owner's.

**What was skipped, and why.** Following the owner's rule of no runs that can't change a decision:
- S2's 52-minute concurrency and Chromium timing runs. The trial runs already show at least 570× real-time decode headroom and no starvation up to 64 streams, and the binding limits (memory, ring count) are deterministic.
- S4's scenes ran 5 × 10 s instead of 5 × 20 s, because the exact instruction counts already settle the budget.

**Network.** The proxy blocks the documentation hosts. The survey (S0) is verified against primary sources on GitHub where possible (Godot, Kira, MDN browser-compat-data, the Web Audio spec, vendored FMOD and Wwise headers). The rest is marked [U].

## Answers

| Question | Answer | Source |
|---|---|---|
| How do others model interactive music? | **Wwise** uses segments with **one tempo and metre each** (the header has one beat and bar length per segment, with positions in whole ms), playlist and switch containers, a transition matrix, and stingers. **FMOD** uses a timeline whose beat callback carries tempo and time signature, so they can change along the timeline. **Godot 4.3** (MIT) has a transition table with `CLIP_ANY` wildcards, fades in beats, a filler (bridge) clip and hold-previous, but no cues or tempo maps. **Kira** (MIT/Apache) starts sounds on clock ticks, but checks once per audio block: not sample-accurate. **Unreal Quartz and Harmonix:** [U]. | [research](research/README.md) |
| What M4 should adopt | Wwise's structure (segments, playlist and switch, transition matrix, stingers). FMOD's tempo markers inside a segment: **this is where M4 differs from Wwise**. Godot's table shape (wildcards, beat-length fades, bridge, hold). Kira's idea of a clock tick, made sample-exact by our core's stamped records. **Port no code** (Godot's C++ isn't portable; the others are proprietary). | research |
| Can streamed stems start sample-exact today? | **Only if each stem's buffer (ring) holds at least 4,096 frames at the start of the stamp's quantum.** This was asserted over 1,408 cases. Otherwise a stem starts at offset 0 of the first quantum after its data lands, with no upper bound (one case slipped 50,011 frames). It then stays out of step for the whole piece, and **neither `lateCommands` nor `starved` counts it**. On low, 8 stems get only 4 rings, so 4 never start. | [streams-align](streams-align/README.md) (coordinator re-ran the correctness pass: all assertions hold) |
| Does the core need a PRIME command? | **No.** A stream voice binds to its ring only at its stamp, so a ring opened early fills to 32,768 frames and waits. M4 opens all of a segment's stems, waits for a per-stream "primed" acknowledgement, then stamps the PLAYs on the next grid point. If the acks are late, it re-plans. Priming 8 cached stems takes **≈ 20–60 ms (est.)**, with native decode measured and the wasm factor estimated at 1.5–3×. A 100 ms lead is comfortable. | streams-align |
| Seams and loops | Segment A ending at T and segment B starting at T is **sample-exact when B is primed**, both for a cut and for a 4,800-frame crossfade. If B is late, everything after is shifted. Streamed loop regions are already exact. **Jumping from a loop end into a different file doesn't exist** (`changeLoop` seeks the same decoder handle). The core's splice accepts it, and it tested exact if B's data lands at least 325 frames before the seam. | streams-align |
| Decoded clips | Exact: 8 voices × 128 stamp offsets all start at the stamp and null against the reference. | streams-align |
| Decode cost per format | Every format we decode costs about the same per 4,096-frame chunk (p50 / p99): MP3 124–137 / 188–241 µs, Vorbis 131–138 / 230–253 µs, FLAC 129 / 256 µs, AAC 126 / 224 µs, WAV 31 / 61 µs. That is **569–687× real time** (WAV 2,667×), about 0.16% of a core per stream. **Opening a stream:** Vorbis ≈ 1.7 ms, MP3 0.23–0.35 ms. | [stream-throughput](stream-throughput/README.md) |
| How many streams can the worker feed? | No ring starved up to 64 streams (the decoder limit, `audio-decode/src/lib.rs:62`). The worker used ≈ 30% of one core at 64 and ≈ 7% at 16 (trial run). **CPU is not the limit, memory and ring count are.** | stream-throughput |
| Memory | **A ring is 300 KiB** (1.2 / 2.3 / 4.7 MB on low / default / high). **A decoded 3-minute stereo 48 kHz stem is 33 MiB as int16, a 40 MiB arena block:** one fits in low's 64 MB, three in default, six to seven in high. The decoder keeps **each stream's whole encoded file** in its wasm memory (`lib.rs:270`), per stem. Eight 3-minute stems are ≈ 35 MiB as MP3 192 kbps, ≈ 190 MiB as FLAC and ≈ 264 MiB as WAV. **Lossless streamed stems are out on low.** Vorbis also holds ≈ 1.7 MB of decoder state per stream. | stream-throughput |
| Stream count per preset | Today it is max_mixed/16 clamped to 4..16 (`stream.rs:118-120`): 4 / 8 / 16. **Low's 4 can't hold a 4-stem crossfade (8).** The spike proposes a separate music allowance: low +8, default +12, high +16. | stream-throughput, streams-align |
| How should beat callbacks work? | **Design A:** main predicts beats from the tempo map plus the engine's `ClockMap`, and fires each in the frame whose window covers the heard beat. Against Chromium's heard clock, with a sliding-window truth fit (1 × 60 s, idle): **66 of 69 steady beats land in the ideal frame and 3 one frame early (by 1.7 ms)**. All 5 tempo-change beats and all 35 transition beats land in the ideal frame. **None missed, doubled or phantom** in 6 timed runs (116 beats each) across a 120 → 90 BPM change, a stamped bar transition and 8 seeks. ClockMap tracks the audio clock to **0.04 ms p50** (p99 4.2 ms, bounded by the reference's own 6.8 ms). **The core reports only the grid changes it decides itself** (seek, loop wrap, playlist step) with exact frames. **It never fires on arrival**, because events arrive ≈ 31–35 ms before the beat is heard. | [beat-clock](beat-clock/README.md) (the 5 × 60 s single-line figures were an artefact of the reference, shown by the confirming run) |
| Where callbacks run in the frame | `engine.Audio` runs in `lateUpdate` (`src/plugins/audio/runtime/audioSystem.ts:125-129`), so `update()` scripts read last frame's `Audio.time`. **Beat dispatch should run before `update`**, and each callback should carry the exact heard `time` and `heardIn`. | beat-clock (from reading the code) |
| Music's audio-thread cost (high, p50 delta vs the same scene without music; native / wasm) | **Typical** (4 stems, 1 fading): +43 / +39 µs. **Transition** (12 stems, 2 stingers): +75 / +68 µs. **Worst** (16 stems, 4 stingers, all fading): +99 / +96 µs. Per voice: decoded 2.3 µs, streamed 2.9 µs (+25% by instruction count), and 44.1 kHz costs the same as 48 kHz (every voice runs the resampler). A stem costs ≈ 40% of an average high voice. | [cost](cost/README.md) (exact instruction counts plus the timed run) |
| Sample-exact fades | **A stamped SET_PARAMS, FADE or STOP splits the quantum for every live voice** (`native/audio/crates/audio-core/src/voices.rs:310`). Splitting every quantum costs **+538 µs native / +810 µs wasm**. M4 must carry a ramp's start sample inside the voice instead. The fade law also matters: **`libm::sqrtf` and `sinf` per sample are 4.5× slower in wasm than native**. Use the S-curve polynomial (446 ns per voice per quantum in wasm) or a 1,024-point equal-power table (683 ns). | cost |
| A music clock in the core | 0 frames of error across 120, 130 and 120 → 90 BPM with a metre change. Cost: 4.7 ns per quantum for 1 instance and 35 ns for 8 (wasm 7.7 / 58 ns), the same for any tempo-map length. **Negligible.** | cost, beat-clock (design B's crossing check: 71 ns for 64 instances) |
| Rhythm mode: what latency? | The engine adds ≈ 4 ms to an asap hit sound (tail ≈ 15 ms: the postMessage apply plus the 1.5 ms limiter, `audio-dsp/src/limiter.rs:87`). The lookahead floor (1,024 frames) applies to stamped records only. **The platform adds 20–50 ms** (≈ 50 ms on M1's Windows machine). Leave the lookahead floor, the limiter and the STATUS cadence alone. Rhythm mode asks for the smallest `latencyHint` (in Chromium: `0` gives baseLatency 2.9 ms and outputLatency 8 ms, `interactive` gives 10 / 32 ms, both on a fake sink) and reads it back. **Promise no absolute latency.** | [rhythm](rhythm/README.md) |
| Rhythm mode: input and calibration | Judge input by mapping `event.timeStamp` through ClockMap's offset: **0.04 ms p50 against 9.4 ms** when reading `Audio.time` in the handler (beat-clock confirming run). `outputLatency`, `baseLatency` and `getOutputTimestamp` exist in Chromium, Firefox and Safari 18.4+ (MDN browser-compat-data, [V]). The engine reads only `getOutputTimestamp` today (`src/plugins/audio/runtime/core/hostClock.ts:62`). **Calibration:** use the median of the taps. With 16 taps after 4 warm-up taps, p95 error is ≈ 10 ms in simulation (the tap noise is assumed). Persist the result per output device. | rhythm, beat-clock |
| Rhythm mode at `latencyHint: 0` | Render-ahead drops from ≈ 35 ms to ≈ 9 ms. Design A is unaffected. Grid changes learned only from STATUS may arrive after the beat is heard, so rhythm mode should **require stamped transitions** and suppress old-grid callbacks until an asap change is confirmed. Glitch risk is [U]. | beat-clock |

## What this means for the design

1. **Music is cheap on the audio thread and expensive in memory.** The budget question is about rings and decoder memory, not CPU. Stems stream as Vorbis or MP3. Stingers and short loops (≲ 30 s) are decoded clips.
2. **Streams need a contract and a pool.**
   - Streamed starts are exact only when primed. M4 needs a prime-then-stamp protocol between main and the worker, with a re-plan to the next grid point.
   - It needs a STATUS counter for slipped starts (the one core change S1 proposes).
   - It needs a separate music ring pool sized for two sets of stems.
   - It needs a cross-file splice at a loop end.
   - The decoder should share one encoded copy per file across stems of one piece, or the design should accept ≈ 4.4 MiB per MP3 stem.
3. **Fades move into the voice.** A ramp carries its start sample, with no quantum splits. The fade law must be cheap in wasm (polynomial or table).
4. **The clock stays on main.** Main predicts beats from the tempo map plus ClockMap. The core reports only the grid changes it decides. Callbacks run before `update` and carry exact times. The music clock in the core is free if the design wants it there for stamped transitions.
5. **Rhythm mode is a small layer:**
   - a lower `latencyHint`;
   - `Audio.timeAt(performanceTime)` and a music-position query at an input timestamp;
   - a calibration API;
   - stamped transitions only.

   Nothing in the core changes.

## Performance targets (proposed, for the record)

**Audio thread, per quantum.** The figures are this container's p50 deltas and the S4 model, scaled to the reference machine by the assumed factor of 2, with at least 50% headroom.

| Preset | Typical allowance | Worst allowance | Measured here (p50 delta, native) | Note |
|---|---|---|---|---|
| high | **0.05 ms** | **0.08 ms** | +43 µs typical, +99 µs worst | measured |
| default | 0.05 ms | 0.06 ms | | cost model (est.) |
| low | 0.04 ms | 0.04 ms | | cost model (est.) |
| sample-exact fade via a quantum split | outside the allowance | | +538 µs per split quantum | **design it out** (ramps in the voice) |

**What this does to high's total.**
- Typical: 1.29 + 0.05 ≈ 1.34 ms, 0.04 over 0157's 1.3 ms at p99.9, before the lab VM is measured.
- Worst: ≈ 1.69 ms.
- If **music voices count inside the 256-voice cap**, the net is about −1% (est.), because a stem costs less than an average voice.

The owner gave M4 its own budget. Whether music counts inside the cap is an owner decision.

**Main thread, per frame.** Beat prediction and grid maths cost nanoseconds per instance (cost, beat-clock), so no budget line is needed.

**Decoder worker.** Each stream is ≈ 0.16% of a core here. 32 streams is ≈ 15% (trial run). On the phone at an assumed 8× slowdown, 12 streams is ≈ 30–43% of one core **(est.)**.

**Memory.**

| Item | Size |
|---|---|
| Music ring | 300 KiB each |
| Encoded file held per stream | ≈ 4.4 MiB (3-min MP3 192 kbps) |
| Vorbis decoder state | ≈ 1.7 MB per stream |
| Decoded 3-min stereo stem (int16) | 33 MiB |

## Still unverified

- **Everything on the phone** (owner: unverified for now), and the wasm decode factor in the real worker.
- **Real-device latency:** `outputLatency` and `getOutputTimestamp` noise on real hardware, and whether design A's frame is the frame the sound is heard in. This needs a loopback on a real device. The rhythm spike lists 9 measurements for the owner's desktop and phone run.
- **Cold fetch** of 8 stems for priming. The worker→main ack ordering versus chunks.
- **Splicing across files** at a different sample rate (from reading the code only).
- **Lab-VM tails** (p99.9, max) for the music scenes.
- **The Wwise and FMOD manuals and Unreal Quartz/Harmonix** (documentation hosts blocked).
- **Glitch risk at `latencyHint: 0`.** Human tap spread for calibration.
- **Why `libm::sqrtf` is slow in wasm.** Whether `core::arch::wasm32::f32_sqrt` fixes it: if so, M3's `audio-dsp/src/ambisonic.rs:116` would benefit too.

# 0166. Interactive music (M4): music is built from segments with tempo maps, arranged by playlist and switch containers under a transition matrix, started sample-exact by priming streams first, with a beat clock on the main thread

- **Status:** Proposed (revision 2, 2026-11-11: the RFC round in `docs/rfc/0166/`, see "RFC round (revision 2)" at the end; where the end section and the text above disagree, the end section wins)
- **Date:** 2026-11-11
- **Deciders:** Chris Carlson
- **Supersedes:** —
- **Amends (when accepted):**
  - 0157: the stream count gains a music pool; stamped gain records stop splitting the quantum;
  - 0158: `myco.audioevent@1` gains music nodes;
  - 0097: the presets gain the music settings.
- **Related:**
  - 0157: roadmap M4; stamped records and the heard clock;
  - 0158: events, containers, parameters, curves;
  - 0162: the latest audio record, which this one follows in shape;
  - 0097: buses;
  - 0040: sidecars;
  - 0133: plugins;
  - 0093: component messages.

## Glossary

Plain-language meanings of the terms this record uses.

**Musical time**
- **Tempo:** speed in beats per minute (BPM).
- **Metre (time signature):** beats per bar and the beat's note value, for example 4/4 or 6/8.
- **Tempo map:** a list of tempo and metre changes along a piece, so the engine can turn "bar 17, beat 3" into a time in seconds and back.
- **Grid:** the positions of beats and bars that the tempo map gives. **Quantised** means "waits for the next grid position".
- **Downbeat:** the first beat of a bar.

**Building blocks**
- **Segment:** a piece of music, typically 2–60 s long, with a tempo map, **cues** and **stems**.
  - Cues are named positions. The **entry cue** is where the segment's music really starts (anything before it is a pickup that plays early). The **exit cue** is where the next segment may take over (anything after it is a tail that rings on).
  - Stems are parallel layers of the same piece: drums, bass, pads, melody. Each is one audio file, all of the same length, mixed together and faded in and out by game parameters.
- **Loop region:** a span of a segment, between two cues, that repeats a number of times or while a condition holds.
- **Playlist:** a container that plays segments in sequence, at random or shuffled, with a loop count per item.
- **Music switch:** a container that picks one child by a game parameter or state ("explore", "combat"). Changing the parameter makes it change music *by the transition rules*.
- **Transition matrix (rules):** a table of rules, one per from → to pair, where `*` matches anything. A rule says:
  - **when to leave:** immediately, at the next beat, bar or N-bar grid line, at the next cue, or at the exit cue;
  - **where to enter:** the entry cue, the same musical position, or a named cue;
  - **how to fade:** out and in, with lengths in beats or seconds;
  - **an optional transition segment:** a bridge played in between.
- **Stinger:** a short phrase played *over* the music when the game triggers it, landing on the next beat, bar or cue (a "hit" when the player finds a secret).

**How the engine plays it**
- **Priming:** opening a streamed file and filling its buffer *before* it must start, so its start can be sample-exact.
- **Stream ring:** the per-stream buffer in the audio thread, 32,768 frames ≈ 0.68 s.
- **Audio frame vs display frame:** an *audio frame* is one sample per channel (1/48,000 s); a *display frame* is one game loop tick (≈ 16.7 ms at 60 Hz). This record says which wherever it matters.
- **Quantum:** the audio thread's block of 128 audio frames (≈ 2.7 ms at 48 kHz). "Splitting the quantum" means rendering it in pieces so a command can apply mid-block.
- **Decoded clip vs stream:** a decoded clip is held whole in memory and always starts exactly; a stream is decoded as it plays and starts exactly only if primed.
- **Stamped record:** a command to the audio thread that carries the exact audio frame it applies at. **asap** records apply on arrival.
- **Heard clock:** `Audio.time` (seconds), the audio clock mapped to the browser clock through the device's output timestamp and less the limiter's look-ahead, so it says when a sound is *heard*, not when it is computed. It is sampled once per display frame, so a read in `update()` today is one frame old (the audio system runs in `lateUpdate`).
- **Beat callback:** script code the engine runs when a beat, bar or cue of the music is about to be heard.

**Rhythm mode**
- **Rhythm mode:** a project setting for rhythm games. It asks for lower output latency, judges input against the heard clock, and offers calibration.
- **Calibration:** the player taps along to a beat, and the median offset corrects the remaining constant error of their device.

## Context

**The goal (owner, 2026-11-11, [goal.md](../design/0166-audio-music/goal.md)).**
- **What:** interactive music as part of 0157's "AAA-quality mixing and control built into the engine", open source only.
- **Scope:**
  - the tempo and bar grid, with tempo and metre changes;
  - quantised transitions;
  - transition segments;
  - stingers;
  - stems;
  - playlists;
  - beat callbacks to scripts.
- **Authoring:** "both, as one model". Wwise's structure, with FMOD's tempo markers and regions inside a segment. The editor has a segment view and a rules table; free clip arrangement is deferred.
- **Sync:** music-tight by default, plus a rhythm-mode project setting.
- **Budget:** M4 gets its own audio-thread budget.
- **Fallback:** best effort on Babylon.
- **Users:** only the samples use the engine today, so there is no compatibility work.

**What exists (read from code).**
- **No musical timing anywhere.** Events (0158) have `delay` in seconds (`src/engine/audio/eventFormat.ts:103`).
- **Sample-exact stamped starts exist.** `at` on `playOneShot` and `play`. The earliest exact time, `horizon()`, is now + lookahead, where the lookahead is clamp(2 × frame interval, 1,024 frames, 100 ms). It is not public (`src/plugins/audio/runtime/core/lookahead.ts:11-31`).
- **Streams:**
  - they are opt-in per clip;
  - there are 4 / 8 / 16 per preset (`native/audio/crates/audio-core/src/stream.rs:118-120`);
  - a stream voice waits for 4,096 buffered frames before it starts.
- **Stems are done ad hoc.** sound-lab's `music-intensity` event layers three looping WAV stems faded by a parameter.
- **Bus fades, snapshots and ducking advance on main at frame rate** (`src/engine/audio/mixer.ts:155-210`).
- **The audio system runs in `lateUpdate`** (`src/plugins/audio/runtime/audioSystem.ts:125-129`).

**How others do it** ([spikes/audio-music/research](../../spikes/audio-music/research/README.md); proprietary systems are studied, not ported).
- **Wwise Interactive Music:**
  - segments with one tempo and metre each (its sync callback has one beat and bar length per segment, positions in whole ms);
  - playlist and switch containers;
  - a transition matrix, transition segments and stingers.
- **FMOD Studio:** a timeline per event, with tempo markers (the beat callback carries tempo and time signature), loop and transition regions, and quantised transition markers.
- **Godot 4.3 (MIT):** a transition table with `CLIP_ANY` wildcards, fades in beats, a filler (bridge) clip and hold-previous. No cues, no tempo maps.
- **Kira (MIT/Apache):** sounds start on clock ticks, checked once per audio block, so not sample-exact.
- **Unreal Quartz and Harmonix:** a quantised clock with beat delegates (docs unverified here).

**Measured ([spikes/audio-music/README.md](../../spikes/audio-music/README.md); container p50/p99, idle machine).**
- **Streamed starts are exact only if primed.** A stream voice starts on its stamp only if its ring holds at least 4,096 frames when the stamp's quantum begins (asserted over 1,408 cases). Otherwise it slips to the quantum after its data lands, stays out of step for the whole piece, and no counter records it.
  - A ring opened early fills and waits, so priming needs **no new core command**.
  - Priming 8 cached stems takes ≈ 20–60 ms (est.).
  - Primed seams and crossfades between segments are exact; streamed loop regions are exact.
- **Decode is cheap; memory and ring count are the limits.**
  - Every format decodes 569–687× faster than real time (WAV 2,667×), and no ring starved up to 64 streams.
  - A ring is 300 KiB.
  - A decoded 3-minute stereo stem is 33 MiB (int16), so one fits in low's 64 MB.
  - The decoder holds each stream's whole encoded file (`native/audio/crates/audio-decode/src/lib.rs:270`): 8 MP3 stems ≈ 35 MiB, 8 FLAC stems ≈ 190 MiB.
- **Music on the audio thread (high, p50 delta, native):**

  | Scene | Delta |
  |---|---|
  | typical: 4 stems, 1 fading | +43 µs |
  | transition: 12 stems, 2 stingers | +75 µs |
  | worst: 16 stems, 4 stingers | +99 µs |

  A stem costs ≈ 40% of an average high voice.
- **Sample-exact fades by stamped record are a trap.** Every stamped record (gain, PLAY or STOP) **splits the quantum for every live voice** (`native/audio/crates/audio-core/src/voices.rs:310`), +538 µs per split quantum. In wasm, `libm` `sqrtf` and `sinf` per sample run 4.5× slower than natively.
- **Beat prediction on main is accurate.** Predicting beats on main from a tempo map plus `ClockMap` put 66 of 69 steady beats in the ideal frame (3 one frame early by 1.7 ms) and every tempo-change and transition beat in the ideal frame, with 0 missed, doubled or phantom over 6 timed runs. ClockMap tracks the audio clock to 0.04 ms p50.
- **Events from the audio thread arrive early.** They arrive ≈ 31–35 ms before the beat is heard, so they must never fire on arrival.
- **Rhythm mode is a thin layer.** The engine adds ≈ 4 ms to an asap hit sound; the platform adds 20–50 ms. Mapping `event.timeStamp` through ClockMap judges input to 0.04 ms p50, against 9.4 ms for reading `Audio.time` in a handler. `outputLatency` and `getOutputTimestamp` exist in Chromium, Firefox and Safari 18.4+. With 16 taps, median calibration has p95 ≈ 10 ms (simulated).

## Decision (proposed)

### 1. One model: segments under containers, inside the event format

Music is part of the event format (`myco.audioevent@1`, 0158), not a new asset kind. One `Audio.play`, one handle, and parameters, limits and buses all work for music unchanged. Like 0162, the format gains optional nodes and fields with no version bump, and the samples are updated.

- **`segment` node:**
  - **`tracks`** (stems): each has a `clip`, gain, bus, and M2 automation of volume, pitch and low-pass by parameters.
  - **`tempo`:** a tempo map of markers at seconds positions, each with `bpm`, `beatsPerBar` and `beatUnit`, so tempo and metre may change inside the segment (FMOD; this is where M4 differs from Wwise).
  - **`cues`:** named positions in seconds, with an `entry` and an `exit` cue by default at 0 and the end.
  - **`regions`:** loops between two cues, with `count` (0 = forever) or `while` (a parameter condition, FMOD's conditional loop).
  - **`length`.**
  - Position units are owner decision 1 (revision 2): musical positions (bar:beat:tick against the tempo map) or audio frames.
  - A segment's stems must share one length and one channel layout. Validation enforces it.
- **`playlist` node:** children (segments or containers) with `mode` `sequence` / `random` / `shuffle`, `avoidRepeat`, and a `loop` count per item and for the whole list. Music containers step at **exit cues**, not at clip ends.
- **`musicSwitch` node** (revision 2: a distinct node, not an overloaded `switch`): children keyed by a labelled parameter's values; a parameter change goes through the transition rules. M2's `switch` is unchanged.
- **`transitions`:** an ordered rule table on any music container. Each rule has:
  - `from`, `to`: a child id, or `*`;
  - `exit`: `immediate` | `beat` | `bar` | `grid(n)` | `cue(name?)` | `exitCue`;
  - `enter`: `entryCue` | `sameTime` | `cue(name)`;
  - `fadeOut` and `fadeIn`: length in beats or seconds, offset, curve `linear` / `sCurve` / `equalPower`;
  - `bridge`: an optional segment with its own fades.

  The most specific rule wins: exact pair, then `from` exact, then `to` exact, then `*`→`*` (Wwise's precedence, Godot's wildcards). A default `*`→`*` rule (`exit: bar`, `enter: entryCue`, a 1-beat crossfade) is always present.
- **`stingers`:** on a music container, a list of `{ trigger, segment, at: beat | bar | cue(name) | immediate, dontRepeat: seconds }`. A stinger plays on its own bus or voice group over the music and does not change the grid.
- **Import hints:** a WAV's `acid` chunk (tempo, beats, metre), `cue`/`LIST adtl` labels and `smpl` loops, and Ogg `BPM`/`LOOPSTART` comments, are read when a clip is added to a segment. They are only suggestions: the event file is authoritative.

### 2. The split: main decides, the audio thread executes exactly

This follows 0158's rule: main does event-driven work, and the core does everything continuous per quantum.

- **Main** owns one music player per playing instance. It handles:
  - the grid maths (tempo map ⇄ seconds ⇄ frames);
  - playlist steps and rule lookup;
  - stinger scheduling;
  - **planning every start at a grid position at least the prime lead away.** The lead is max(horizon, 1.25 × the measured prime time), ≈ 100 ms by default. If the next allowed grid point is closer, it takes the following one.
- **The core** gets only stamped PLAY and STOP records and **in-voice ramps** (§4). It reports what main can't know: a group that started late, per voice with its exact start frame (revision 2). Loop wraps are the worker's and main predicts them.
- **No music state is added to the core** beyond the ramps and the counters. S4 measured a core-side music clock at 5–35 ns per quantum; it stays available if the technical design needs it for stamped transitions.

### 3. Streams: prime, then stamp; a music ring pool; a slip counter

- **Prime-then-stamp:**
  - Main asks the decoder worker to open and fill every stem of the next segment.
  - The worker acknowledges each stem when its ring holds at least 4,096 frames.
  - Main then stamps the PLAYs at the planned grid point. If an acknowledgement misses its deadline, main re-plans to the next allowed grid point.
- **The start contract:** a streamed start is exact if and only if its ring holds at least 4,096 frames at the stamp's quantum. Decoded clips are always exact.
- **Seams:**
  - Segment changes, loop exits into another file and bridges are **a primed B stamped at T plus a stamped STOP of A**, or a crossfade by two in-voice ramps. This is tested exact in S1 and needs no core splice.
  - Next-segment stems stay primed (rings full, waiting) while a transition is pending, so a beat-quantised change can start within one beat.
- **Music ring pool:** a separate `music.streams` count per preset, on top of today's `mixed/16`. It holds two full sets of stems plus a bridge:

  | Preset | Music rings | Memory |
  |---|---|---|
  | low | 8 | 2.3 MB |
  | default | 12 | 3.5 MB |
  | high | 16 | 4.7 MB |

  A stem's ring is released once its fade reaches silence.
- **A slip counter:** STATUS gains `streamStartsLate` and the largest slip in frames. Today a slipped start is invisible.
- **Formats:**
  - streamed stems are **Vorbis or MP3** (cheap, and their encoded copy is small);
  - stingers and loops ≲ 30 s are **decoded clips**;
  - streamed FLAC and WAV stems warn on the low preset (8 FLAC stems hold ≈ 190 MiB of encoded data in the worker).

### 4. Fades move into the voice

- **No more splits.** Stamped gain records (FADE, SET_PARAMS gain, STOP with a fade) no longer split the quantum. The voice carries the ramp's start frame and applies it from that sample inside its own loop, so other voices aren't touched (S4: +538 µs per split quantum otherwise).
- **This applies to every stamped gain change, not only music.** It is an amendment to 0157.
- **Fade curves** are evaluated with operations that are cheap in wasm: linear, a polynomial S-curve, and a 1,024-point equal-power table. Never `libm` `sinf` or `sqrtf` per sample.

### 5. The beat clock and callbacks

- **The clock (design A, measured).** Main predicts beats, bars and cues from each instance's tempo map, its stamped start frame and `ClockMap`. It fires each one in the frame whose heard-time window covers it. Grid changes the core decides arrive in STATUS and correct the prediction. **Nothing fires on arrival from the audio thread.**
- **Dispatch before `update`:** a new early audio step, before scripts' `update`, delivers the frame's beat callbacks. Today `engine.Audio` runs in `lateUpdate`, so `update()` reads last frame's `Audio.time`.
- **The API (proposed shape, settled in the technical design):**
  - `handle.music`: `{ segment, bar, beat, tempo, beatsPerBar, time }`, read any time.
  - **Component messages** `onMusicBeat(e)`, `onMusicBar(e)` and `onMusicCue(e)` on the components of the entity whose `AudioSource` plays the music (the engine's message style, like `onTriggerEnter`, ADR 0093).
  - Each event carries `{ handle, segment, bar, beat, cue?, time, heardIn }`. `time` is the exact heard time on `Audio.time`, and `heardIn = time − Audio.time`, so a script can schedule ahead.
  - After a long frame, missed beats fire together, each with its true time.
- **Scheduling on the grid from scripts:**
  - `handle.nextGrid('beat' | 'bar' | n)` returns a heard time, which works with `Audio.playOneShot(clip, { at })`.
  - `Audio.horizon` becomes public (read-only).
  - `handle.trigger(name)` fires a stinger, and `handle.setParameter` drives switches.

### 6. Rhythm mode (`audio.rhythmMode`, a project setting, off by default)

- **What it turns on:**
  - **Low latency:** it asks for the smallest `latencyHint` (numeric) and reads `baseLatency` and `outputLatency` back through the existing context path.
  - **Input judging:** `Audio.timeAt(performanceTime)` and `handle.music.positionAt(performanceTime)` map an input event's `event.timeStamp` to heard time and musical position.
  - **Calibration:** `Audio.calibration` holds the offset, persisted per output device and re-asked on device change. `Calibration.fromTaps(taps)` computes it (warm-up discard, median, MAD, a confidence value). A sample scene in `samples/` shows the tap screen; games build their own UI.
  - **Stamped transitions only:** asap music changes are refused, so old-grid callbacks never fire after a change.
- **What it leaves alone:** the lookahead floor, the limiter and the STATUS cadence (S5: they add ≈ 4 ms against the platform's 20–50 ms).
- **What it promises:**
  - sample-accurate music;
  - input mapped to the heard clock (0.04 ms p50 against Chromium's clock);
  - calibration that removes constant error.

  It promises **no absolute latency**.
- **`Audio.timeAt` is available without rhythm mode too.** It is cheap, and any game can judge input with it.

### 7. Budgets

- **Audio thread:** M4's own allowance on the reference machine (est., 2× this container), measured on high and modelled for the rest:

  | Preset | Typical | Worst |
  |---|---|---|
  | high | 0.05 ms | 0.08 ms |
  | default | 0.05 ms | 0.06 ms |
  | low | 0.04 ms | 0.04 ms |

- **Music voices count inside the preset's mixed-voice cap** (recommended; owner decision 2). Selection keeps music audible by priority, and the net change to high's total is ≈ −1% (est.), because a stem costs less than an average voice. If music sits outside the cap, high's typical total becomes ≈ 1.34 ms, over 0157's 1.3 ms.
- **Main thread:** the grid maths and beat prediction cost nanoseconds per instance, so there is no budget line.
- **Decoder worker:** ≈ 0.16% of a core per stream here. The phone is unverified.
- **Memory:** music rings 2.3–4.7 MB, plus the encoded copies of streamed stems (≈ 4.4 MiB per 3-minute MP3 at 192 kbps).

### 8. The Babylon fallback (best effort)

- **What works:** segments play, playlists step, switches change at bar boundaries, and beat callbacks fire from the same main-side clock (Babylon's `currentTime` without the latency correction).
- **Decoded clips:** stamped starts and fades work through Web Audio scheduling (`waitTime`, `linearRampToValueAtTime`).
- **Streamed stems** play as HTML5 streams without sample alignment, with one warning.
- **Rhythm mode** is unavailable, with a warning.

### 9. Editor (in the audio plugin's editor half)

- **Segment view:**
  - one lane per stem with its waveform;
  - the bar and beat grid from the tempo map;
  - tempo and metre markers;
  - draggable cues and loop regions;
  - zoom;
  - a playhead with transport (play from a cue, loop a region).

  It previews through the real backend.
- **Transition rules table:** from × to, with wildcards, a rule editor and an "audition this transition" button.
- **The event tree** gains the music nodes, plus a stinger list with a trigger button.
- **Import:** dropping files onto a new segment creates stems and reads the tempo and cue hints.
- **Deferred:** free arrangement of clips on a timeline (owner).

## Alternatives considered

- **Wwise's model as is (one tempo per segment).** Simpler maths. Rejected: the owner chose both models, and it forces composers to cut a piece wherever the tempo changes. The tempo map costs nanoseconds (S4).
- **FMOD's timeline as the whole model.** It is visual and composers know it. Rejected as the *only* model: large scores tangle on one timeline, and it needs a full clip-arranging editor (0158 deferred a timeline for that reason). Its tempo markers and regions are adopted inside segments.
- **A separate music asset kind (Wwise's separate hierarchy).** Rejected: it would duplicate handles, parameters, limits and the editor tree for no gain. Events already play music in sound-lab.
- **Decode all music whole.** It is always sample-exact, with no priming. Rejected: one 3-minute stem is 33 MiB, and low has 64 MB for all clips (S2). Short loops and stingers are decoded.
- **A PRIME command and core-side scheduling of whole transitions.** Rejected: a ring opened early already waits full (S1). Main-side planning keeps the core small, and S4 shows the core needn't know about music.
- **Beat callbacks from the audio thread (design B).** The core knows the exact frame. But events arrive 31–35 ms early, and holding them until they're heard is design A's rule anyway (S3). The core only reports the changes it decides.
- **Keep fades as stamped records that split the quantum.** That needs no change to the core. Rejected: +538 µs per split quantum, enough to reach p99.9 with a few fades per second (S4).
- **A bigger generic stream count instead of a music pool.** Rejected: music needs a guarantee (two sets of stems), and sound effects shouldn't take its rings or the reverse. Rings cost 300 KiB, so the pool is cheap.
- **Rhythm mode that also lowers the lookahead floor or the limiter.** Rejected: ≈ 4 ms of the 25–55 ms total, at real glitch risk, and the floor exists because of Chromium's render bursts (0157 architecture §4.7).
- **Port Godot's interactive music module.** MIT, but C++ inside Godot's server and with no cues or tempo maps. Its table shape is adopted instead.

## Consequences

**Positive**
- Composers get FMOD-style tempo, cue and region editing inside segments, and designers get Wwise-style rules for large scores, in one event format and one runtime.
- Transitions, stems and stingers are sample-exact on the core. Beat callbacks fire in the right frame with exact heard times, and scripts can schedule on the grid.
- The audio-thread cost is small (≈ +0.04–0.10 ms on high here). With music inside the voice cap, high's total doesn't grow.
- Two engine-wide fixes come with it:
  - stamped fades stop splitting the quantum for every voice;
  - slipped stream starts become visible.
- Rhythm games get input mapping, calibration and a low-latency setting without changes to the core.

**Negative / costs**
- **Main-thread complexity:** the music player, the planner and the prime protocol are new stateful code, with re-plan paths when the worker is late.
- **Memory:** streamed stems hold their encoded files in the worker (≈ 35 MiB for 8 MP3 stems). Lossless streamed stems are impractical on low. Range-request streaming is left for later (open question 3).
- **The editor is the largest part:** the segment view needs waveforms, a grid and markers, and the rules table needs auditioning.
- **The fallback is weaker:** no stem alignment for streams, and no rhythm mode on Babylon.
- **Estimate (provisional; the technical design's task table sets the real one):** ≈ **45–55 person-weeks** (revision 2, from the senior engineer's pricing of the unpriced work; the first draft said 38–46). Calibrated from M3, where features priced at 22 person-weeks became a 36.7 person-week task table (×1.67) once tests, benches, tooling and a reserve were added.

  | Feature (person-weeks) | Estimate |
  |---|---|
  | Format and validation | ≈ 1.5 |
  | Grid maths | ≈ 1 |
  | The main-side music player, rules, stingers and planner | ≈ 4 |
  | Streams: prime protocol, music pool, slip counter | ≈ 2.5 |
  | In-voice ramps | ≈ 1.5 |
  | Beat clock and API | ≈ 1.5 |
  | Rhythm mode and its sample | ≈ 2 |
  | Fallback | ≈ 1 |
  | Editor: segment view ≈ 4, rules table ≈ 1.5, tree and stingers ≈ 1, audition ≈ 1 | ≈ 7.5 |
  | Import hints | ≈ 0.5 |
  | Samples and listening pass | ≈ 1.5 |
  | **Features** | **≈ 24.5** |

  The range comes from multiplying by 1.55–1.85. It includes a reserve of about a third.
- **Milestones, each shippable:**
  - M4a: the grid, segments, playlists, stems and in-voice ramps;
  - M4b: switches, transition rules, bridges and stingers;
  - M4c: beat callbacks and rhythm mode;
  - M4d: the editor, samples and the listening pass.

## Deprecates

- **Stamped gain records that split the quantum:** replaced by in-voice ramps (§4).
- **Ad-hoc stems through a `layer` of looping clips:** sound-lab's `music-intensity` becomes a segment with stems. The `layer` node itself stays.
- **Flappy's decoded `town.mp3`:** becomes a streamed music segment in the sample update.

## Open questions

Owner decisions. Revision 2's list at the end supersedes this one.

1. **Ring pool sizes:** music rings of 8 / 12 / 16, or larger.
2. **Music inside the mixed-voice cap** (recommended) or on top of it.
3. **Encoded memory:** accept whole encoded files in the worker for M4 (recommended), or add range-request streaming now (more work: fetch ranges on web, file reads on Tauri).
4. **The callback API's shape:** component messages plus `handle.music` (recommended), or polling only (0157 avoided event systems, but component messages exist, ADR 0093).
5. **Rhythm mode's calibration UI:** a sample scene only (recommended), or a ready-made prefab.
6. **Whether `Audio.timeAt` and `Audio.horizon` are public without rhythm mode** (recommended: yes).
7. **The listening pass's exit checks:** seams, crossfade curves, stinger timing and beat-callback feel.

## References

- Goal: [docs/design/0166-audio-music/goal.md](../design/0166-audio-music/goal.md).
- Spikes: [spikes/audio-music/README.md](../../spikes/audio-music/README.md) and its sub-spikes: `research/`, `streams-align/`, `stream-throughput/`, `beat-clock/`, `cost/`, `rhythm/`.
- 0157 roadmap (M4) and architecture §4.7 (stamped records, lookahead); 0158 (event format, containers, automation); 0162 (budgets after M3).
- Code:
  - `src/engine/audio/eventFormat.ts`;
  - `src/plugins/audio/runtime/core/{lookahead,clock,hostClock}.ts`;
  - `src/plugins/audio/runtime/audioSystem.ts`;
  - `native/audio/crates/audio-core/src/{voices,stream,scheduler}.rs`;
  - `native/audio/crates/audio-decode/src/lib.rs`.

## RFC round (revision 2)

Five reviews, all "approve with changes", are in `docs/rfc/0166/`:
- `architect.md` (strong model);
- `senior.md`;
- `junior.md`;
- `composer.md` (the user persona);
- `challenger.md` (the premise challenger).

The coordinator checked every code claim against the code before acting on it. Two record claims were wrong and are corrected:
- **Every stamped record splits the quantum, not only gain records.** `render()` splits at any record with `offset > cursor` (`native/audio/crates/audio-core/src/voices.rs:310-325`). S4 had reported that stamped PLAY doesn't split.
- **The worker wraps loops, not the core** (`native/audio/crates/audio-core/src/stream.rs:72-73`).

The architect's claims all hold:
- the worker posts `streamOpened` before any chunk, on a different port from the chunks (`src/plugins/audio/runtime/decoder/streams.ts:312-315`);
- `pump` fills one stream's credit before returning (`:498-510`);
- a hard rebuild relaunches each stream asap from its own playhead (`src/plugins/audio/runtime/core/coreBackend.ts:1406-1422`).

This section wins over the text above it.

### Changes to the decision

1. **Stems are a group, kept together by a gate in the core** (architect, blocking).
   - PLAY records carry a **group id**. The core starts a group's voices at their stamp if every member's ring holds at least 4,096 frames.
   - Otherwise **all members wait together** and start at the same offset in the first quantum where all are ready.
   - A late group stays aligned, and the core reports it per voice with the start frame (STATUS stream event).
   - **Rebuild, seek and recovery reopen a group as a group**, with the music player owning it. They never reopen stem by stem.
   - This replaces the first draft's bare slip counter. A `streamStartsLate` counter and the largest slip stay in `Audio.debug()`.
2. **The prime acknowledgement is ring state seen by the worklet, not a worker message** (architect, blocking).
   - STATUS carries a per-ring "primed" bit, at least 4,096 frames.
   - Main stamps the group once every bit is set. The deadline is T − L − one display frame, because the batch leaves on the frame after the bits arrive.
3. **The worker primes breadth-first** (architect). On a group open it sends each stem's first 4,096 frames before filling any ring further. Today `pump` fills each stream depth-first.
4. **The prime lead is measured, not assumed** (architect, challenger).
   - The planner's lead is max(horizon, 1.25 × an EMA of measured group prime times), starting at 100 ms.
   - The phone lead is unverified (≈ 160–480 ms at an assumed 8× slowdown, est.). It is a milestone exit check, with a warning when the lead exceeds one beat.
5. **Every stamped record that touches one voice applies inside that voice** (senior; replaces §4's "gain records only").
   - Gain ramps and **start offsets for PLAY and STOP** carry their frame in the voice, so a stinger or transition no longer splits the quantum.
   - Goldens stay bit-identical for unstamped work; stamped cases are re-recorded. REPLAY restores pending ramps and starts.
   - **This is its own first milestone (M4-0)**, independent of the music player, which works with today's splits meanwhile (challenger: music alone doesn't need it; it fixes the engine for every stamped sound).
6. **Loop wraps:** main predicts them (the worker wraps). A `while` region's condition is read when main must commit, one prime lead before the loop end, and released through the existing region-release splice. The record states that this is the condition's latency.
7. **Music ring pool policy** (architect, senior, junior).
   - The pool is a ring flag in `InitParams`, which is an ABI and layout change, priced.
   - When it is full, the planner **refuses** the new start, keeps the current music, and counts and warns.
   - Rings return as soon as the core reports the voice's end, not on the next display frame.
8. **Hidden tabs** (architect). With `audio.background` `play`, the player commits the next step a whole segment ahead, and a playlist always holds its next segment primed, so music carries on without display frames. On resume it re-plans from the heard position. With `mute` it re-plans on resume.
9. **No missed-beat bursts** (architect). After a gap longer than one beat, each callback kind fires **once** for the latest beat, with `missed: n`. Grid origins are stored as a musical position plus a heard time, never raw audio frames, so a context rebuild at a new rate recomputes them.
10. **The format** (senior, composer, junior):
    - **Nodes:**
      - `musicSwitch` is distinct (§1, edited above);
      - music nodes get an `id` (unique per event), and rules and stingers address ids or `*`;
      - `playlist` stays a distinct node, because it steps at exit cues under the rules, with groups and loop counts per item (Wwise's Music Playlist Container), unlike `sequence` and `random`, which step at clip ends.
    - **Limits:** tempo markers ≤ 64, cues ≤ 64, regions ≤ 16, rules ≤ 256, stingers ≤ 32, stems ≤ 16 per segment, alternatives ≤ 8 per stem.
    - **Precedence:** the most specific rule wins (exact pair, then `from`, then `to`, then `*`→`*`). The first listed wins within a tier, and the validator warns on duplicates. A rule between children of different containers comes from their **nearest common parent's** table (Wwise). `exit: nextCue` replaces `cue(name?)`.
    - **Pre-entry and post-exit (composer):**
      - a segment's audio before its entry cue starts early (start = entry − pre-entry), and the prime lead applies to that earlier start;
      - audio after the exit cue rings on under the next segment until it ends;
      - a loop region may declare a tail that is mixed over the loop start.
    - **Variation (composer):** a stem may list alternative clips of equal length, picked per pass by `random` or `sequence` (Wwise's random and sequence music tracks).
    - **Quantised parameter changes (composer):** an automation binding on a music instance may set `quantize: beat | bar`, which applies as a stamped in-voice ramp at the next grid point.
    - **Stingers (composer):** `ifTooLate: nextGrid | playNow | skip` for a stinger whose grid point is inside the lead. The default is `nextGrid`, with a warning.
11. **Encoder padding** (composer): validation reads the LAME/Xing delay and the Vorbis granule trim (the decoder's gapless path, `native/audio/crates/audio-decode/tests/loop_seam.rs`). A stem without gapless metadata warns.
12. **Visible failures** (junior, architect):
    - `Audio.debug().music` lists each instance with:
      - segment, bar and beat;
      - the pending transition and **the rule that matched**;
      - primed state, re-plans, refusals, late groups;
      - the ring pool in use.
    - The debug panel shows it, and each refusal warns once per cause.
13. **The iteration loop** (composer): hot reload of a playing segment re-primes it and swaps at the next bar; the segment view auditions from any cue or bar; the debug panel is the live music monitor.
14. **The API** (junior):
    - `handle.music` is readable from M4a; callbacks arrive in M4c.
    - `handle.music.positionAt(performanceTime)` returns `{ segment, bar, beat, beatFraction, nearestBeatTime, offset }` in seconds. `offset` is signed: positive means late.
    - `heardIn` is seconds **until** the beat is heard (≥ 0 unless missed).
    - `Audio.calibration` is **subtracted** from input offsets.
    - Every field states its unit.
15. **The estimate** (senior) is **≈ 45–55 person-weeks**, provisional. The senior priced ≈ 12 person-weeks of unpriced work: goldens and replay, wire and status plumbing, the prime protocol, benches, e2e, docs and listening-pass rework. Milestones: **M4-0** (in-voice stamped records), M4a, M4b, M4c, M4d.

### Not taken, and why

- **The challenger's 10–12 person-week grid layer.** It would make transitions, cues, bridges and playlists script recipes, against the owner's confirmed scope (goal.md). The milestones let the owner stop after any one.
- **The challenger's 28–33 person-week middle cut.** It drops the Babylon fallback, rhythm calibration and drag editing, all of which the owner asked for. In-voice records are moved to M4-0 rather than cut.
- **Tempo ramps (accelerando, composer).** Deferred. Neither Wwise segments nor the survey's verified FMOD data show ramps. A ramp is a stepwise tempo map for now.
- **Signal-driven ducking for music (composer).** That is M5's live mix and LUFS work (0157 roadmap). Duck ramps on music buses may start on a stamped grid point through M4-0's in-voice records.
- **Decoded stems on low (architect's cheaper alternative).** It is already the rule for loops ≲ 30 s. Long stems are 33 MiB each.
- **Polling only, no callbacks (junior's cheaper alternative).** Taken as staging: `handle.music` in M4a, component messages in M4c.

### Owner decisions (to bring after the RFC round)

1. **Position units.** The composer and the senior engineer disagree:
   - (a) **musical positions**: bar:beat:tick against the tempo map, seconds derived. Cues stay on the beat when tempo is corrected; this is how DAWs work and how Wwise and FMOD display positions (recommended);
   - (b) **audio frames**: integers, exact. Cues stay on the audio when tempo is corrected; this is how Wwise stores ms.
2. **Music ring pool sizes:** 8 / 12 / 16.
3. **Music inside the mixed-voice cap** (recommended).
4. **Whole encoded files in the worker for M4** (recommended), or range streaming now.
5. **Callback API shape:** component messages plus `handle.music` (recommended).
6. **The estimate:** ≈ 45–55 person-weeks provisional, in milestones M4-0, M4a–d.

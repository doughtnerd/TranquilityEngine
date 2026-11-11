# S0: interactive-music prior art (research only)

**Evidence status (second pass).** Pass 1 had only blocked doc hosts. Pass 2 (section "Verified upgrades" at the end) read primary sources on raw.githubusercontent.com (fetched 2026-11-11, default branches; commit SHAs were not obtainable because the API is search-only, so cite repo + path + date). Claims upgraded there are [V]; the per-system notes above still carry their pass-1 [U] marks unless the end section overrides them. Pass-1 note: every documentation host failed DNS (docs.godotengine.org, audiokinetic.com, docs.unrealengine.com, developer.mozilla.org, docs.rs: not in the allowed network domains). Only WebSearch worked and returned snippets. So almost everything below is **[U]** (from training knowledge, not re-read today). **[V]** marks only what a search result stated, with its URL. A follow-up pass needs those hosts allowed; the "to verify first" list at the end is ordered by decision impact.

Legend: [V] verified in cited primary source; [U] unverified.

## Comparison table

| Concept | Wwise [U] | FMOD Studio [U] | Godot 4.3+ | Unreal | Kira / Elias [U] |
|---|---|---|---|---|---|
| Piece of music | Music Segment (tempo, one time sig, grid) | Event timeline (+ tempo markers, time sig) | AudioStreamInteractive clip (an AudioStream; BPM/beat_count/bar_beats on the stream) | Wave + Quartz clock | Kira: sound on a clock; Elias: "Theme/Track" |
| Tempo change inside | No (one tempo per segment) | Yes (tempo markers) | No (one BPM per stream) | Harmonix: MIDI tempo map, yes | Elias: no [U] |
| Cues | Entry/exit + custom cues | Markers, named + loop/transition/destination regions | none (beats only) | Quartz: none; Harmonix: MIDI markers | Elias: "markers" |
| Pre-entry / post-exit | Yes (tails outside entry..exit) | Not explicit; tails via timeline | no | no | no |
| Stems | Music Track(s) in a segment, sub-tracks; switch tracks | Multi-track timeline / nested events | AudioStreamSynchronized | n/a | Elias: layers/tracks |
| Playlist | Music Playlist Container (groups, continuous/step, random/shuffle, loop counts) | Multi/scatterer instruments, loop regions | AudioStreamPlaylist (order, shuffle, loop, fade_time) | n/a | Elias: playlist-ish |
| State switch | Music Switch Container (states/switches, "continue to play") | Parameter-driven transition regions/destination markers | AudioStreamInteractive `switch_to_clip` | n/a | Elias: theme switching |
| Transition rules | Matrix: source exit (immediate/next grid/beat/bar/cue/exit cue), dest entry (entry cue/same time/random cue/matching cue), fades w/ offset+curve, transition segment, pre-entry/post-exit | Transition markers/regions with quantisation, destination markers/regions, transition timelines, magnet regions | Transition table from/to; from_time, to_time, fade_mode, fade_beats, optional filler (transition) clip, hold_previous | PlayQuantized at a boundary | Kira: start_time = clock tick |
| Stingers | Trigger+segment, play at (next grid/beat/bar/cue/immediate), don't-repeat time, look-ahead | Quantised trigger / nested event on a timeline | none built-in | PlayQuantized | n/a |
| Beat callbacks | AK_MusicSyncBeat/Bar/Entry/Exit/Grid/UserCue/PlaylistSelect via AK_CallbackType | FMOD_STUDIO_EVENT_CALLBACK_TIMELINE_BEAT / TIMELINE_MARKER | none per beat (BPM metadata only) | Quartz metronome delegates; Harmonix MusicClock beat/bar events | Kira: clock tick queries |

## What I could verify

- [V] Godot `AudioStreamInteractive.add_transition(from_clip, to_clip, from_time, to_time, fade_mode, fade_beats, use_filler_clip=false, filler_clip=-1, hold_previous=false)`; `fade_beats` is a float; fade modes FADE_IN, FADE_OUT, FADE_CROSS, FADE_AUTOMATIC (FADE_DISABLED from 4.4); filler clip optional. Source: https://docs.godotengine.org/en/4.3/classes/class_audiostreaminteractive.html (via search snippet; also .../en/4.6/...).
- Everything else is [U].

## Notes per system (all [U] unless marked)

**Wwise.** Segment = tempo + one time signature + grid; entry and exit cues are the "playable" region, pre-entry and post-exit carry lead-in and tails that overlap the neighbour. Tracks inside a segment: normal, random, sequence, switch, each with sub-tracks. Playlist container: nested groups, continuous (flows on) or step (one per trigger), random/shuffle-avoid-repeat, loop counts. Switch container binds a state/switch to a child, with "continue to play" to keep the segment when the new state maps to the same child. Matrix is per source/destination (with any/nothing/ID wildcards), with a rule per pair. Stingers attach to a container, keyed by trigger, "play at" quantised to next grid/bar/beat/cue/immediate, with don't-repeat time. Callbacks arrive on the game thread after Audio thread processing in `RenderAudio`; granularity is one audio frame (default 1024), so beat events can be late by up to a frame and are not compensated for output latency by default (query position via `AK::SoundEngine::Query::GetPosition`, which is "source position", not heard position).

**FMOD.** Timeline logic: tempo markers (BPM, time sig), loop regions with conditions, transition markers/regions (quantised to bar/beat/etc.; "transition timeline" plays a bridge before jump), destination markers/regions, magnet regions (snap). Stems = nested events or multi-track. Known issue: Studio callbacks fire from the Studio update thread, so beat callbacks are early/late by up to an update interval and are not output-latency compensated; rhythm games use `getDSPClock` + manual compensation.

**Unreal.** Quartz: a UQuartzClockHandle with BPM/time sig, quantisation boundaries (Bar, Beat, Tick divisions, ThirtySecondNote...), `PlayQuantized` on audio component and a "Quartz command delegate" fired at execute time; metronome delegate per beat/bar; latency: Quartz commands are scheduled on the audio render thread at sample offsets, and delegate events are queued back to the game thread (late by a frame or so), with "latency to game thread" compensation optional. Harmonix plugin (MusicClock, MIDI tempo maps, beat/bar/MIDI-marker events) adds an output-latency offset when computing "audible" song position.

**Godot (MIT).** Design is a simpler subset: the clip *is* a stream with BPM/bar info; transition table with `from_time` (immediate/next beat/next bar/end) and `to_time` (same position/start), fade in beats, optional filler clip; playlist and synchronized (stems) are separate stream types. Portable: the transition-table semantics and beat-based fade lengths; code is C++ inside the server mixer, not portable, ideas only.

**Kira (MIT/Apache) [U].** Clocks are tickable objects with speed; `ClockTime {clock, ticks, fraction}`; `StartTime::ClockTime` schedules a sound on an exact tick; clocks can be paused/changed in speed (tempo). Closest match to M3's `at` stamps, and a good design for a music clock driven by the audio thread.

**Elias [U].** Closed-source middleware; "Elias Studio" authoring; concepts: themes, levels (intensity), transitions at beat/bar. Nothing portable.

**Rhythm-game practice [U].** Unity `AudioSettings.dspTime` + schedule ahead with `PlayScheduled`; song position = dspTime minus start minus latency offset; players calibrate (tap to the beat / audio-visual offset) because OS-reported latency is unreliable. Input is timestamped at event time and judged against the audio clock, not frame time. Rhythm Doctor and NecroDancer devs publicly describe per-device calibration offsets (details unverified).

**Web Audio [U].** `AudioContext.baseLatency` (processing buffer), `outputLatency` (device/OS; Chromium yes; Firefox 70; Safari 18.4: see Verified upgrades, which overrides this [U] line), `getOutputTimestamp()` returns `{contextTime, performanceTime}` (Chromium and Firefox yes, Safari partial [U]). `latencyHint`: "interactive" | "balanced" | "playback" | number (seconds). Android WebView follows Chromium but real latency is device-dependent. Implication: calibration must be the contract in rhythm mode; reported latency is a starting guess only.

**File formats [U].** WAV: `cue ` chunk (id, sample position) + `LIST/adtl` `labl`/`ltxt` (names, regions); `smpl` chunk (loops, MIDI unity note); `acid` chunk (type flags incl. one-shot/loop, root note, beats, meter num/den, tempo float). Ogg Vorbis has no standard for cues; conventions: Vorbis comments (`LOOPSTART`, `LOOPLENGTH`, `BPM`, ...) engine-specific. MIDI: tempo meta event FF 51, time signature FF 58, marker FF 06, cue FF 07; a tempo map = ordered (tick, microsecondsPerQuarter). DAWs: Reaper exports cues/regions in WAV (`cue `/`adtl`), Ableton writes acid-ish only for warp info in .asd (not exported); Logic/Cubase write markers [U]. An importer could read `cue `/`adtl` and `acid`; treat as hints only, with the sidecar JSON authoritative.

## What M4 should adopt (recommendations)

| Concept | Wwise | FMOD | Godot | Quartz | M4 name / recommendation |
|---|---|---|---|---|---|
| Piece | Music Segment | Event timeline | Clip | n/a | `segment` |
| Tempo | tempo + time sig (static) | tempo marker | bpm | clock BPM | `tempoMap: [{atBeat|atFrame, bpm, num, den}]` |
| Cue | entry/exit/custom cue | marker | none | none | `cues: [{name, kind: entry|exit|custom, frame}]` |
| Loop | loop count on segment | loop region | loop | n/a | `loops: [{startCue, endCue, count, condition?}]` |
| Stems | music tracks | tracks / nested events | Synchronized | n/a | `tracks` with existing M2 layer/curve semantics |
| Playlist | Playlist container | scatterer/multi | AudioStreamPlaylist | n/a | `playlist` node (extends M2 `sequence`/`random`) |
| Switch | Switch container | parameter region | switch_to_clip | n/a | reuse M2 `switch` node with music change rules |
| Transition | matrix rule | transition region | table row | quantised cmd | `transitions: [{from, to, exitAt, enterAt, fade, bridge?}]` |
| Quantise | next grid/beat/bar/cue | transition quantisation | from_time | boundary enum | `Quantize = immediate|beat|bar|grid|cue|exitCue` |
| Stinger | stinger | quantised trigger | none | PlayQuantized | `stingers: [{trigger, segment, at: Quantize, dontRepeat}]` |
| Callbacks | AK_MusicSync* | TIMELINE_BEAT/MARKER | none | metronome delegates | `onBeat/onBar/onCue` events on a music clock, latency-compensated |
| Clock | n/a | DSP clock | n/a | Quartz clock | `MusicClock` over the audio frame counter (M3 `at` stamps) |

## Where M4 differs (candidates)

1. Tempo and metre maps inside a segment (Wwise cannot; FMOD can). Cost: grid maths must walk a map; do it on main thread.
2. One model for both: Wwise structure plus FMOD regions, instead of a free timeline (free arrangement is deferred by the owner).
3. Callback time is the *heard* time (ClockMap output-latency compensated) rather than render time; Wwise and FMOD deliver render-time events (u).
4. Rhythm mode as a project setting with calibration, instead of per-title hand-rolled offsets.
5. Cue positions in sample frames of the decoded clip; sidecar JSON is the truth, WAV `cue `/`acid` only import hints.
6. Extend M2's `myco.audioevent` nodes rather than a second asset family; bump the format version.

## Licences of portable things

Godot: MIT (design port only). Kira: MIT or Apache-2.0 [U]. Quartz/Harmonix: Epic EULA, not portable. Wwise/FMOD/Elias: proprietary, study only; do not copy docs or UI.

## To verify first (needs the doc hosts allowed)

1. Wwise: whether music callbacks are output-latency compensated, and per-segment tempo-change limits.
2. FMOD callback timing and transition quantisation options.
3. Quartz latency-compensation approach.
4. MDN compat for `outputLatency` / `getOutputTimestamp` in WebKit and Android WebView.
5. Kira `ClockTime` semantics and licence file.
6. `acid` and `cue ` layout details from the RIFF spec.

## Verified upgrades (pass 2, all [V] unless marked)

Sources (raw.githubusercontent.com, default branch, 2026-11-11): G = godotengine/godot `modules/interactive_music/audio_stream_interactive.cpp`, `.h`, `modules/interactive_music/doc_classes/AudioStream{Interactive,Playlist,Synchronized}.xml`, `modules/vorbis/doc_classes/AudioStreamOggVorbis.xml`; K = tesselode/kira `crates/kira/src/{clock.rs,clock/time.rs,clock/clock_speed.rs,start_time.rs,info.rs}`, `LICENSE-MIT`, `crates/kira/Cargo.toml`; M = mdn/browser-compat-data `api/AudioContext.json`; W = WebAudio/web-audio-api `index.bs`; F = ejoy/ant `3rd/fmod/windows/studio/inc/fmod_studio_common.h` (a third-party vendored copy of FMOD's header; version unknown); A = mariofv/LittleOrionEngine `Libraries/include/AK/SoundEngine/Common/AkCallback.h` (vendored Wwise header; version unknown).

**Godot (MIT).**
- [V] Enums: `TransitionFromTime` IMMEDIATE 0 / NEXT_BEAT 1 / NEXT_BAR 2 / END 3; `TransitionToTime` SAME_POSITION 0 / START 1 / PREVIOUS_POSITION 2; `FadeMode` DISABLED 0 / IN 1 / OUT 2 / CROSS 3 / AUTOMATIC 4; `AutoAdvanceMode` DISABLED / ENABLED / RETURN_TO_HOLD; `CLIP_ANY = -1` wildcard for from or to (xml).
- [V] Transition record: from, to, from_time, to_time, fade_mode, fade_beats (float), use_filler_clip, filler_clip, hold_previous; keyed by (from,to) with ANY wildcards (xml, cpp:246-259).
- [V] Quantising (cpp:686-725): the source stream must have `bpm`; wait = beat_sec - fmod(position, beat_sec) for NEXT_BEAT, same with bar_beats * beat_sec for NEXT_BAR (bar_beats 0 plays immediately), END = beat_count * beat_sec (or stream length) minus position; the fade length is `fade_beats * beat_sec`; without BPM the wait is 0 (or to the end) and fade_beats is read as seconds. So: static tempo per clip, no cues, quantise inside the mix callback with float seconds (block-granular, not stamped).
- [V] Filler clip (cpp:803-814): started at 0, fully on, with a fade_wait equal to the source's wait; the destination then starts after the filler (cpp:789 stops a clip that is neither destination nor filler). This is a "transition segment" in the owner's sense but with no pre-entry/post-exit overlap logic.
- [V] `AudioStreamOggVorbis`: `bpm` float 0.0, `beat_count` int 0, `bar_beats` int 4; loop ends at the last beat when beat_count is set (xml). `AudioStreamPlaylist`: stream_count, shuffle (false), loop (true), fade_time (0.3 s). `AudioStreamSynchronized`: stream_count, per-stream volume (stems).
- Portable: the transition-table shape with ANY wildcard, beat-length fades, filler/bridge, auto-advance with "return to hold" (idea for stingers/one-shot sections). Not portable: the C++ code (Godot-internal types); ideas only, notice not required for ideas, required if code is copied (MIT).

**Kira (MIT OR Apache-2.0, `crates/kira/Cargo.toml` license field; root `LICENSE-MIT` "Copyright 2021 Andrew Minnich").**
- [V] `ClockTime {clock: ClockId, ticks: u64, fraction: f64 in [0,1)}`, comparable only within one clock; `ClockSpeed` = SecondsPerTick | TicksPerSecond | TicksPerMinute (f64); clocks start stopped and need `start()`; `StartTime` = Immediate | Delayed(Duration) | ClockTime(ClockTime).
- [V] Start check (`info.rs` when_to_start): a pending start fires when the clock is ticking and `clock_info.time >= time`, evaluated in `update(dt, info)`: a per-update check, so Kira's clock-start granularity is the audio block, not the sample [from code reading; whether sub-block offset is applied elsewhere is [U]]. Design to borrow: ticks as the unit with a fractional part, clock speed changeable at runtime (tempo changes), "start at clock time" as the only scheduling primitive. Myco's stamped records (M3 `at`) are already finer.

**Web Audio.**
- [V] Support (M): `baseLatency` Chrome 58, Firefox 70, Safari 14.1; `outputLatency` Chrome 102, Firefox 70, **Safari 18.4** (the pass-1 guess that WebKit lacked it is out of date); `getOutputTimestamp` Chrome 57, Firefox 70, Safari 14.1; Chrome Android, WebView Android and iOS Safari all "mirror" desktop Chrome/Safari, i.e. WebView follows its Chromium version (Chromium 102+ for outputLatency).
- [V] Spec (W): `outputLatency` is "the interval between the time the UA requests the host system to play a buffer and the time at which the first sample ... is actually processed by the audio output device"; it can change while running and "is useful to query this value frequently when accurate synchronization is required". `getOutputTimestamp()` returns `{contextTime, performanceTime}`: the frame currently being rendered by the output device (in `currentTime` units) and when that frame was rendered (`performance.now()` origin); both 0 until a block has been processed. `AudioContextLatencyCategory` = balanced | interactive | playback; the constructor also accepts a number of seconds (latencyHint is `(AudioContextLatencyCategory or double)`: [U] for the exact IDL). The spec also lists both values as fingerprinting surfaces, so browsers may coarsen them.
- Implication: still calibrate; but heard-time = contextTime-based position minus outputLatency is available on Chromium, Firefox, WebKit 18.4+.

**Wwise headers (A, vendored copy, version unknown).**
- [V] `AkCallbackType`: AK_MusicPlayStarted 0x0080, AK_MusicSyncBeat 0x0100, Bar 0x0200, Entry 0x0400, Exit 0x0800, Grid 0x1000, UserCue 0x2000, Point 0x4000 (switch-transition sync point), SyncAll 0x7f00, AK_MIDIEvent 0x10000, AK_EnableGetMusicPlayPosition 0x200000.
- [V] `AkMusicSyncCallbackInfo {playingID, segmentInfo, musicSyncType, pszUserCueName}`; `AkSegmentInfo {iCurrentPosition (ms, relative to Entry Cue, range [-preEntry, active+postExit]), iPreEntryDuration, iActiveDuration, iPostExitDuration, iRemainingLookAheadTime, fBeatDuration, fBarDuration, fGridDuration, fGridOffset}`. Note: positions in whole ms, and the segment info carries one beat/bar duration, i.e. one tempo per segment, confirming "no tempo change inside a segment".
- Still [U]: callback delivery latency vs output (headers do not say).

**FMOD headers (F, vendored copy, version unknown).**
- [V] `FMOD_STUDIO_EVENT_CALLBACK_TIMELINE_MARKER` 0x00000800, `..._TIMELINE_BEAT` 0x00001000, `..._NESTED_TIMELINE_BEAT` 0x00040000; `FMOD_STUDIO_TIMELINE_BEAT_PROPERTIES {int bar, beat, position; float tempo; int timesignatureupper, timesignaturelower}` (so FMOD reports tempo and metre per beat, i.e. tempo/metre can vary along a timeline); `FMOD_STUDIO_TIMELINE_MARKER_PROPERTIES {const char* name; int position}` (ms).
- Still [U]: callback thread/timing (the "early/late" issue).

**Unreal Quartz / Harmonix:** unchanged, [U] (private repo).

## Corrections to pass-1 text
- Godot has per-clip BPM/bar_beats/beat_count and a filler clip; it does not have cues or tempo maps ([V]).
- Wwise segment info exposes one beat/bar duration per segment ([V], consistent with the claim).
- WebKit has `outputLatency` from 18.4 ([V], replaces [U]).
- Kira's clock-start check is per audio update, not per sample ([V] code reading), so a Myco music clock built on M3 stamped records can be more precise than Kira's.

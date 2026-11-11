# S0: interactive-music prior art (research only)

**Evidence limit.** In this session every documentation host failed DNS (docs.godotengine.org, audiokinetic.com, docs.unrealengine.com, developer.mozilla.org, docs.rs: not in the allowed network domains). Only WebSearch worked and returned snippets. So almost everything below is **[U]** (from training knowledge, not re-read today). **[V]** marks only what a search result stated, with its URL. A follow-up pass needs those hosts allowed; the "to verify first" list at the end is ordered by decision impact.

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

**Web Audio [U].** `AudioContext.baseLatency` (processing buffer), `outputLatency` (device/OS; Chromium yes; Firefox since 70 yes [U]; Safari/WebKit: not implemented as far as I recall), `getOutputTimestamp()` returns `{contextTime, performanceTime}` (Chromium and Firefox yes, Safari partial [U]). `latencyHint`: "interactive" | "balanced" | "playback" | number (seconds). Android WebView follows Chromium but real latency is device-dependent. Implication: calibration must be the contract in rhythm mode; reported latency is a starting guess only.

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

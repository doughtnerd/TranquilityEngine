# S0: M5 prior art (profiler, loudness, live mix, sidechain, bus automation)

Research only. Goal: [docs/design/0171-audio-mix/goal.md](../../../docs/design/0171-audio-mix/goal.md). Shape follows `spikes/audio-music/research/README.md`.

## Evidence status

Fetched 2026-11-12 from default branches (no commit SHAs: the GitHub API is blocked, so cite repo + path + date). Re-fetch with `./fetch.sh` (writes `sources/`, not for committing).

**Reachable:** raw.githubusercontent.com, index.crates.io (sparse index).
**Blocked (DNS or 403):** crates.io/api, docs.rs, docs.unity3d.com, fmod.com, audiokinetic.com, geode docs, bobthenameless.github.io, google. WebSearch works but returns titles only.
Consequence: **everything about Wwise and Unreal, and the Unity/FMOD profilers and the FMOD Studio live-update/snapshot behaviour, is [U]** (memory). What is [V] is a header, a source file or a registry record I read. Docs hosts to allow for a follow-up: audiokinetic.com, fmod.com, docs.unity3d.com, dev.epicgames.com.

Legend: **[V]** read in a primary source (path given); **[U]** from memory or secondary.

Sources read (all [V] below refer to these):
- `jiixyj/libebur128` `ebur128/ebur128.c`, `COPYING` (MIT)
- `sdroege/ebur128` (Rust crate) `Cargo.toml`, `src/{lib,ebur128,filter,true_peak,interp,history}.rs`; `index.crates.io/eb/ur/ebur128` (latest 0.1.11, deps listed there)
- `Unity-Technologies/UnityCsReference` `Editor/Mono/Audio/Mixer/GUI/AudioMixerWindow.cs`, `AudioMixerChannelStripView.cs`
- `godotengine/godot` `servers/audio/audio_server.cpp`, `servers/audio/effects/audio_effect_compressor.cpp`
- FMOD Core headers (2.x, "2004-2024") vendored in `geode-sdk/geode` `loader/include/Geode/fmod/{fmod.h,fmod_common.h,fmod_dsp.h,fmod_dsp_effects.h}`. FMOD Studio headers (`fmod_studio*.h`) were **not** found, so Studio API claims are [U].

---

## 1. Profilers

| Tool | What it records / how it works | Mark | Source |
|---|---|---|---|
| Wwise Profiler (Advanced Profiler layout: Capture Log, Voices Graph, Voice Monitor, Performance Monitor, Game Object / RTPC / Bus / Streaming / Memory / Output Meter views) | Connects to the game over a TCP socket (Wwise Communication module, default port ~24024; the sound engine is built with comms). Records Capture Log entries (every posted event, action, state/switch/RTPC change, bank load, voice start/stop), a **Voices Graph** showing each voice's lifetime with its virtual/physical state and the reason a voice was killed or virtualised (limited by playback limit, max-per-game-object, below volume threshold, bus limit), **Voice Monitor** with active vs virtual vs total, **Performance Monitor** with CPU graph, plugin CPU per effect type, memory per category, voice and streaming counts. Sessions are captured to `.prof` files (a SQLite-like binary under the project's `.cache`/`Capture` folder) and reopened offline; a timeline cursor scrubs; all views follow the cursor. Update rate is per profiler "polling" (~25 Hz by default for graphs). Game connection is network (Remote Connect), also local in-process to the Authoring app. | [U] | memory |
| FMOD Studio profiler | Two modes: live profile (network, port 9264 by default, requires the game to init Studio with `LIVEUPDATE`, Core with `FMOD_INIT_PROFILE_ENABLE`) and **API capture** (file extension and format not verified). Tracks: CPU (DSP, streaming, update, convolution), voices (real/virtual/total), memory (by category), file (streaming), event instances; also session recordings that can be **played back** with a scrubbable timeline and per-bus/event inspection. A separate "command capture/replay" (`Studio::System::startCommandCapture`) records the API call stream to a file for replay. | [U] (flag names V below) | memory |
| FMOD profile switches in Core | `FMOD_INIT_PROFILE_ENABLE` (start the profiler server), `FMOD_INIT_PROFILE_METER_ALL` (insert a metering/peak DSP on **every** DSP so the profiler can show levels everywhere), `FMOD_INIT_MEMORY_TRACKING` | **[V]** | `fmod_common.h:92-98` (Geode copy) |
| FMOD run-time stats API | `System::getCPUUsage` returns `{dsp, stream, geometry, update, convolution1, convolution2}` floats (percent of a mixer block); `getChannelsPlaying(channels, realchannels)` gives virtual-vs-real counts; per-DSP `getCPUUsage(exclusive, inclusive)` in microseconds (units [U]); `Channel::isVirtual`; per-DSP `setMeteringEnabled` + `getMeteringInfo` (`peaklevel[32]`, `rmslevel[32]`, `numsamples`). Hence FMOD's profiler data is the **same data the game can poll**. | **[V]** | `fmod_common.h:877-885`, `fmod.h:103-104,349,576-579`, `fmod_dsp.h:306-312` |
| Unity Profiler Audio module | Per-frame counters: Total/Playing Audio Sources, Paused, Audio Voices, Audio Clips, DSP CPU %, Stream load %, Clip memory, Total/Streaming/ clip/ DSP-buffer memory; in the lower pane an Audio detail view: Simple (Channels/Groups listing) and Detailed (per-source: volume, audibility, distance, clip name, **“virtual” and a reason? only the played-ness)**, plus a Groups tab with per-mixer-group levels and a DSP-load view. Data lives in the normal Profiler frame buffer (300 frames default, `.data` file save/load for a capture). In-process for the Editor, network/ADB for players. The Audio Mixer window shows per-group dB levels live. | [U] | memory. I could not fetch the module source: the guessed paths for `AudioProfilerModule.cs` are 404 in UnityCsReference |
| Unreal Audio Insights (UE 5, Trace-based) | Built on Unreal Insights: the audio engine emits trace events (`AudioInsights`/`TraceLog`) to a `.utrace` file or live TCP; the Audio Insights dashboard has Log, Sounds (active sounds with Virtualization), Audio Meters, Mixer/Submix graph, Plots/Attenuation, Oscilloscope, Spectrogram, Vu-meter; capture file is the shared `.utrace` that Insights scrubs (timing view with a time ruler). Voice counts and virtualised/stolen sounds are shown per active sound. Rate is event-driven plus ~per-frame sampling. | [U] | memory |

Common shape (all [U] except where marked): a **timestamped sample/event stream** (live over a socket or recorded to a file), a timeline widget with a cursor, and per-view "state at cursor" lookups. Only FMOD publishes the poll API (V). This confirms the goal's design: capture file == the same stream as a later live link.

**What to adopt.** The stream of timestamped snapshots; a voices track that carries a **reason code** for virtual/stolen/dropped; CPU per bus and per effect type if cheap; separate "counters" (every STATUS) from "events" (on change); a cursor that pins all panels.
**Where Myco differs.** One format in both a file and a socket (Wwise `.prof` and Unity `.data` are tool-private); capture works in release exports only when the developer asks; browser/WebView hosts have no high-resolution timer in the worklet, so CPU is derived from work units and a block-time measure, not a per-effect profiler; no network link in M5.

## 2. Loudness metering

### Algorithm facts

| Item | Fact | Mark | Source |
|---|---|---|---|
| K-weighting | Two cascaded biquads: high-shelf `f0=1681.974450955533 Hz, G=3.999843853973347 dB, Q=0.7071752369554196` and high-pass `f0=38.13547087602444 Hz, Q=0.5003270373238773`, derived for **any rate** with `K=tan(pi*f0/fs)` (bilinear transform with those pre-computed analog parameters). The high-pass numerator is `1,-2,1`. | **[V]** | `libebur128.c:251-300`; same in `sdroege/ebur128 src/filter.rs:68-93` |
| 48 kHz coefficients | Shelf b = 1.53512485958697, -2.69169618940638, 1.19839281085285; a = -1.69065929318241, 0.73248077421585. High-pass a = -1.99004745483398, 0.99007225036621. I computed them from the formula (`kweight.mjs`) and they equal the published BS.1770 table values. 44.1 kHz: shelf b = 1.53084123, -2.65097999, 1.16907908, a = -1.66365511, 0.71259543; HP a = -1.98916967, 0.98919904. | **[V]** (computed from V formula; match to BS.1770 table is from memory) | `kweight.mjs` output |
| Gating | Block = 400 ms, hop 100 ms (75% overlap); absolute gate -70 LUFS; relative gate = mean energy of blocks above absolute gate, minus 10 LU (`relative_gate = -10.0`). Loudness = -0.691 + 10 log10(sum G_i z_i). The first block needs 400 ms of audio. | **[V]** | `libebur128.c:68-69,111-114,454-458,507-523` |
| Channel weights | Surround channels weighted +1.5 dB (G = 1.41), LFE excluded; L/R/C 1.0 | [U] | BS.1770 |
| Momentary / short-term | 400 ms and 3 s windows (window = 3000 for S mode, 400 for M mode); S-mode is also the LRA source. | **[V]** | `libebur128.c:452-454`; `ebur128.rs:513-515` |
| Integrated storage | libebur128 and the Rust crate keep either a **1000-bin histogram** (0.1 LU bins from -70 LUFS) or the full block list. The histogram makes the integrated measure O(1) memory, at about 0.1 LU resolution. | **[V]** | `libebur128.c:115-124,476-487,515-523`; `history.rs:52-58` |
| LRA | EBU Tech 3342: short-term (3 s) blocks, abs gate -70, relative gate -20 LU, then 95th minus 10th percentile of the gated distribution. libebur128 computes percentiles with `(n-1)*0.95+0.5` / `(n-1)*0.1+0.5`. | **[V]** impl; the -20 LU constant [U] | `libebur128.c:1393-1400` |
| True peak | Oversample, then max of abs. libebur128: **4x when rate < 96 kHz, 2x when < 192 kHz, none above**, with a **49-tap** FIR (Hann-windowed sinc, `interp_create(49, 4, ch)`). The Rust crate uses `TAPS = 48` (a const generic, per-factor polyphase). BS.1770 Annex 2 shows a 48-tap 4x reference filter [U]. | **[V]** | `libebur128.c:344-352`; `true_peak.rs:51-55`; `interp.rs:24` |
| True-peak accuracy | The crate has a `precision-true-peak` feature: slightly more precise but significantly slower without FMA | **[V]** | `Cargo.toml` features |
| BS.1770-5 | 2023 revision adds immersive/object audio channel handling; the gate and weighting for 2.0/5.1 are unchanged. | [U] | memory |

### Compliance test signals and targets

| Item | Fact | Mark |
|---|---|---|
| EBU Tech 3341 (metering spec: M, S, I, true-peak display, reset/pause/ scale -18..+9 LU) | defines the required modes; a meter should have **Run, Pause and Reset** | [U] |
| EBU Tech 3341/3342 test set (`ebu-loudness-test-setv05.zip`): e.g. 1 kHz sine at -23 LUFS stereo (I = -23.0), -33 LUFS, gating tests (-36/-23 steps), 1 kHz **-20 LUFS** short-term tones, 20 s / 10 s / 5 s LRA signals with LRA of 10/5/20/15 LU, true-peak tests at 0 dBTP with overs. Several are synthetic sines with gain steps, so **can be synthesised** (e.g. 997 Hz sine, stereo, level for the target LUFS); the LRA and music ones need the official files. The Rust crate's tests do build 440 Hz sine data (`ec_ebur128.rs` `step = 2*pi*440/48000`) and has a `reference-tests` feature using the EBU files. | [U] for the EBU set contents; **[V]** that the crate synthesises sines and has `reference-tests` (`Cargo.toml`, `ebur128.rs:1055+`) |
| Game targets | Sony ASWG-R001: -24 LUFS integrated (±2 LU), measured over a long play segment, with a true-peak ceiling -1 dBTP [U]. Mobile/handheld portable target about -18 LUFS (Sony/Apple commonly cited) [U]. Xbox: -23 to -20 LUFS dialogue-anchored guidance; Nintendo has no public figure to my knowledge [U]. R128 broadcast: -23 LUFS ±0.5, max -1 dBTP [U]. | [U] all |

### Where the tools put meters

| Tool | Behaviour | Mark | Source |
|---|---|---|---|
| FMOD | **Loudness Meter is an effect (a DSP) placed on any channel group/bus**. Its state: `STATE` param with values RESET_INTEGRATED(-3), RESET_MAXPEAK(-2), RESET_ALL(-1), PAUSED(0), ANALYZING(1). Info struct: momentary, short-term, integrated, **10th and 95th percentile loudness** (LRA inputs), a **66-sample loudness histogram**, `maxtruepeak`, `maxmomentaryloudness`. A per-channel weighting table (32 floats). So it is integrated over a session that you reset, can be paused, and is queried by polling the effect. | **[V]** | `fmod_dsp_effects.h:47,409-443` |
| Wwise | Loudness Meter in the Authoring tool's **Loudness Meter view** and the Meter effect plug-in (`AkMeter`) on a bus with game-side RTPC output (below). The Authoring view meters the **selected bus/object** (Mixing Desk strip or Master), with Integrated reset button, and can **analyze an offline sound file/bank for normalisation** ("Loudness Normalization" property in the Sound Settings, target LKFS). | [U] | memory |
| Unity | No loudness meter in the Audio Mixer (group level meters are RMS/peak dB); LUFS needs the Unity Recorder or a package. | [U] | memory |
| Unreal | Audio Insights meters (RMS/peak) and "Submix Loudness" via the `LoudnessAnalyzer` / `Synesthesia` plug-ins (Loudness submix analysis + `AudioAnalyzer`). | [U] | memory |

**Adopt.** FMOD's shape: a meter attached to chosen buses, with state RESET/PAUSE/RUN, and an info record of M, S, I, LRA percentiles, histogram, max true peak. This matches the goal's "master plus buses the project picks". Add Wwise's "target LKFS" idea as a **project target with warning, no auto-gain**. **Differ.** Meter output flows through STATUS (not polled DSP params), the integrated measure stays reset by a command (and by session start), and true peak ceiling and target are project data.

## 3. Open-source implementations

| Candidate | Licence | Facts | Mark | Source |
|---|---|---|---|---|
| libebur128 (C) | MIT (c) 2011 Jan Kokemüller | Full M/S/I/LRA, sample and true peak, any rate (recomputes filter), histogram or block list. **Allocates in init** (`malloc` for state, 400 ms or 3 s `audio_data` in `double`, interpolator, resampler buffers), no allocation in `add_frames` for fixed channels except the history queue when not histogram mode. Not SIMD (compiler only). No allocation in `add_frames` is [U] (not traced). | **[V]** | `libebur128.c:413-540`; `COPYING` |
| Rust `ebur128` crate 0.1.11 (sdroege) | MIT; Cargo.toml `license = "MIT"`; copyright Kokemüller 2011 + Dröge 2020; rust-version 1.60 | Port of libebur128, same filter and tables. **Not `no_std`** (`use std::error`, `std::fmt`, `Vec`, `VecDeque`, `Box<[f64;1000]>`, `SmallVec<[_;16]>` for channel pointer lists). Deps: bitflags, smallvec, dasp_sample, dasp_frame. Allocates at construction (`audio_data: Box<[f64]>`, `true_peak`, history `VecDeque`/`Box` histogram); `add_frames` iterates in place, with channel-count-specialised interpolators (mono/stereo/quad const generics) and a rolling buffer; no `unsafe` SIMD intrinsics, relies on autovectorisation. | **[V]** | `Cargo.toml`; `ebur128.rs:27-28,224,265-318,816-826`; `history.rs:24,52-58,160-163`; `true_peak.rs:45-70`; `interp.rs:24-70`; `index.crates.io/eb/ur/ebur128` (0.1.9 and 0.1.11 listed) |
| `bs1770` crates, `loudness`, `ebur128-stream`, etc. | various | Older or thin; not read. | [U] | memory |

**Port assessment (what I conclude, from the V code).** Porting is straightforward and licence-clean: write a small `no_std` crate (`audio-loudness`) containing (1) the two biquads with the V formulas in `f64` (state in `f64` because the 38 Hz high-pass is ill-conditioned in `f32`; both libs use `double`), (2) a 400 ms block energy accumulator as a 4-slice ring (4 x 100 ms partial sums, no 400 ms sample buffer needed, so no per-call allocation; the libs buffer audio only to simplify), (3) the **1000-bin histogram** (`[u32;1000]`, plain array; the lib's `histogram_bins.rs` tables are computed by `pow` and can be generated at build/init), (4) a 3 s short-term ring of 30 partial sums, (5) 4x 48-tap (or 49) polyphase true peak with a `const` coefficient table. Per-bus state is fixed size, so metered buses can live in a pre-sized array in the core. The crates' MIT notices must be kept in the ported file. Their reference tests (EBU sets) become the acceptance test.
Costs to measure (S-spike): 2 biquads per channel per metered bus (cheap), 4x polyphase FIR (48 taps x 4 phases per input sample per channel is the dominant cost, about 12 MACs per input sample per phase set; est. 12 MAC/sample/channel after polyphase decomposition: 48 taps/4 phases), histogram only every 100 ms.

## 4. Live mixing

| Tool | Live behaviour | Persistence after stop | Mark | Source |
|---|---|---|---|---|
| Wwise | **Live Editing** while connected to the game: property changes (volumes, RTPC curves, effects) are applied to the running sound engine (Authoring sends it as "set property" and "update" commands). **Mixing Desk** is a live view of buses with mute/solo/volume and meters; **Soundcaster** triggers events/states/RTPC without a game. **Mixing Desk Snapshots (Soundcaster/Mixing Desk "Mixing Session")** and states. Edits are changes to project work units, saved when you save the project (and undoable); the game receives them live. | The project is the source of truth, so edits are kept (it is the authoring tool, not a runtime). | [U] | memory |
| FMOD Studio | **Live Update** (connect to the game): edits to events, buses, snapshots and mixer properties in Studio are sent live to the game; you can audition and the mixer shows the same state. The mixer **Snapshots** have an "intensity" and can be triggered live from Studio's Event Browser/ Mixer. Edits are project data; saving the project keeps them; the game reloads banks on a build. | kept in project, on save | [U] | memory |
| Unity Audio Mixer | **"Edit in Play Mode"** toggle in the Audio Mixer window (shown only while the player is playing). Tooltip text: *"Edit in playmode and your changes are automatically saved. Note when editing is disabled, live values are shown."* Backed by `AudioSettings.editingInPlaymode`; the window disables editing unless `AudioMixerController.EditingTargetSnapshot()`. So: **edits made with the toggle on are kept**; with it off the UI shows live values and edits do not apply to the asset. | **[V]** (tooltip is the primary source for "automatically saved") | `AudioMixerWindow.cs:118,428-435,634` |
| Unity (exposed parameters) | `AudioMixer.SetFloat` from script changes a live value and does not write the asset | [U] | memory |
| Unreal | Audio mixer / Submix and **Audio Modulation** (Control Buses, Mixes, Generators): edits to modulation assets while the game runs in PIE update live through the modulation system's asset-reload path; PIE session changes to assets in the editor **are kept** if the asset is edited in the editor (assets, not instances); changes to a *PIE world copy* are lost. Console `au.` commands change the runtime state and are lost. | assets kept; PIE instances lost | [U] | memory |

**Adopt.** All four converge on: mix = project data, edited live, kept (goal item 4). Unity shows the risk: a toggle with two modes (edit asset vs view live values), and a window state that can mislead (`AudioMixerWindow.cs:118`). **Differ.** Myco has no toggle: during Play the bus controls always edit `project.json`'s `audio` section through the existing undoable edit command, and the editor pushes the change to the running mixer (`mixer.configure` is applied incrementally); live values (meters) are shown next to controls, not in place of them. Snapshots edited live use the same path.

## 5. Sidechain and signal-driven ducking

| Tool | Behaviour | Mark | Source |
|---|---|---|---|
| Wwise | Two models: (a) **Auto-ducking** on a bus: ducks other buses by voice **presence** in a source bus (volume in dB, fade-out/fade-in times, curve shape, max duck volume), i.e. like Myco's current any-voice rule; (b) **Meter effect** on a bus emits the metered level (peak or RMS, with attack/release, min/max range, scope) to a **game parameter (RTPC)**, which any property can map through a curve, so ducking by actual level is "Meter -> RTPC -> volume curve" on another bus. Defaults: Meter attack/release about 0 ms/ 100-ish ms [U], Peak mode. Look-ahead is not offered on Meter (the RTPC applies after the audio block). | [U] | memory |
| FMOD | Core **compressor has `USESIDECHAIN`** and a separate **Send/Return**; the **Envelope Follower** has `ATTACK`, `RELEASE`, `ENVELOPE` (readable) and `USESIDECHAIN`. Studio exposes a **Sidechain Modulator** (reads a sidechain/ envelope into a parameter) and a **sidechain input** on the compressor: you add a Send to the trigger bus and a Sidechain effect on the target. Parameters exist; defaults (compressor attack 50 ms / release 5000 ms in the Core defaults [U], envelope follower attack 20 / release 100 ms [U]). Detector type is peak for the Core compressor [U]. | params **[V]**, defaults [U] | `fmod_dsp_effects.h:222-229,448-452` |
| Unity | **Duck Volume** effect on the *target* group: receives a **Send** from the trigger group; parameters Threshold (-10 dB default), Ratio (2.00), Attack (100 ms), Release (200 ms), Make-up gain; this is a compressor with side input (RMS-ish detector, no look-ahead). The channel-strip UI treats `Send`, `Receive`, and `DuckVolume` specially and allows sidechain targets. | UI hooks **[V]**, defaults [U] | `AudioMixerChannelStripView.cs:324,347,500,976` |
| Godot | Compressor effect with a **`sidechain` bus name**: if set, the detector reads that bus's **current mix buffer** (so the sidechain bus must be mixed earlier, order-dependent), takes `max(|L|,|R|)` (**peak, per sample**), `overdb = 2.0814 * dB(peak/threshold)`, attack coefficient in **microseconds** (`attack_us`), release in ms, with a program-dependent average-ratio logic; no look-ahead; wet/dry `mix`. | **[V]** | `audio_effect_compressor.cpp:36-70,110-113`, `audio_effect_compressor.h:42-59` |
| Unreal | **Submix envelope follower**: a Submix can broadcast an envelope (`bEnableEnvelopeFollower`, attack/release ms) to Blueprint delegates; ducking with **Submix Effect Dynamics Processor with an external (key) submix input** or **Audio Modulation** (an Envelope Follower is not itself a modulator but the Control Bus / Generator system drives gain). Detector options peak or RMS, plus a look-ahead on the Dynamics Processor [U]. | [U] | memory |

**Adopt.** Level-driven ducking with a detector (Godot-style peak or Wwise Meter peak/RMS), attack/release in ms, depth in dB, ratio/range and optional lookahead as a core feature of a duck rule; the trigger is a bus (not a send) so authoring is "duck this bus by that bus". **Differ.** Keep the existing voice-presence rule as a mode (Wwise auto-ducking style), add a metered mode that runs in the core with the sidechain bus mixed first (the order constraint Godot has: sources must be rendered before targets, and our bus graph is already topologically ordered, so a target must not be an ancestor of its trigger or the duck sees a one-quantum delay). Provide a documented lookahead (the master limiter already has one).

## 6. Sample-accurate bus automation

| Tool | Behaviour | Mark | Source |
|---|---|---|---|
| FMOD Core | `ChannelGroup::addFadePoint(dspclock, volume)` and `setFadePointRamp(dspclock, volume)` take an **absolute DSP clock in samples**, so fade ramps are specified to the sample; whether the mixer interpolates per sample or per block inside the block is not in the header [U] (I believe it is linear per sample between points). | API **[V]**, interpolation [U] | `fmod.h:277-281,398-402` |
| FMOD Studio | Parameter and snapshot changes are smoothed by a **parameter `seek speed`** and snapshot `fade in/out` times; applied at Studio update (per buffer or per `update()` call) [U]. | [U] | memory |
| Wwise | Bus/object volumes fade using **transition times** on RTPC/state/event actions; the sound engine applies parameter volumes via linear gain ramps **per audio frame (buffer, default 1024 samples), interpolated within the frame from previous to current gain** [U]. State changes ("State transition time") are a time-based interpolation advanced each audio frame [U]. | [U] | memory |
| Godot | Bus volume is **constant across the buffer**: `volume = db_to_linear(bus->volume_db)` and `buf[j] *= volume` (no ramp); the code ramps only the channel/stream volumes between mixes (`prev_channel_volume`, lerp over the buffer) and `AudioStreamPlayback` fade-outs. So Godot bus volume changes step at buffer boundaries. | **[V]** | `audio_server.cpp:403-421,266,478-479` |
| Unity | Mixer snapshot transitions (`TransitionToSnapshots`) interpolate over time on the audio thread [U]; exposed-parameter `SetFloat` applied at the next mix block [U]. | [U] | memory |

**Adopt.** Core-side ramps with times expressed in frames: a target gain + duration (or a DSP-clock anchor like FMOD's fade points) sent once, interpolated **per sample** (or per 32-frame sub-block, if cost demands) in the core; snapshot blend as a per-bus parameter set with one shared ramp. **Differ.** Myco already stamps commands with `at` frames (M3), so a fade starts at an exact frame, not at the next 128-frame block, which is better than Godot (step per buffer) and Wwise (frame-granular, [U]).

---

## Recommendation summary (adopt / differ)

| Piece | Adopt | Differ |
|---|---|---|
| Profiler | stream of timestamped snapshots, timeline cursor, reason codes on voices, FMOD's "same data is a poll API" | one file == one wire format; capture off in release unless asked; no per-effect CPU timer in a worklet; live link deferred |
| Loudness | FMOD meter-on-a-bus + RESET/PAUSE/RUN + info record; libebur128 algorithm (MIT) | own no_std port with fixed state (4x100 ms partial sums, 1000-bin histogram); project target warns, never adjusts |
| Live mix | project data, edit live, keep | no "edit in play" toggle; always edits `project.json`, undoable |
| Ducking | level-driven detector, attack/release ms, depth dB | keep voice-presence mode too; trigger is a bus; ordered graph |
| Bus fades | FMOD-style absolute-clock fades | per-sample ramp inside core, `at`-stamped |

## Unverified list (decision impact first)

1. Wwise and FMOD Studio profiler data, capture formats, rates (all of section 1 except FMOD Core API): needs audiokinetic.com and fmod.com.
2. Wwise Meter/auto-ducking defaults, FMOD sidechain defaults, Unreal envelope follower and Dynamics Processor options.
3. Game loudness targets (Sony ASWG-R001, Xbox, Nintendo, mobile -18): need the documents.
4. EBU Tech 3341/3342 test-set contents, LRA relative gate of -20 LU, BS.1770 channel weights, BS.1770-5 changes.
5. Unity Audio Profiler module internals (`AudioProfilerModule.cs` path unknown), Unreal Audio Insights.
6. Whether FMOD/Wwise ramp per sample or per buffer inside the mixer.

## Reproduce

`./fetch.sh` re-downloads the sources. `node kweight.mjs 48000 44100` prints the K-weighting biquads.

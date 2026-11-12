# 0171. Audio M5: a profiler built on one recorded stream, loudness metering on chosen buses, live mixing that edits the project, and the mix's timing moved into the core

- **Status:** Accepted (2026-11-12; "RFC round (revision 2)" and "Owner decisions (accepted)" at the end win over the text above them)
- **Date:** 2026-11-12
- **Deciders:** Chris Carlson
- **Supersedes:** — (amends 0157's roadmap item M5, 0097's ducking rules and 0158's mixer timing)
- **Related:** 0097, 0098, 0147, 0155, 0157, 0158, 0162, 0166, 0167, 0169, 0170

## Glossary

**Loudness**
- **dBFS:** decibels relative to the loudest value a sample can hold (0 dBFS). Negative numbers are quieter.
- **Sample peak:** the largest sample value in a stretch of audio, what today's bus meters show.
- **True peak (dBTP):** the highest level the signal reaches *between* samples once it is turned back into a smooth wave (by a speaker or a converter). It can be up to about 3 dB above the sample peak. It is measured by oversampling: computing extra points between the samples.
- **LUFS:** Loudness Units relative to Full Scale. A measure of how loud audio *sounds* to people, not how high its peaks are. 1 LU is 1 dB of loudness. Defined by ITU-R BS.1770 and EBU R128.
- **K-weighting:** the filter BS.1770 applies before measuring, which models the ear: it cuts the deep bass and lifts the upper mids.
- **Momentary, short-term, integrated:** loudness over the last 0.4 s, the last 3 s, and the whole session so far. Integrated loudness is the one platform targets are written in.
- **Gating:** integrated loudness ignores silence (below -70 LUFS) and quiet passages (10 LU below the running level), so pauses don't drag the number down.
- **Loudness range (LRA):** how much the loudness varies over time, in LU: a cinematic game has a wide range, a mobile puzzle game a narrow one.
- **Loudness target:** the integrated loudness and true-peak ceiling a platform or publisher asks for, for example about -24 LUFS on console and PC and about -18 LUFS on mobile (published game-audio guidance; the figures are unverified here).

**Mixing**
- **Bus:** a channel that sounds are routed into and mixed together; buses form a tree ending at Master.
- **Snapshot:** a named mix (a set of bus volumes and filter cutoffs) the mixer fades to, for example "Paused".
- **Ducking:** turning one bus down while another plays, for example music under dialogue.
- **Sidechain:** using one signal's level to control a different signal's processing. **Sidechain ducking** turns the music down by how loud the dialogue actually is.
- **Envelope follower (detector):** the small process that tracks a signal's level over time. **Attack** is how fast it reacts to a rise, **release** how fast it lets go. **Peak** detection follows the highest samples; **RMS** follows average power.
- **Live mixing:** changing the mix while the game runs and hearing the change straight away.
- **Crossfade:** fading the old sound out while the new one fades in, so a change doesn't click.

**The audio engine**
- **Quantum:** the core's processing block, 128 frames (2.7 ms at 48 kHz).
- **Stamped ramp:** a change of level that the core starts at an exact frame number, sample-accurate, instead of when the message happens to arrive.
- **STATUS:** the block of numbers the audio core sends back to the main thread every 6 quanta (16 ms): counters, levels, playheads.
- **Work unit:** the core's internal measure of how much processing each voice, bus and effect needs.
- **`loadPermille`:** the share of each quantum the audio thread spends working, in thousandths. Today it is always 0 (never measured).
- **Underrun:** the audio thread didn't finish a quantum in time, which is heard as a click or gap.
- **Shedding ladder:** the core's last-resort steps for cutting work when underruns continue (ADR 0162), given back after 20 s of calm (ADR 0170).

**The profiler**
- **Profiler:** a tool that records what the audio engine does over time and shows it as a timeline you can pause and scrub, like a video.
- **Capture:** a recording of that timeline saved to a file.
- **Keyframe:** a full snapshot of the state (every voice) recorded once a second, so the profiler can jump to any moment without replaying from the start.
- **Ring buffer:** fixed memory that keeps the newest recording and overwrites the oldest, so recording never runs out of space.
- **Cross-origin isolation (COOP/COEP):** two HTTP headers that unlock precise shared-memory timers in browsers. No host in this repo sends them.

## Context

**The goal (owner, 2026-11-12, [goal.md](../design/0171-audio-mix/goal.md)).** ADR 0157's roadmap: "**M5: profiler and live mix.** A voice and CPU view built on the status channel, LUFS metering, and live mix editing in play mode on web and desktop." The owner put all four pieces in scope:
- a **profiler** with **capture files**, which exported games (web, desktop, Android) can record;
- **loudness metering** on master and the buses the project picks, with **project targets** that warn and never adjust gain;
- **live mixing** in play mode, whose edits **are kept after Stop** as undoable edits to `project.json`;
- a **signal-driven mix**: sidechain ducking and sample-accurate bus fades and snapshots.

Reach: the editor's play mode plus capture files. A live link from the editor to a running export is on the roadmap, not in M5. M5 gets its own audio-thread budget. The Babylon fallback is best effort. Only the samples use the engine, so there's no compatibility work.

**What exists (read from code; the goal's table has the citations).**
- The **debug panel** reads `Audio.debug()` every 250 ms: a snapshot with no history (`src/plugins/audio/editor/AudioDebugPanel.tsx:15-21`).
- **Bus meters** are sample peak only, for the first 32 buses (`native/audio/crates/audio-core/src/meters.rs`). There's no LUFS and no true peak.
- **`loadPermille`** exists in STATUS and is always 0 (`audio-core/src/counters.rs:424-425`). Work units, underruns, late commands and minimum slack are counted.
- **The mixer reads `project.json` once,** at engine start (`src/engine/core/Engine.ts:184-187`). Bus, snapshot and ducking edits made during Play never reach it. M3 made zone, occluder and AudioSource fields live.
- **Fades, snapshots and ducking advance on main** once per frame (`src/engine/audio/mixer.ts:183-215`) and go to the core as BUS_MIX ramps one frame long, 5–50 ms (`src/plugins/audio/runtime/core/lookahead.ts:33-37`). The heard gain trails the intended curve by 18 ms at 60 fps and 35 ms at 30 fps.
- **Ducking** acts while the trigger bus has *any* voice, however quiet (`mixer.ts:203-208`).
- **Scripts and the mix share one value.** `Bus.volume` sets the same number the project authors (`mixer.ts:49-50`), so the authored mix and a script's change can't be told apart.
- **No editor↔game link exists.** Exports can open outgoing WebSockets; neither editor can listen.
- **Budget:** high is already over 1.3 ms p99.9 on the lab VM after M3; M4's allowance was 30–43 µs typical, 68 µs worst (est.). The wasm mixer is 318,306 B against a 320 KB tripwire.

**How others do it** ([spikes/audio-mix/research](../../spikes/audio-mix/research/README.md); [V] verified from a primary source, [U] not).
- **FMOD Core** exposes profiler data to the game itself: CPU by category (dsp, stream, geometry, update, convolution), real and virtual channel counts, per-DSP peak and RMS meters [V].
- **FMOD's Loudness Meter is an effect placed on any bus**, with reset, pause and analyse states, and it reports momentary, short-term, integrated, percentiles, a histogram and maximum true peak [V]. Wwise meters the bus you select [U].
- **Unity's mixer keeps play-mode edits** while "Edit in Play Mode" is on [V]. Wwise, FMOD and Unreal treat the mix as project data changed live [U].
- **Godot's** compressor sidechain reads the trigger bus within the same mix pass, so bus order matters [V]. FMOD has a compressor sidechain and an envelope follower [V]. Wwise's auto-ducking is presence-based, with a Meter effect for level-based ducking [U].
- Profilers record a **timestamped stream** to a socket or a file and scrub it with a cursor [U for Wwise, FMOD Studio, Unity, Unreal].

**Measured ([spikes/audio-mix/README.md](../../spikes/audio-mix/README.md); container wasm p50 / p99, idle machine, only p50 and p99 trustworthy).**
- **Loudness, our own code:** 189 of 189 checks pass (-23 dBFS 1 kHz reads -22.99 LUFS). Master with full true peak costs 2.2 / 3.1 µs per quantum. 8 buses with true peak gated to loud quanta cost 10.3 / 24.7 µs, and 8 with full true peak 20.7 / 45.0. State is 1,512 B per bus, with no allocation. It adds about 21 KB of wasm (est.).
- **The `ebur128` crate** gives the same answers but spikes every 100 ms: native p99.9 1.9 ms for 8 buses. It allocates 2.39 MB per bus, needs std and adds 85.8 KB.
- **CPU in the worklet:** no `performance`; `Date.now` is whole milliseconds; no COOP/COEP anywhere. Summing `Date.now()` around `process()` is unbiased (≤ 3.6 permille), within 7–15 permille at a 256 ms window, and costs 0.19 µs per quantum. Per-section shares come from work units refitted live (the build constant was 2× off).
- **Capture** (synthetic scenes, est.): 0.51 / 1.59 / 5.04 MB per minute in memory at 64 / 256 / 1,024 voices, and **0.08 / 0.15 / 0.25 MB per minute saved**, compressed. Recording one STATUS costs 0.6–3.2 µs. Opening a 10-minute capture takes 0.24–0.83 s, and jumping to any moment 0.2–0.7 ms p50. The encoder still allocates ≈ 370 B per block.
- **Sidechain:** one rule costs 0.6 / 0.7 µs, 8 rules 5.0 / 11.4 µs. The default "Voice ducks Music" reads its trigger a quantum late in today's bus order. Sorting triggers first fixes every rule in the samples.
- **Stamped bus ramps** are exact (5e-8) and cheaper than today's: 0.48 µs for 8 buses against 1.27.
- **Live edits** all apply in place with no core rebuild. Volume, filter, send-level and append edits are clean. A compressor-threshold step clicks unless smoothed over ≥ 20 ms. Slot-shifting, re-parenting, mid-tree inserts and removing the last send click unless crossfaded.

## Decision (proposed)

> **Revision 2 (after the RFC round, at the end of this record) changes parts of this section. Where the two differ, revision 2 wins.**

### 1. One recorded stream: the profiler, captures and a later live link are the same data

- **The profile stream** is binary records with timestamps on the audio clock:
  - every **STATUS block** as the core sends it;
  - **main-side events** with reason codes: a voice started, stopped, stolen (with the voice that took it), virtualised or made real (with why), refused, or queued; an event instance started or stopped; a parameter, snapshot or state change; a music transition; a mix edit;
  - a **keyframe** each second: the full voice table, buses and event instances.
- **Recording is a preallocated ring** that allocates nothing per block (a requirement: the spike's encoder doesn't meet it yet). It runs whenever the profiler panel is open in Play, or when a game starts a capture.
- **A capture file is the stream saved,** compressed with deflate-raw (`CompressionStream`) at save time. Its header carries a magic, a format version, the wire schema hash, sample rate, quantum, STATUS cadence, preset and a name table. **A capture from a different wire is refused with a message,** never misread.
- **The future live link** sends the same records over a socket. M5 doesn't build the link (goal: roadmap), but the stream's format is chosen so the link is a transport, not a redesign.

### 2. The audio-thread CPU figure is measured everywhere, with no new headers

- **`loadPermille`** = the sum of `Date.now()` deltas around each `process()` over a window of 96 quanta (256 ms), filled into the existing STATUS field. The profiler labels it a 256 ms average.
- **Per-section shares** (voices, buses and effects, spatial, music, loudness) come from the core's work units, with the conversion refitted live against the measured total. They are drawn as shares of the measured figure, not as separate timings.
- **The Babylon fallback** has no core: its CPU line is absent and the profiler says why.
- Cross-origin isolation (which would allow a per-quantum timer) is a separate decision, not M5's.

### 3. The profiler (editor)

- **A Profiler panel** in the audio plugin's editor half, replacing the debug panel's role as the place to investigate (the debug panel stays as the "now" view):
  - **tracks:** CPU (`loadPermille` with section shares), voices (playing, virtual, stolen, refused counts), underruns and late commands, the shedding ladder and voice cap, bus levels and loudness, event instances, music state and transitions;
  - **a cursor** that pauses, scrubs and steps; at the cursor, the voice table and bus states as they were, with each voice's reason (why it is virtual, who stole it);
  - **record, stop and save**, and opening a capture file (from a game or saved earlier).
- **Profiling costs main ≤ 1 ms per second at 1,024 voices** and never allocates per block.

### 4. Loudness metering on master and chosen buses

- **A loudness meter is a bus property:** `loudness: true` on a bus in `project.json`. **Master is always metered.** At most 8 buses are metered at once (validation refuses more).
- **Split:**
  - the **audio thread** runs K-weighting, 100 ms sub-block energies and 4× true peak;
  - **main** computes momentary, short-term, gated integrated loudness and LRA from 28 bytes per metered bus per STATUS block.
- **True peak runs always on master,** and on other metered buses only in quanta whose sample peak is at or above -6 dBFS (exact on the music test; the core already has the sample peak).
- **Our own small module in the core** (`audio-dsp`), with libebur128's formulas and its MIT notice. No `ebur128` crate, for its spikes and allocation.
- **State and readings follow FMOD's meter:** analyse, pause, and reset integrated or max peak; readings are momentary, short-term, integrated, LRA, max true peak and max momentary.
- **A project loudness target,** `audio.loudness`: an integrated target in LUFS, a tolerance in LU and a true-peak ceiling in dBTP. The meters show off-target readings and the profiler marks them. **Nothing adjusts gain.**
- **Scripts read loudness** through `Bus` (for example `Audio.bus("Master").loudness.integrated`) and can reset it, so a test build can log a session's loudness.

### 5. Live mixing in play mode

- **Every mix edit made in the editor during Play applies to the running game and is kept.** Edits in Project Settings > Audio and in a new **Mixer panel** (faders, mute, solo, meters, loudness, snapshot buttons) are ordinary undoable edits to `project.json`'s `audio` section, and are pushed to the running mixer at once.
- **Authored values and runtime changes are kept apart.** The project's value is the base. A script's `Bus.volume`, `fadeTo`, snapshots, ducking and parameter automation act on top of it, as multipliers, and are never written back. Today both write one number (`mixer.ts:49-50`); M5 separates them.
- **Index-stable routing in the core:** during Play, buses and effect slots keep their indices. New ones are appended, and removed ones are emptied until Stop. The core's BUS_CONFIG is applied as a difference, not a rebuild.
- **Edit classes,** from S4's measurements:
  - **direct:** volume, mute, solo (ramped), filter parameters, send levels, appended effects and buses;
  - **smoothed in the core** over ≥ 20 ms: compressor parameters and other parameters a step would click;
  - **crossfaded** between old and new routing (≈ 20–50 ms, the design fixes it): re-parenting a bus, reordering or removing effects, removing a send, moving a sound to another bus.

### 6. The mix's timing moves into the core

- **Stamped bus and master ramps:** fades, snapshot transitions and parameter-driven bus automation become ramps the core starts at an exact frame, as M4-0 did for voices. Main still decides what and when. This removes today's 18–38 ms lag and costs less than the current ramps.
- **Sidechain ducking in the core:**
  - a ducking rule gets a **`mode`**: `level` (the trigger bus's measured level, with a peak or RMS detector, threshold, amount, attack and release) or `presence` (today's behaviour, any voice playing, kept as a feature as Wwise's auto-ducking is);
  - the detector runs per sample and the gain computer once per quantum, interpolated per sample;
  - **the bus order puts each trigger before its target** (edges added to the core's sort at BUS_CONFIG); a trigger that is the target's ancestor is a cycle and validation refuses it.
- **Effect-parameter snapshots blend per quantum** (filter cutoff, compressor), click-free per S4.

### 7. Captures in exported games

- **`Audio.capture.start()`, `.stop()` and `.save(name?)`** let a game record. The recorder is a separate module loaded only when a capture starts, so a game that never captures ships no recorder code and pays nothing.
- **An export option** (`--audio-capture`, and its Export dialog checkbox) adds a built-in trigger, a key combination on desktop and web and a gesture on touch, for test builds without script changes.
- **Saving:**
  - **web:** a file download;
  - **desktop and Android:** the app's data folder through `Storage` (ADR 0024), which the Tauri capability already allows;
  - **getting a file off Android:** owner decision 3.
- **The editor opens a capture** from File > Open or by dropping the file on the Profiler panel.

### 8. Budgets

**Audio thread, per quantum, proposed** (container wasm p50 / p99 with ≥ 50% headroom; the reference factor isn't applied):

| | Typical | Worst |
|---|---|---|
| Loudness (master + 3 gated / master + 7 full) | 0.01 ms | 0.07 ms |
| Sidechain (2 / 8 rules) | 0.002 ms | 0.02 ms |
| Stamped ramps | a saving | a saving |
| CPU clock | 0.001 ms | 0.001 ms |
| **M5 on high** | **0.015 ms** | **0.09 ms** |
| default / low (est.) | 0.015 / 0.005 ms | 0.05 / 0.01 ms |

- **Main:** recording ≤ 1 ms per second at 1,024 voices, with no allocation per block; loudness statistics ≤ 50 µs per second (est.).
- **Memory:** a capture ring of about 4 / 16 / 32 MB on low / default / high (est.); 1.5 KB of core state and a 24 kB histogram per metered bus.
- **Size:** the mixer grows by ≈ 21 KB and passes the 320 KB tripwire. The build log records why, as the owner's rule asks.

### 9. The Babylon fallback (best effort)

- **Live mixing:** applies (volumes, mutes, filters).
- **Profiler:** shows the main-side events and keyframes. There's no CPU line.
- **Loudness and level-mode ducking:** not available; the meters and Mixer panel say so. Presence-mode ducking works as today.
- **Ramps:** stamped through `AudioParam` automation where Babylon exposes it [U].

### 10. Wire and milestones

- **The wire:**
  - STATUS gains loudness sub-blocks, section work units and the event-log hooks;
  - BUS_CONFIG becomes a stable-index difference;
  - stamped bus ramps and sidechain rules join the commands.

  It's an ABI bump; the technical design owns the format.
- **Milestones (provisional):**
  - **M5-0**, the core's mix timing: stamped bus ramps, index-stable BUS_CONFIG, the trigger-first bus sort and parameter smoothing. They must stay bit-identical for unstamped work, as M4-0 did.
  - **M5a**, the stream and the profiler: the recorder, the CPU figure, the Profiler panel.
  - **M5b**, loudness: the core module, statistics, meters, targets.
  - **M5c**, live mixing and sidechain: authored vs runtime values, the Mixer panel, the edit classes, level-mode ducking.
  - **M5d**, captures in exports, the samples, guides and the listening pass.

## Alternatives considered

- **The `ebur128` crate for loudness.** Same answers and an MIT licence, but 100 ms spikes up to ~2 ms for 8 buses, 2.39 MB allocated per bus, std-only, and 4× the wasm. Its formulas are what we port.
- **Loudness on every bus.** Simplest for users, but each bus costs audio-thread time, and FMOD and Wwise both meter chosen buses. Master plus up to 8 covers mixing practice.
- **Loudness entirely on main from bus peaks.** Impossible: LUFS needs the filtered signal, not peaks.
- **A per-quantum CPU timer through SharedArrayBuffer.** More precise, but it needs COOP/COEP headers on every host (none send them, and they constrain what pages may embed) and a spinning Worker that occupies a whole CPU core.
- **A work-unit model alone for CPU.** No timer needed, but the fixed constant was 2× off and it can't see contention or a slow device. It's used only for the section split.
- **JSON captures.** Readable, but 6–30× the size, 3–8× the recording time, and allocating per block.
- **A live editor↔game link in M5.** It gives mixing on the device, but needs a socket listener in the desktop editor (a new Rust dependency), a relay for the web editor, debug-only switches, pairing, and HTTPS and Android cleartext rules: an estimated +6–10 person-weeks. Deferred to the roadmap (owner); captures cover device-only problems.
- **Revert play-mode edits on Stop (Unity's default without the toggle).** Safer, but it loses mixing sessions; the owner chose keep.
- **Keep ducking on main and only shorten its ramps.** Cheaper, but it still can't hear the signal: sidechain needs the audio.
- **Drop presence-mode ducking.** Simpler, but it is a real feature (Wwise's auto-ducking) that needs no tuning, and the samples use it.

## Consequences

**Positive**
- Sound designers can see why the game sounds as it does: voice reasons, CPU, underruns, the shedding ladder, loudness, over time, with a scrubbable history.
- A game on a device can record a capture that the editor opens, the case F-37's start-up clicks needed.
- The mix can be measured against platform targets and tuned while the game runs, and the work is kept.
- Ducking reacts to what is heard, and fades and snapshots land on time instead of 18–38 ms late.
- `loadPermille` finally reads a real number, in every host.
- The stream format leaves the live device link as a transport to add later.

**Negative / costs**
- **The mixer grows ≈ 21 KB** past its 320 KB tripwire (recorded, not a design limit).
- **An ABI bump** and re-recorded goldens for stamped bus ramps: M5-0 has to prove unstamped work stays bit-identical.
- **Two volumes per bus** (authored and runtime) change `Bus`'s meaning for scripts. The samples are updated; there are no outside users.
- **The editor UI is the largest part** (profiler timeline, Mixer panel), as 0157 predicted for authoring.
- **Getting captures off Android release builds** needs either a plugin or a limitation (owner decision 3).
- **Unverified:** real devices, Firefox and WebKit worklet clocks, the game loudness targets, true peak against BS.1770's own filter table, capture sizes on real scenes.
- **Estimate (provisional; the technical design's task table sets the real one):** revision 2 raises it to ≈ **62–75 person-weeks** (≈ 70 central); the first draft said 50–65. Calibrated from the last two milestones: M3's features grew ×1.67 into its task table and M4's provisional 45–55 person-weeks became 69.7. The features below sum to ≈ 31 person-weeks; tests, goldens, benches, e2e and tooling add ≈ 40% (≈ 12.5), and a reserve of a quarter to a third of the total sits on top.

  | Feature | Person-weeks (est.) |
  |---|---|
  | M5-0: stamped bus ramps, index-stable BUS_CONFIG, trigger-first sort, parameter smoothing | 4 |
  | The stream: recorder ring, binary codec, keyframes, file format, STATUS additions | 4 |
  | CPU figure and section shares | 1 |
  | Profiler panel (timeline, cursor, voice reasons, open and save) | 7 |
  | Loudness: core module, statistics, meters, targets, `Bus.loudness` | 4 |
  | Live mixing: authored vs runtime values, Mixer panel, edit classes, crossfades | 6 |
  | Sidechain ducking (core, format, editor) | 2 |
  | Captures in exports (API, export option, saving per platform) | 1.5 |
  | Babylon fallback rows, samples, guides | 1.5 |
  | **Features** | **31** |

## Deprecates

- **The per-frame main-thread ramps** for bus fades, snapshots and ducking (`mixer.ts:183-215` sending BUS_MIX ramps one frame long): replaced by stamped ramps in the core. Main keeps the decisions.
- **`Bus.volume` as the authored value:** it becomes a runtime multiplier on top of the authored volume.
- **Rebuilding bus routing from scratch** on every BUS_CONFIG: replaced by stable-index differences.
- **`loadPermille` reserved as 0** (0157 §4.7): filled.

## Open questions

1. **Recording trigger in exports** (owner): an API only, or the export option's key combination and gesture as well, as proposed.
2. **Capture policy in release exports** (owner): never (debug builds only), opt-in per project, or always available through the API, as proposed.
3. **Getting a capture off Android** (owner): adb on debug builds only, or a share-sheet plugin (a new dependency, its own record) so release builds can share a file.
4. **Default loudness target** (owner): -24 LUFS integrated ±2 LU and -1 dBTP (console and PC guidance), with mobile projects changing it; or no default until the project sets one.
5. **The Mixer panel's scope** (owner): faders, meters and snapshots only, or also effect editing inside the panel (as Wwise's Mixing Desk), which costs more UI.
6. **Default ducking mode for new rules** (owner): `level` (recommended, what users expect from "ducking") or `presence`.
7. **Metered buses on low** (technical design): whether low meters master only in shipped games to save its budget.
8. **The crossfade length** for structural live edits, and whether a script's runtime changes appear on the editor's faders (technical design).

## References

- [docs/design/0171-audio-mix/goal.md](../design/0171-audio-mix/goal.md): the owner-confirmed goal, and today's values with citations.
- [spikes/audio-mix/README.md](../../spikes/audio-mix/README.md): answers, design consequences, proposed budgets, the unverified list. Sub-spikes: `research/` (S0), `loudness/` (S1), `cpu-clock/` (S2), `capture/` (S3), `mix-core/` (S4); `timed-runs.sh` and `timed-runs.log` for the idle-machine runs.
- ITU-R BS.1770 and EBU R128 / Tech 3341 / 3342 (loudness); libebur128 (MIT) and the Rust `ebur128` crate (MIT), studied in S0 and S1.
- FMOD Core headers (vendored in a public repository), Unity's C# reference source, and Godot's audio server, read in S0.
- ADR 0157 (the core and its roadmap), 0097 (the mixer and ducking), 0158 (parameters and automation), 0162 (the shedding ladder), 0166/0167 (M4-0's in-voice stamped records), 0170 (the ladder recovers), 0024 (storage), 0155 and 0169 (Android).

## RFC round (revision 2)

Five reviews, in [docs/rfc/0171/](../rfc/0171/): an architect, a senior engineer, a mid-level engineer, a sound designer and mixer (Wwise and FMOD; `mixer.md`), and a premise challenger. All five said **approve with changes**. Every code claim the reviews rest on was checked by the coordinator and holds:
- STATUS has 192 B spare (`audio-wire/src/schema.rs:73-74`);
- the master meter misses the reverb return and the limiter (`audio-core/src/bus.rs:575, 586-600`);
- a bus's index is its position in `project.json` (`coreBackend.ts:765-770`);
- `mixer.configure` clears script volumes, fades and the snapshot (`mixer.ts:80-91`);
- frames restart at 0 on a rebuild (`clock.ts:116-122`);
- `workUnits` is the last quantum's only (`counters.rs:392-393`);
- solo isn't in `BusSettings` (`settings.ts:36-51`);
- one snapshot is active at a time (`mixer.ts:72`);
- the samples change bus volume from scripts with `fadeTo` (`samples/flappy/scripts/behaviors/GameManager.ts:17`, `samples/sound-lab/scripts/behaviors/Buses.ts:17`, `samples/stress/scripts/behaviors/Stress.ts:208`), so the authored/runtime split is needed.

### Changes to the decision

**The stream (§1)**
1. **Every record carries (epoch, frame, seq)** (architect). A main event carries the frame of the command it causes (or the frame now) and `performance.now`.
   - An **EPOCH** record (reason, new sample rate) is written at every context rebuild, followed by a keyframe.
   - A **gap** record covers dead time (a trap, a stall, a hidden tab).
   - Records are ordered by (epoch, frame, seq). The heard clock trails rendered frames by the limiter's latency (`clock.ts:7-9`).
   - These fields are also what a later live link needs to resync; the technical design writes that framing on paper (challenger: the "link is a transport" claim had no framing check).
2. **STATUS blocks are recorded raw, with no delta encoder** (challenger, A'). The raw copy costs 0.6–3.2 µs and allocates nothing in a preallocated ring, which removes the encoder's 370 B per block.
   - Keyframes stay, keyed on the STATUS count rather than rAF, which stops in a hidden tab (architect 11). They carry main-side state, and the ring evicts by keyframe segment.
   - The recorder copies each block inside the STATUS callback, since the reader reuses one buffer (`statusReader.ts:54`).
   - The ring then holds about 3 minutes at 1,024 voices and about 18 at 64 on 32 MB (from S3's raw rates). It's sized from the preset and `navigator.deviceMemory`.
3. **A capture records the `audio` section at its start** and every mix edit as an operation (senior 5), plus the project's name and version. The editor warns when the open project's mix differs, and refuses only on a different wire.
   - A capture from another ABI is refused with a message naming both versions and "re-record with this build". The editor carries only the current wire's decoder, an accepted limitation (senior 6).
   - A capture whose ring wrapped is marked truncated (junior 5).
4. **Captures are untrusted input** (architect 12):
   - decompressed size is capped;
   - decoding runs in a bounds-checked Worker;
   - the name table is read as data only;
   - the export's built-in trigger caps the number of saved files.
5. **Markers:** `Audio.capture.mark(text)` adds a timeline marker (mixer).

**The CPU figure (§2)**
6. **STATUS carries cumulative counters** (architect 5): `busyMsTotal`, `quantaTotal`, and a work-unit total per section.
   - Main forms the 256 ms window by quantum count, so cadence changes (6 vs 48 quanta) and skipped posts don't bias it.
   - Deltas are clamped, because `Date.now` is a wall clock and can step.
   - The live refit stays on main and never feeds the voice cap (`cap.rs:99-108`).
7. **Coarse clocks:** the core detects the clock's step (the smallest non-zero delta). If it is too coarse for the window (Firefox with resistFingerprinting; WebKit [U]), the line is hidden with a reason. The desktop editor on macOS and Linux runs WebKit, so the CPU line there is unverified.
8. **The profiler's headline for clicks is underruns, late commands and `minSlackFrames`,** with `loadPermille` labelled "256 ms average" and the section split "estimated share" (challenger 8, mixer). A click inside one quantum shows in the counters, not in the average.

**The profiler (§3)**
9. **Additions:**
   - jump to the previous or next underrun;
   - a name filter for voices and events (mixer);
   - each bus's gain factors (authored, runtime, snapshot, duck, automation) at the cursor (mixer 5; they come from change 15);
   - empty states for every view: "Not playing", "recording starts when the panel opens in Play", "CPU not yet measured" before the first window, "not metered" (junior).
   - **Replay against the engine** (as FMOD's API capture replay) is a non-goal.
10. **The editor's drawing budget** in Play is ≤ 2 ms a frame: canvas drawing, and no Preact render per STATUS block (architect).

**Loudness (§4)**
11. **Master is metered on the final output, after the reverb return and the limiter** (architect 1). That is what a true-peak ceiling is about.
    - The stream records MASTER volume and the hidden-tab mute.
    - The target check is suspended while MASTER ≠ 1 or muted.
12. **Names** (senior):
    - the bus field is **`meter: "loudness"`** (absent = off, never written when default, as `bed` is);
    - the project target is **`audio.loudnessTargets`**;
    - the reader is **`Bus.loudness`**.

    Master is always metered, **plus up to 8** buses chosen by name.
13. **`Bus.loudness` is a stable object** allocated once per bus, like `peak`, beside `Bus` in `engine/audio/mixer.ts` (senior):
    - **readings:** `momentary`, `shortTerm`, `integrated`, `lra`, `maxTruePeak`, `maxMomentary`, `elapsed`;
    - **state:** `paused`, `incomplete`, `tainted`, `metered`;
    - **controls:** `reset("integrated" | "maxPeak" | "all")`, `pause()`, `resume()`;
    - **empty values:** `-Infinity` while gated, empty or unmetered, never `NaN`. An unmetered bus has `metered = false` and doesn't throw. The Babylon fallback reports the same shape with `metered = false`.
14. **Data integrity:**
    - the core keeps a **32-entry** sub-block ring and sends only the sub-blocks since the last *successful* STATUS take, so a main stall of up to 3.2 s loses nothing (architect 7);
    - an older loss sets `incomplete`;
    - true peak reports **max(true peak, sample peak)**, gated at the **ceiling − 6 dB** rather than a fixed -6 dBFS, and the gated quanta are counted (architect 9);
    - after a rebuild, integrated loudness continues on main and the gap is marked.

**Live mixing (§5)**
15. **Gain composition is defined** (architect 2). The core holds one stamped lane per factor and multiplies them per sample:
    - authored volume;
    - runtime (script `volume`, `fadeTo`);
    - snapshot;
    - duck;
    - automation (0158; already evaluated in the core, `bus.rs:556-571`, so "automation becomes ramps" applies to Babylon only, architect 10).

    Both ducking modes combine in the core by **min**, with presence fed by a per-bus flag. STATUS reports each bus's duck gain, so main's audibility estimate (`coreBackend.ts:690-692`) sees it.
16. **`Bus.volume` becomes the runtime multiplier** (default 1, 0..2). **`Bus.authoredVolume`** is read-only to scripts and written by the editor (senior). Authored 2 × runtime 2 = 4 is legal and the limiter catches it. The editor's fader shows the authored value, with the effective gain drawn beside it.
17. **Edits travel as operations, not diffs** (senior 2, architect 3): set, add, remove, rename, move, from the model functions the settings section already uses (`AudioSettingsSection.tsx`).
    - `mixer.apply(op)` changes the mixer without clearing script state, unlike `configure`.
    - A **session slot table** (name → core slot, with tombstones) in `coreBackend` keeps indices stable. Rename is explicit.
    - A tombstone is recycled once its tail has faded and no voice references it.
    - An addition past the preset's `max_buses` is **refused visibly** in the editor.
    - The table is replayed on a context rebuild or hard rebuild (the end state of an in-flight edit, never half of it) and compacted at Stop.
18. **An editor SDK hook carries saved audio edits into the play Engine** (senior 4): `editor.project.changed(sectionKey, ops)`. It amends **0147**'s SDK list. The audio panels import `editor/sdk` only.
19. **Structural edits dip instead of crossfading** (architect, challenger F). Re-parenting, reordering or removing effects, removing a send and moving a sound to another bus all go the same way: fade the affected subtree out over 20 ms, apply, fade back in. This is one code path, and only the edited subtree dips.
    - Direct edits (volume, filter parameters, send levels, appends) apply in place.
    - Compressor parameters are smoothed over ≥ 20 ms in the core.
20. **Monitor state** (mixer 1, 2):
    - **the Mixer panel's mute and solo are monitor controls,** never written to `project.json` (shipping a soloed bus would be a bug). The authored `mute` stays editable in Project Settings;
    - while any monitor control is active, a banner says so, and every meter that saw it since its last reset is **`tainted`**.
21. **Session controls** (mixer 3, 8, 9):
    - loudness resets at Play start by default (a project option);
    - Pause, Reset and elapsed time are in the panel;
    - a fader drag is one undo step, committed on release, and the heard value follows the drag;
    - **"Compare with Play start"** swaps in the `audio` section as it was at Play start, and back;
    - a measured gate: a fader move is heard **≤ 50 ms** after the input event.
22. **The Mixer panel is a strip** (challenger I, mixer): per bus, a fader, monitor mute and solo, a peak meter with hold and a clip latch, momentary and short-term LUFS (integrated on metered buses), a gain-reduction meter on level-ducked buses, and snapshot buttons. It reuses `BusMeters`' drawing. Buses past the first 32 show "not metered" (`meters.rs`). Effect editing stays in Project Settings, which applies live (owner decision 5).
23. **Per-platform loudness targets:** `audio.loudnessTargets` is a small table, for example `console` and `mobile`, each with an integrated target, tolerance and true-peak ceiling. Play picks one in the Mixer panel (mixer; defaults are owner decision 4).

**The mix's timing (§6)**
24. **Ducking rule format** (junior 1, senior):
    ```jsonc
    { "target": "Music", "trigger": "Voice", "mode": "level", "detector": "rms",
      "threshold": -30,   // dBFS, the trigger level where ducking starts
      "amount": 0.4,      // the multiplier the target heads for, as today
      "attack": 0.05, "release": 0.4 }   // seconds, as today
    { "target": "Music", "trigger": "Voice", "mode": "presence", "amount": 0.4, "attack": 0.1, "release": 0.6 }
    ```
    - `mode` is required in the format, and the samples are rewritten.
    - Validation refuses a trigger that is the target's ancestor, as well as `target === trigger` (`settings.ts:367`). The error shows in the editor's settings section and the load log.
25. **The sidechain tap is the trigger bus's signal before its fader, mute and solo,** so monitoring doesn't change the duck.
26. **Staging** (challenger D): M5-0 ships the trigger-first sort, which fixes presence mode's one-quantum delay. Level mode lands in M5c, so the ABI and editor changes are checked one at a time.
27. **Bus ramps are a third stamped class in M4-0's due list** (`due.rs`), not a second mechanism, and `splitQuanta` stays 0 (senior). The benefit is stated as exactness and one shared clock for ducking and live edits, not an audible fix: S4 found no audible step today (challenger E).

**Budgets, wire, robustness (§8, §10)**
28. **STATUS grows to 20 KB** (`STATUS_BUFFER_BYTES`; +32 KB across the pool of 8) to carry the loudness ring, the cumulative counters and duck gains. The new worst case, the hash and the vectors are a wire task at the head of M5-0 (architect 6, senior 1).
29. **A new first step on the shedding ladder pauses non-master loudness metering** (flagged in the stream and in `Bus.loudness.paused`) before beds or zones are touched. Under 0170 it is given back last. Sidechain is never shed. This **amends 0162 and 0170** (architect 8). It also settles open question 7: every preset may meter chosen buses, and a struggling device sheds them first.
30. **Budgets are stated in metered instructions as well,** converted with ADR 0169's floor profile, beside the container µs (architect). Gated loudness is content-dependent: a hot mix costs 13.8 / 36.3 µs, not 10.3 / 24.7. The worst allowance uses the hot figure.
31. **Methodology gaps, re-measured in the technical design:**
    - S3's main-thread timings ran at load ≈ 2.0 after S2;
    - S2's truth was partly validated with `Date.now`;
    - no run measured the real core with M5 added end to end. The design adds M5 metered scenes on the real core and re-runs S3 idle.
32. **Capability flags in `Audio.debug()`** (`loudness`, `levelDucking`, `cpu`, `stampedBusRamps`) report what the backend supports, as music does (senior).
33. **`Audio.capture.start()` returns a Promise** (the recorder loads lazily) and **`save(name?)`** returns `Promise<string>`, the path or file name. `save()` with nothing recorded rejects with a message. The editor's panel and a game capture share one ring (senior, junior).
34. **Glossary additions:** sub-block, presence and level mode, authored and runtime value, edit operation, monitor control, tombstone, epoch, tainted (junior 4).
35. **Records amended at acceptance:**
    - **0097:** ducking modes and `Bus.volume`'s meaning;
    - **0147:** the SDK hook;
    - **0157 §4.7:** `loadPermille` filled, cumulative counters;
    - **0158:** automation is one gain lane;
    - **0162 and 0170:** the ladder's new first step.

### Estimate (revised, provisional)

The senior engineer's bottom-up, adjusted for the changes above:

| | Person-weeks |
|---|---|
| The senior's tasks: M5-0 7, stream 5, CPU 1.5, profiler 11, loudness 5, live apply 7, Mixer panel 4, sidechain 2.5, captures 2.5, Babylon / samples / guides 2.5, plus 9 unpriced (wire, goldens incl. EBU files, metered scenes, e2e, docs, listening pass) | 57 |
| Added by this round: the mixer persona's must-haves (monitor state and taint, session controls, per-platform targets, gain factors at the cursor, markers, underrun jump, name filter, Compare, hold / clip / gain-reduction meters) ≈ 3; the architect's robustness (epochs and gaps, cumulative counters, the slot table's replay and recycling, a decode Worker, the ladder step) ≈ 2 | +5 |
| Cut by this round: raw STATUS instead of the delta encoder −1.5; the subtree dip instead of crossfades −1.5; the Mixer panel as a strip without effect editing −1.5 | −4.5 |
| **Tasks** | **≈ 58** |
| Reserve, 20% as M4 chose | ≈ 12 |
| **Total** | **≈ 70 (range 62–75)** |

Snapshot stacking (owner decision 7) would add ≈ 1.5 person-weeks of tasks (≈ 1.8 with reserve).

### Not taken, and why

- **A 4 Hz history ring on the debug panel instead of the stream** (challenger A). Underruns and late commands between samples vanish, and so do event reasons on the audio clock and the capture file the owner put in scope. The raw-STATUS middle path (change 2) takes the saving that doesn't cost those.
- **Loudness on master only** (challenger B) and **dropping captures in exports or level-mode ducking** (challenger D, G): settled scope. Their costs are noted in the record.
- **Chromium DevTools for CPU, AnalyserNode meters on Babylon** (challenger C, H): no figure in exports or devices, and no LUFS without our own filters.
- **Running old and new routing side by side for structural edits:** replaced by the subtree dip (change 19), which is simpler and was proposed by two reviewers. The cost is a 40 ms dip of the edited subtree.
- **Structural live edits applied at Stop** (senior's cheaper option): it contradicts hearing the edit straight away. The dip makes them live for little more.
- **Stable bus ids in `project.json`** (senior's alternative to the slot table): the session table keeps the file format unchanged and needs no migration.
- **Presence as the default for new rules until a detector meter exists** (junior): change 22 adds a gain-reduction meter, so level mode is visible from the start. The default stays an owner decision.
- **HDR audio, Soundcaster-style audition, a Voices Graph, a speaker simulator** (mixer, nice-to-haves): out of M5. HDR audio and a speaker simulator go to the roadmap note.

### Owner decisions (to bring after this round)

1. **Recording trigger in exports:** `Audio.capture` plus the export option's key combination and touch gesture (recommended), or the API only.
2. **Captures in release builds:** the API works in every build, loading the recorder only when used, and the built-in trigger comes only with the export option (recommended); or debug builds only.
3. **Getting a capture off Android:** adb on debug builds in M5, with a share-sheet plugin as its own later record (recommended); or the plugin in M5 (a new dependency, ≈ +1 person-week).
4. **Default loudness targets:** a `console` entry of -24 LUFS ±2 LU with a -1 dBTP ceiling and a `mobile` entry of -18 LUFS ±2 LU with -1 dBTP (recommended; the figures are published game-audio guidance, unverified here), or no default until a project sets one.
5. **Mixer panel scope:** the strip without effect editing (recommended; effects stay live in Project Settings), or effect editing in the panel (≈ +1.5 person-weeks).
6. **Default ducking mode for new rules:** `level` (recommended) or `presence`.
7. **Snapshot stacking:** several active snapshots blending by priority and intensity, as FMOD and Wwise do (≈ +1.8 person-weeks), or one at a time as today (recommended for M5, with stacking on the roadmap).
8. **The estimate:** ≈ 62–75 person-weeks provisional, in milestones M5-0, M5a–d.

## Owner decisions (accepted, 2026-11-12)

The owner accepted the direction with every recommendation of the list above ("Your recommendations sound fine to me"):

1. **Recording trigger:** `Audio.capture` plus the export option's key combination and touch gesture.
2. **Release builds:** the capture API works in every build; the recorder loads only when a capture starts; the built-in trigger comes only with the export option.
3. **Android:** adb on debug builds in M5. A share-sheet plugin is a later record of its own.
4. **Default loudness targets:** `console` -24 LUFS ±2 LU, -1 dBTP; `mobile` -18 LUFS ±2 LU, -1 dBTP (published guidance, unverified here).
5. **Mixer panel:** the strip without effect editing; effects stay live in Project Settings.
6. **Default ducking mode for new rules:** `level`.
7. **Snapshots:** one at a time in M5; stacking by priority and intensity on the roadmap.
8. **Estimate:** ≈ 62–75 person-weeks, provisional until the technical design's task table, in milestones M5-0, M5a, M5b, M5c, M5d.

**Owner note: the audio editor's UI/UX will be reworked** to fit a sound designer's workflow; today it is scattered across Project Settings > Audio, the debug panel, the event and music editors and the Inspector. For M5 this means:
- **Behaviour is decided here; placement is not.** Where the Profiler, the Mixer strip, the loudness readouts and the capture controls live (panels, tabs, a dedicated audio workspace) follows the owner's rework, not this record.
- **The technical design keeps every M5 view a thin layer** over pure, tested models (timeline state, capture decoding, mixer operations, loudness readings), so the rework can rehome or regroup them without touching the logic, as the music editor's `*Logic`/model modules already do.
- **M5 adds no new scattered entry points:** new audio UI registers through the editor SDK in one place the rework can reorganise, and the technical design asks the owner whether the rework comes before, alongside or after M5's editor tasks.

# Audio M5 (profiler and live mix): goal and constraints

This is step 1 of the design pipeline, the goal interview (owner answers 2026-11-12). **Status: confirmed by the owner, 2026-11-12.** The record is 0171 (0170 went to the shedding-ladder fix on master the same day).

The decision record and the technical design build on this statement. Where they differ, this statement wins until the owner changes it.

The working rules in [../0162-audio-spatial/working-notes.md](../0162-audio-spatial/working-notes.md) carry over unchanged:
- no runs that can't change a decision;
- follow industry standards (Wwise, FMOD, Unity, Unreal), and say where M5 differs and why;
- no feature flags or compatibility defaults;
- intensive tests at wave end and milestone end.

## Goal

The fifth item on ADR 0157's roadmap: "**M5: profiler and live mix.** A voice and CPU view built on the status channel, LUFS metering, and live mix editing in play mode on web and desktop." It serves 0157's goal of AAA-quality mixing and control built into an open-source engine. M5 is where a sound designer can see why the game sounds the way it does, measure how loud it is, and fix the mix while it plays.

## Scope (owner)

1. **Profiler.** A timeline of the audio engine over time: voices (playing, virtual, stolen, and why), audio-thread CPU, underruns and late commands, the shedding ladder, events, music and bus levels. You can pause it, scrub it and inspect any moment, as in the Wwise Advanced Profiler and the FMOD Studio profiler.
2. **Capture files.** A profile can be saved to a file and reopened in the editor. **Exported games (web, desktop, Android) can record a capture** for opening later, which covers problems that only happen on a device (F-37's start-up clicks).
3. **Loudness metering with targets.**
   - Integrated, short-term and momentary loudness in LUFS, plus true peak, per ITU-R BS.1770 / EBU R128.
   - Meters run on **master and the buses the project picks**, not every bus. This matches FMOD, where the loudness meter is an effect you place on a bus, and Wwise, whose Loudness Meter watches the bus you select. Both are from memory: the proxy blocks their documentation, so the survey confirms it.
   - **A project loudness target** to check against, for example the game-audio guidance of -24 LUFS integrated on console and PC and -18 on mobile. The meters warn when the mix is off target. Nothing adjusts gain automatically.
4. **Live mix editing in play mode.**
   - Bus volume, mute and solo, effects, snapshots, ducking and parameter automation can be changed while the game plays, and you hear the change straight away.
   - **Edits are kept after Stop.** They are ordinary, undoable edits to `project.json`'s `audio` section, as in Wwise and FMOD, where the mix is project data.
5. **Signal-driven mix.**
   - **Sidechain ducking.** A bus ducks by the trigger bus's actual level, for example music dipping while dialogue is loud, rather than while a voice is merely playing.
   - **Sample-accurate bus fades and snapshot transitions** run in the core instead of stepping once per frame on main.

## Reach (owner: option a)

- **In M5:** the editor's play mode (profiler and live mix), plus capture files recorded by exported games and opened in the editor.
- **Roadmap, not M5:** a live connection from the editor to a running exported game, for profiling and mixing on the device, as Wwise and FMOD do with consoles. M5 defines the profiler's data as a stream of timestamped snapshots, so that:
  - a capture file is that stream saved to disk;
  - a later live link is the same stream sent over a socket.

  The link then adds a transport, not a redesign. It waits for a real device: ADR 0169 left the real-device items deferred.
  - Why it's deferred: it needs a listener in the desktop editor, a new Rust dependency (`src-tauri/Cargo.toml` has no socket server today); the web editor can't listen at all. It also needs a debug-only switch in exports, pairing and security, and LAN rules: a page served over HTTPS can't open plain `ws://`, and Android needs a cleartext exception or `adb reverse`.
  - The rough estimate was +6–10 person-weeks over capture files, against +2–4 for the files themselves (estimates, before any survey).

## Budget (owner: own budget)

- M5 gets **its own audio-thread budget**, as M4 did, sized from measurements. Loudness meters (K-weighting filters, true-peak oversampling) and sidechain detectors are the audio-thread costs; the profiler should cost the audio thread close to nothing beyond the STATUS fields it adds.
- Profiling work (recording, aggregation, UI) runs on main or in the editor, and its main-thread share is measured too.
- Size gates remain tripwires for bloat, not design limits.

## Constraints (carried over from M3 and M4)

- **Licence:** open source only, with no per-title licences. BSD, MIT and similarly permissive code may be ported in with its notices kept.
- **Platforms:**
  - the editor on desktop and web (the profiler and live mix work in both);
  - published games on web, desktop and Android (system WebView), which can record captures.
- **Fallback:** **best effort** on the Babylon backend. It has no core and so no audio-thread CPU, true-peak or sidechain figures; the design says what the profiler shows there.
- **Low-end device:** the floor of ADR 0169, Android 14 (API 34) with Chrome or WebView 113. The reference profile is the emulated Pixel 8 (2 GB, 4 cores). Real-device numbers stay **unverified**; the lab-VM run is the owner's.
- **Users:**
  - **sound designers and mixers** profile, meter and mix in the editor;
  - **developers** read the profiler when a sound is missing or the audio glitches, and record captures from test builds;
  - **players** hear the result. A capture recorder must never run, or cost anything, in a release export unless the developer asks for it.
- **Who uses the engine today:** only the samples. There is no compatibility work; the samples are updated instead.

## What exists today (read from code, 2026-11-12, master `10f8de8`)

| Area | Today | Where |
|---|---|---|
| Debug panel | `Audio.debug()` read every 250 ms while playing: status, backend, counters, each bus's gain, peak and voices, the 64 most audible voices (the rest counted by state), event instances, beds, zones, occlusion, music. A snapshot, with no history | `src/plugins/audio/editor/AudioDebugPanel.tsx:15-21`; `src/plugins/audio/runtime/backend.ts:137-162` |
| Bus meters | Sample peak only, left and right, measured after each bus's effects and gain. They fall at 20 dB/s and rise at once. The first 32 buses go into STATUS. The editor polls them every 50 ms in Project Settings > Audio, during Play only | `native/audio/crates/audio-core/src/meters.rs:1-16`; `src/plugins/audio/editor/BusMeters.tsx:1-25` |
| Loudness | None: no LUFS, no K-weighting, no true peak (0157's M1 lists true-peak detection as missing) | `docs/architecture/implementation-status.md` row 0157 |
| Audio-thread CPU | `loadPermille` exists in STATUS and is always 0 ("unmeasured in M1"). Work units (`workUnits`, `workUnitsMax`), `underruns`, `lateCommands` and `minSlackFrames` are counted | `native/audio/crates/audio-core/src/counters.rs:424-425`; `backend.ts:142` |
| STATUS channel | Every 6 quanta (128 frames each) while commands flow, less often when idle. Its sections are versioned and counted, which 0157 left as M5's extension point | `native/audio/crates/audio-wire/src/schema.rs:75`; `src/plugins/audio/runtime/worklet/coreDriver.ts:976`; `docs/design/0157-audio-core/architecture.md` §10 |
| Mixer configuration | Read from `project.json` once, when the engine starts (`mixer.configure`). Edits in Project Settings > Audio during Play don't reach the running mixer | `src/engine/core/Engine.ts:184-187` |
| Live tuning | M3 made zone, material, occluder and AudioSource fields apply during Play. Bus, snapshot and ducking edits aren't live | `docs/design/0162-audio-spatial/api-and-models.md:351` |
| Bus effects | lowpass, highpass, compressor, reverb send; a master look-ahead peak limiter | `src/engine/audio/settings.ts:26-31`; `native/audio/crates/audio-core/src/bus.rs:125` |
| Fades, snapshots, ducking | Advanced on main in `mixer.update(dt)`, once per frame, then sent to the core as BUS_MIX with a ramp of one frame interval (clamped to 5–50 ms). Bus gain is therefore piecewise linear, not stepped, but it trails the intended curve by about 18–38 ms and isn't anchored to a frame (corrected after spike S4) | `src/engine/audio/mixer.ts:183-215`; `src/plugins/audio/runtime/audioSystem.ts:170`; `src/plugins/audio/runtime/core/coreBackend.ts:698`; `src/plugins/audio/runtime/core/lookahead.ts:33-37`; `spikes/audio-mix/mix-core/README.md` |
| Ducking | A rule ducks its target while the trigger bus has **any voice playing**, whatever its level | `src/engine/audio/mixer.ts:203-208` |
| Editor-to-game link | None. Exported games can open outgoing WebSockets (`src/engine/net/transport/websocket.ts`); neither editor can accept one | `src-tauri/Cargo.toml` |
| Audio-thread budget | High preset: 1.19 of 1.3 ms after M1; M3 added ≈ 0.10 ms typical and 0.42 ms worst; M4's music allowance is 30–43 µs typical, 68 µs worst (estimates). High is already over 1.3 ms p99.9 on the lab VM | `docs/design/0157-audio-core/README.md`; `docs/design/0162-audio-spatial/README.md`; `docs/design/0166-audio-music/README.md:67` |
| Mixer size | The wasm mixer is 318,306 B against the 320 KB gate (a tripwire) | M4 build log, D5 entry |
| Previous milestone's size | M4: 290.5 task-days + 58 days reserve ≈ 69.7 person-weeks | `docs/design/0166-audio-music/README.md:44` |

## Open for the survey and spikes (step 2)

- How Wwise, FMOD, Unity and Unreal shape their profilers, captures, loudness meters and live mixing (documentation hosts are blocked by the proxy; GitHub raw works).
- The audio-thread cost of BS.1770 K-weighting, the gated integrated measure, and 4× true-peak oversampling per metered bus, on the metered bench.
- How to measure audio-thread CPU inside an AudioWorklet (no high-resolution timer there), so `loadPermille` stops reading 0.
- A capture's size per minute and its main-thread cost at the full STATUS rate.
- How an exported game saves a capture on web, desktop and Android.

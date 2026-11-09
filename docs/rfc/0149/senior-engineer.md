# RFC 0149 review: senior engineer

**Verdict: approve with changes.** The spike evidence is strong, and the direction (engine-owned Rust core, 0098 seam kept, committed wasm like nav) is sound and buildable. But M1 is sold as "parity" while it is really a new audio engine plus a new decode pipeline plus five new features (virtual voices, priority/limits, sample-accurate clock, streaming, golden tests). It has no estimate, no return-channel design, and rests on a false premise about the existing unlock step. M2-M5 are each a product; the ADR should commit only to M1 and sketch the rest.

Top 3 concerns:
1. **The core-to-main return channel is missing.** Voice end, play position, stream underrun and error reporting are required by existing code (`mixer.voiceEnded`, `AudioVoice.playing`) and are not specified.
2. **M1 scope is too big to be "parity" and has no incremental path.** It deletes Howler in the same milestone that introduces the core.
3. **The command format and voice handle are unspecified** (versioning, ID reuse, ordering against stream data), though everything later depends on them.

## Issues

1. **blocking: no return channel.** `src/engine/audio/backend.ts:28-39` has a synchronous `AudioVoice.playing`. `howlerBackend.ts:19-25,31` ties `mixer.voiceStarted/voiceEnded` to a real end event, and 0097 ducking triggers on voice counts. The RFC only describes main-to-worklet commands. Change: add a worklet-to-main events path (voice ended, stream starved, voice stolen, error), at most one message per frame. State that `playing` becomes a main-thread mirror lagging a few quanta, and what a virtual voice that finishes silently reports.
2. **blocking: false premise "the existing unlock step" (RFC line 52).** There isn't one; Howler's auto-unlock does it (`AudioSource.ts:2-3`). M1 must build an unlock/resume layer (gesture listeners, `statechange`, tab suspend/resume, Tauri). Add it to M1 scope and risks. Define `play()` before unlock: queue with a cap and TTL, or drop (Howler queues today).
3. **major: M1 is not parity-sized.** It includes replacing decoding (clips go through Howler's `decodeAudioData`, streams through HTML5 audio). Split M1a (core, clips, buses, spatial; decoding via `decodeAudioData`; Howler still default behind a flag), M1b (symphonia worker, streaming), M1c (virtual voices, clock, Howler deletion). RFC line 113 already has the `decodeAudioData` fallback; make it the M1a path.
4. **major: voice handle and command format undefined.** Specify now: batch header `{version, frame, count}`, fixed-stride records, voice id = index + generation (stale script handles become no-ops after reuse), and ordering against stream chunks (they travel on a different channel, so "play" can precede data: needs a per-voice "starved until first chunk" state). Version the format, since the committed wasm and the JS packer can drift.
5. **major: transferred `Float32Array` per frame allocates.** The messaging spike measured a 0.55-0.86 ms GC scavenge in the worklet at 1,024 voices. Change: recycle buffers by sending them back, or use the SAB ring when isolated, and gate M1 on measuring the non-isolated path at 256 voices. Say whether Tauri sets COOP/COEP (it can), since that decides the desktop default.
6. **major: `stream` semantics change.** Streamed clips today "can't be spatial or routed" (`AudioSource.ts:33,101-103`, `backend.ts:21`). After M1 they can. Redefine the 0040 `stream` sidecar field as "decode incrementally in a worker", drop the warning when it lands, and keep `volume` unchanged (`clipVolume`).
7. **major: AudioContext ownership.** Howler owns the shared context today (`howlerBackend.ts:101-110`, `busGraph`), and `src/editor/thumbnails/audio.ts:1-3` decodes with browser Web Audio. Define who creates the context (per Engine, or one module-level), and how the editor viewport and play mode share it.
8. **minor: M2-M5 read as accepted milestones** while saying each gets its own ADR. Move them to a roadmap labelled "not decided here".
9. **minor: bus effect parity is not bit-exact.** 0097 effects are lowpass, highpass, compressor, reverb send (`settings.ts:19-26`). Web Audio's biquad and compressor differ from ours, so "parity" means within-dB tolerances, not matching Howler.
10. **minor: error reporting.** Failed decode, missing wasm and no device currently return null silently. Add a once-per-clip warning and `Audio.status` (`locked | running | failed`).

## API and data model

M1 public API: unchanged (`AudioSource`, `AudioListener`, `Audio.playOneShot/bus/snapshot/volume/muted`, `src/engine/index.ts:51-53`). Small forward-compatible additions worth making in M1:
- `Audio.playOneShot` returns an `AudioHandle` (id + generation; `stop()`, `fade(to, seconds)`, `playing`). It returns void today, which would make M2's `Audio.play(event)` an awkward shape change.
- `AudioSource.priority` (0-255, default 128), `buses[].maxVoices?`, `audio.voices?: { mixed, logical }`. All optional with defaults, so no project migration.
- Time: `Audio.time` plus `playAt(time)` and `bus.fadeTo(v, secs)`. Define the unit as seconds on the audio clock, not engine time (pause and timeScale differ).
- `audio.backend`: parse, warn, ignore (RFC line 148). Existing samples (`samples/flappy/prefabs/music.prefab.json`, pirates scenes and `Hud.ts`/`Menu.ts`) use only `AudioSource` and `playOneShot`. Make "runs unchanged" an acceptance test.
- M2 needs a new asset kind (0143's module), a `myco.audioevent@1` format and shared curves. Do not freeze the curve format in this ADR.
- Sidecars (0040): keep `stream` and `volume`; add nothing in M1.

## Milestones and estimates

One engineer who knows the repo and Rust, person-weeks:

| Iter | Content | Weeks |
|---|---|---|
| 0 | Crate, `build:audio` (simpler than nav, no wasm-bindgen), loader, worklet processor, context and unlock | 1.5 |
| 1 | Command format, voice table, events back; clips, pan, pitch, 0074 distance models | 2.5 |
| 2 | Buses, solo/mute, snapshots, ducking (0097) on the core; biquad, compressor, reverb | 2.5 |
| 3 | Virtual voices, priority, bus limits, clock (`playAt`, ramps) | 1.5 |
| 4 | Decoder worker, symphonia, streaming, seek, loop | 3 |
| 5 | Golden tests, CI bench, listening pass, sample checks, delete Howler/FMOD, docs | 2 |

About 13 person-weeks; plan 16-18 for browser and Tauri quirks. Behind a flag: iterations 0-3 as `audio.backend: "core"` (replacing `"fmod"` as the second backend through the seam at `backend.ts:62-77`); streaming per project. **Riskiest first:** the worklet round trip inside the real engine (unlock, commands, voice-end events, in headless tests and editor play mode), then streaming. Order: virtual voices are cheap per the spikes, so ship them before streaming. Defer deleting Howler until one release after the flag defaults on.

## Conflicts with existing code and decisions

- `Engine.ts:12-14,174-177` wires FMOD and parses settings; `backend.ts:60` has a module-global `mixer` and backend. A core that owns time needs a per-Engine lifecycle (dispose, restart play mode).
- Deletions: `busGraph.ts`, `howlerBackend.ts`, `fmodBackend.ts`, `tests/fmodBackend.test.ts`, `docs/guide/fmod.md`. Check `src/myco.ts` and `src/editor/audioSettingsModel.ts` references.
- `tests/audioBackend.test.ts:1-51` and `spatialAudio.test.ts` use a fake `AudioBackend`. The interface must grow (events, handles, priority), so update the fakes in the same change.
- `mixer.resolveAll()` output must be serialised into the core on `onChange`; the mixer stays the source of truth.
- 0133 (line 138) already lists Audio as a plugin. Decide now: recommend core wasm stays in `src/engine/audio/` and authoring UI becomes a plugin in M2.
- `docs/architecture/implementation-status.md:13` (0006 row) and the docs index need updating when 0006/0099 are superseded.

## Testing and tooling

- Golden tests in Node: load the committed wasm, render N quanta, compare digests with per-effect tolerances. The core has no wall clock, which helps determinism.
- CI cannot rebuild wasm without Rust; embed a source hash in the wasm and check it in `npm test` to catch stale commits. Pin the toolchain with `rust-toolchain.toml`.
- A "fails at >20% regression" benchmark on shared runners is flaky; use instruction counts or a ratio to a calibration loop.
- One shared command schema (generated constants, or a round-trip test) so Rust and the TS packer cannot drift.
- Playwright: one `@slow` spec that plays a sample and reads offline-rendered output; listening checks are a manual checklist.
- Tauri: verify the worklet under WebView2 in `tauri:dev`. macOS is untested, so make it a release gate.

## Cheaper alternatives or simplifications

- Keep `decodeAudioData` for M1a; postpone symphonia and the worker to M1b (saves about 3 weeks on the critical path).
- Build the reverb from the spike's Freeverb; mirror Web Audio's effect semantics first.
- Skip the SAB ring until the GC scavenge is shown to matter.
- Ship one voice preset with a configurable `audio.voices.mixed`; add presets after measuring a slower device.
- Defer M3-M5 out of this ADR's acceptance.

## Questions for the author

1. Who owns DSP quality and the listening-test process?
2. Can iterations 0-3 land behind `backend: "core"` before any deletion?
3. What is the `play()` policy before unlock and after tab suspend?
4. Is returning an `AudioHandle` from `playOneShot` acceptable in M1?
5. Is Howler kept for one release for WebViews without AudioWorklet, and what is the minimum WebView2/WebKit version?
6. Where does mixer state live when two Engines (editor viewport and play mode) coexist?
7. Is the committed wasm reproducible (pinned toolchain)?

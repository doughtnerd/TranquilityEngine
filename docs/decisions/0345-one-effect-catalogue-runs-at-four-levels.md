# 0345. One effect catalogue runs at four levels: baked into a sample, per voice, per playing instance, per bus

- **Status:** Accepted
- **Date:** 2026-11-22
- **Deciders:** Chris Carlson
- **Supersedes:** —
- **Related:** 0097, 0157, 0172, 0175, 0179, 0306, 0342, 0343, 0344, 0346

## Context

The engine's effects are a per-bus chain of four types (low-pass, high-pass, compressor, a reverb send), at most four
per bus and one compressor, run by the Rust core; the Babylon fallback runs none. Voices have a low-pass and high-pass
and one aux send. `audio-dsp` already has biquads, a compressor, a convolver, a limiter, HRTF and loudness.

The prototype puts effects in four places and, across its screens, describes five slightly different catalogues:

| Place | Prototype | Runs |
|---|---|---|
| Sample (Samples) | EQ, Filter, Compressor, Gain, Pitch shift, Fades, Saturation, Noise reduction, Reverse | baked, no runtime cost |
| Clip / Clip playlist (Sequence, Playlists) | Sequencer set minus Delay and Reverb ("paid per voice") | per voice |
| Track, playlist, sequence | EQ, LP/HP/BP, Saturation, Bit-crush, Formant, Compressor, Distortion, Delay, Reverb, Pitch, Amp envelope; Playlists also Chorus | once per playing instance, on its mixed output |
| Bus and return (Mixer) | the Sequencer set plus Sidechain compressor and Limiter | one instance, always running |

Keys, ranges and object shapes differ between screens (`{t, …}` with `th/ra` vs `{id, type, …}` with `thr/ratio`; EQ
±12 vs ±18 dB). The Profiler's effects-cost track uses the same four levels.

## Decision

We will have **one effect catalogue** with one parameter schema, used at four levels, and give the core what the
levels need.

**The catalogue** (`src/engine/audio/effects/catalogue.ts`, pure, the single source of names, ranges and defaults in the
spirit of 0306) declares, per type: parameters (`name, min, max, step, unit, default, scale: "linear" | "log", bool`),
the levels it may run at, a version, and a cost class for the profiler.

| Type | Parameters | Levels |
|---|---|---|
| `eq` | low, mid, high −18..18 dB | all |
| `lowpass`, `highpass`, `bandpass` | cutoff/centre 20..20000 Hz (log), resonance 0..1, drive 0..100 % | all |
| `compressor` | threshold −60..0 dB, ratio 1..20, attack 0.1..200 ms, release 5..2000 ms, makeup 0..24 dB | all |
| `sidechainCompressor` | threshold, ratio, release, key (bus) | bus |
| `limiter` | ceiling −12..0 dBTP, release 1..1000 ms | bus |
| `gain` | −24..24 dB | sample, voice |
| `saturation` | amount 0..100 % | all |
| `distortion` | drive 0..1, mix 0..100 % | all |
| `bitcrush` | bits 4..24, downsample 1..32, mix | all |
| `formantShift` | −12..12 st | sample, voice, instance |
| `pitchShift` | −24..24 st, −50..50 ct | sample, voice, instance |
| `chorus` | rate, depth, mix | instance, bus |
| `delay` | time 1..2000 ms, feedback 0..95 %, mix | instance, bus |
| `reverb` | size 0..1, decay 0.1..20 s, mix | instance, bus |
| `envelope` (ADSR) | attack, decay, sustain, release | voice |
| `fades` | in, out 0..2000 ms | sample |
| `noiseReduction`, `reverse` | amount / — | sample |

An effect in any file is `{ "id": "fx1", "type": "lowpass", "on": true, "params": { "cutoff": 800 } }`; automation
lives with its owner and names `fx:<id>:<param>` (0343, 0344). Missing params take their defaults; unknown types are
dropped with one problem line (the engine's lenient parse).

**The four levels.**
- **Sample:** rendered offline in a worker by the same Rust DSP compiled for offline use, cached by content hash
  (0342). No runtime cost; game parameters can't drive it (time automation over the sample can).
- **Voice:** runs in the voice in the core (as low-pass and high-pass do today), automatable over clip time, voice time
  or parameters (0346).
- **Instance:** the core gains **instance submixes**: a pool of submix slots (`settings.voices.submixes`, default 32).
  The voices of one playing playlist, track or sequence route into its submix, which runs the chain and feeds the
  output bus. When the pool is empty an instance plays without its chain and the profiler records the reason.
- **Bus and return:** insert chains before the fader, as today, without the four-effects and one-compressor limits (the
  per-bus cap becomes 8 and lives in `busCapability.ts`).

**DSP to write** in `native/audio/crates/audio-dsp`: three-band EQ, band-pass with drive, saturation, distortion,
bit-crush, formant shift, pitch shift (a granular shifter), chorus, delay, an algorithmic reverb (an FDN; the
convolver stays for reverb zones' impulse responses), the ADSR, the sidechain key route and offline-only noise
reduction and reverse. Each is a wire opcode and an ABI change, with golden tests; the mixer wasm size gate and the
metered instruction gate are raised with a build-log note, as CLAUDE.md allows.

**Fallback.** The Babylon backend runs no effects and warns once per effect type (0179); sample effects still work
because they are baked.

## Alternatives considered

- **Bus effects only, as today** — the prototype's per-clip and per-playlist chains are central to sequences and
  playlists.
- **Web Audio nodes for effects** — the engine owns its DSP in Rust (0157) so the core and the fallback rule stay the
  same everywhere; mixing Web Audio nodes into the worklet graph would split that.
- **A separate catalogue per level** — the prototype's drift between screens shows the cost; one schema lets an effect
  move from clip to track ("Move to the track") without conversion.

## Consequences

**Positive**
- One effect model across Samples, Playlists, Sequence and Mixer; moving an effect between levels is a list move.
- The profiler's cost-per-level track has a real source.

**Negative / costs**
- Substantial Rust DSP work and core routing (instance submixes), with wire and ABI versions.
- CPU per instance submix; the pool size is a new budget to tune.
- More effects per bus raise the high preset's audio-thread time, already near its budget (0171).

## Deprecates

- The `reverb` send effect type (replaced by returns, 0344) and the four-effect, one-compressor per-bus limits.

## Open questions

- Pitch shift quality versus cost (granular first; a phase vocoder later if needed).

## References

- Prototype effect lists: `Mixer.dc.html` (FXT), `Sequencer.dc.html` (FXDEF), `Playlists.dc.html` (FXT), `File.dc.html`.
- `native/audio/crates/audio-dsp/`, `src/engine/audio/busCapability.ts`, `native/audio/build.mjs` (size gates).

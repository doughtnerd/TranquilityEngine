# 0360. Sound generators are a playlist entry played by a generator voice in the core, and are baked to samples on demand

- **Status:** Accepted
- **Date:** 2026-11-22
- **Deciders:** Chris Carlson
- **Supersedes:** — (amends 0342: the sidecar gains a `generated` block; amends 0343: Clip playlists and sequence clips gain a generator source)
- **Related:** 0010, 0040, 0157, 0179, 0293, 0304, 0306, 0342, 0343, 0345, 0346, 0347, 0348, 0349, 0350, 0351, 0352, 0358

## Context

The owner asked for built-in sound generators (tone, noise, simple synths) as follow-on feature 5, for UI blips and
prototyping, in the order "2 & 4, then 1 & 3, then 5".

**What exists today.**
- Every sound starts from an audio file. A playlist's Clip entry is a `sample` (0343); a sequence clip is a `sample` or
  a `playlist`. `Audio.play(path)` plays a playlist or a sample.
- The core's voice (`audio-core/src/voices.rs`) reads a clip through the 4-point resampler, then gain, fade and mix
  ramps, the voice filters, sends and the panner (equal power, HRTF or a bed). The per-sample read is chosen by the
  clip's format: PCM, or since ABI 4.12 IMA ADPCM decoded as it is read, with per-voice state in its own region
  (`AdpcmCursors`, `max_mixed` entries). Pitch is a per-sample step array (`slot.pitch` × `rate_ratio` × the pitch
  binding). SET_LOOP release is the voice's key-off (ABI 4.3). Time parameters (0346) and AUTOMATE bindings (volume,
  pitch, low-pass, high-pass, pan) run per quantum.
- `audio_dsp::fx` (0345) holds the catalogue's kernels with no allocation and `libm` maths, shared by the core and the
  offline render (`audio-offline`, ABI 1.1, 139,009 B, fetched by the Studio and the export only). It has no
  oscillator, no ADSR in the core (the catalogue's `envelope` is offline-only) and no random source.
- The catalogue's `EffectParamSpec` (name, label, range, step, unit, default, `scale`, and from 0352 `choices` and
  `smooth`) drives the Studio's generated cards, curves (0346) and parse limits (0306).
- Randomness is the World's seeded generator (mulberry32 from `audio.seed` and the World key,
  `runtime/playlists/host.ts`), drawn on the main thread at trigger; takes (0348) record the seed and replay it.
- **Cost reference** (metered gate, `tools/audio-bench/metered/baseline.json`): `automation-base`, 256 looping mixed
  sample voices, is 10,078,557 instructions a quantum, **≈ 39.4k per voice** (≈ 3 µs at the container's 0.075 µs per
  1k instructions). ADPCM decode adds ≈ 19.7k per voice (`adpcm` against its twin).
- **Size:** the mixer is 501,602 B of its 512 KB tripwire (`native/audio/build.mjs`).

**How the reference tools do it.**
- **Wwise:** source plugins in the hierarchy where a sound's audio file would be: *Synth One* (two oscillators, noise,
  a filter, an envelope; parameters on RTPCs), *Tone Generator* (sine, square, triangle, saw, white and pink noise; a
  frequency sweep; an ADSR; fixed length or until stopped), *Silence* (a duration with a random range, a placeholder
  and spacer). All run in real time and are edited in the sound's Source Editor.
- **FMOD:** a *Plug-in instrument* on an event's timeline or a multi-instrument holds the oscillator (sine, square,
  saw up/down, triangle, noise) or another generator DSP; its parameters automate like any DSP's.
- **Unity:** `OnAudioFilterRead` on a script fills buffers on the audio thread (procedural audio by user code);
  `AudioClip.Create` with a PCM reader callback makes a generated clip.
- **Unreal MetaSounds:** generator nodes (Sine, Saw, Square, Triangle, Noise with white and pink, LFO, ADSR, filters)
  in a sample-accurate graph rendered per voice.
- **sfxr / bfxr / jsfxr:** one-shot synthesis for game blips: a square/saw/sine/noise oscillator with frequency slide,
  vibrato, arpeggio, duty sweep, repeat, a phaser, low- and high-pass filters with sweeps and an attack-sustain-punch-
  decay envelope; presets (pickup/coin, laser, explosion, power-up, hit, jump, blip) built from random draws; "mutate";
  exported as WAV. sfxr is MIT-licensed; jsfxr is public domain.

## Decision

We will add **generators** as a source beside samples: a **generator entry** in Clip playlists and a **generator
source** on sequence clips, patched in `*.generator.json` assets or embedded inline, **played in real time by a
generator voice in the core**, and **baked to a sample on demand** through the offline render. Playlists, blends,
sequences, automation, spatial, effects, buses and takes then apply to generators with no special case.

### 1. What a generator is (the choice)

| Option | Parameter-driven | Endless tones | Memory | Runs on the fallback | Verdict |
|---|---|---|---|---|---|
| **Playlist entry kind, real-time core voice** | yes: curves, parameters, pitch | yes | ≈ 0.5–5 KB per playing voice | through an offline render (§8) | **chosen, the default** |
| **Generated sample asset (offline render only)** | no: fixed once rendered | no (a loop of a render) | PCM per variant | yes, like any sample | **kept as "Bake"** (§6) |
| A new playlist type (`type: "generator"`) | yes | yes | as chosen | as chosen | a generator is a *source* like a sample, not a container of entries |

Real time is the default because the uses that need generators most change with the game: a UI hover tone pitched by a
slider's value, an engine or force-field drone on a parameter, a charging laser whose cutoff follows a timer, and a
"tone until stopped" placeholder. Baking is kept for fixed blips that a project wants as files (a sound designer's
hand-off, an export with no generator cost, a Queue of baked variations), the sfxr workflow.

**The asset** `*.generator.json` (`myco.generator@1`), an asset kind with references rewritten on move (0314); an
embedded generator is the same object without `format`:

```jsonc
{
  "format": "myco.generator@1",
  "kind": "blip",                 // oscillator | synth | blip | silence
  "params": { "waveform": "square", "baseFrequency": 0.42, "slide": 0.18, "decay": 0.31 },
                                  // by the generator catalogue (§2); missing params take their defaults
  "seed": 1734,                   // the randomiser's seed (blip presets, §2) and the noise seed; null: drawn per trigger
  "preset": "coin",               // blip and synth: the preset it was made from (display only)
  "vary": 0,                      // blip: 0..1, per-trigger variation drawn from the World's generator
  "note": "Shop purchase"
}
```

**In playlists** (`playlist/types.ts`): `GeneratorEntry extends EntryUse { kind: "generator"; generator: string |
GeneratorBody }`, allowed only in a Clip playlist beside samples (the Studio wraps it in an embedded Clip as it does a
sample); `Clip.generator?: string | GeneratorBody` in sequences (exactly one of `sample`, `playlist`, `generator`).
`EntryUse.curves` and clip `automation` gain targets `gen:<param>` (§4). `Audio.play("ui/coin.generator.json")` plays
a generator as it plays a sample (wrapped in a Clip playlist). No public type changes: generators are driven through
parameters and curves (Wwise's RTPCs), not new handle members. The playlist parse limits stay 0306's.

### 2. The generator set for v1

Parameters are declared in **one generator catalogue** (`src/engine/audio/generators/catalogue.ts`) with the effect
catalogue's `EffectParamSpec` (choices, `scale: "log"`, `smooth`), so curves interpolate log parameters in log space
(0346), choices step, the Studio draws generated rows, and the parse clamps. **The catalogue's order is the wire
order** (the core reads `p[i]`); at most 32 parameters a kind. Times in ms, levels in dB.

- **Oscillator** (Wwise Tone Generator, FMOD oscillator): `waveform` (sine, square, saw, triangle, noise),
  `noiseColour` (white, pink, brown), `frequency` 20–20,000 Hz (log, 440), `pulseWidth` 1–99 % (50; square only),
  `level` −60–0 dB (−12), `attack` 0–5,000 (2), `decay` 0–5,000 (0), `sustain` 0–100 % (100), `release` 0–10,000
  (10), `length` 0–60 s (0 = until released). The 2 ms attack and 10 ms release are click guards.
- **Synth** (a two-oscillator subtractive voice, Synth One's shape): `osc1Wave`, `osc2Wave` (the oscillator's five),
  `osc2Semitones` −24–24, `detune` 0–100 ct (7), `oscMix` 0–100 % (50), `pulseWidth`, `frequency` (220), `filterType`
  (lowpass, highpass, bandpass), `cutoff` 20–20,000 Hz (log, 2,000), `resonance` 0–1 (0.2), `filterEnvAmount` −48–48 st
  (24), filter `attack`/`decay`/`sustain`/`release` (5, 300, 30 %, 300), amp `attack`/`decay`/`sustain`/`release`
  (5, 200, 80 %, 300), `lfoWave` (sine, triangle, square, saw, sample-and-hold), `lfoRate` 0.05–20 Hz (log, 5),
  `lfoDepth` 0–100 % (0), `lfoTarget` (pitch ±2 st, cutoff ±4 octaves, amp, pulse width ±49 % at full depth),
  `level`, `length` — 25 parameters. Presets: Beep, Click, Pluck, Bass, Lead, Pad, Drone, Whoosh (noise through a
  swept band-pass).
- **Blip** (sfxr): sfxr's parameters in **sfxr's own units** (0..1 or −1..1), so sfxr, bfxr and jsfxr settings port:
  `waveform` (square, saw, sine, noise, triangle), `attack`, `sustain`, `punch`, `decay`, `baseFrequency`,
  `frequencyLimit`, `slide`, `deltaSlide`, `vibratoDepth`, `vibratoSpeed`, `arpeggioAmount`, `arpeggioSpeed`, `duty`,
  `dutySweep`, `repeatSpeed`, `phaserOffset`, `phaserSweep`, `lowpassCutoff` (1), `lowpassSweep`,
  `lowpassResonance`, `highpassCutoff`, `highpassSweep`, `level` — 24 parameters. sfxr's mappings are converted from
  its 44.1 kHz period counter to hertz and seconds, so a blip sounds the same at every context rate. The Studio shows
  each in real units beside the knob (Hz, ms, st).
  - **Presets and the randomiser** (`generators/blipPresets.ts`, pure): Coin, Jump, Laser, Hit, Power-up, Blip,
    Explosion, and Random, each sfxr's generator function re-implemented, drawing from **mulberry32 seeded by the
    generator's `seed`**. *Randomise* picks a new seed and re-runs the preset; *Mutate* nudges every unlocked parameter
    from the current values with the same seeded draws; per-parameter locks keep chosen values. The same preset, seed
    and locks always give the same parameters, on every machine. The resolved parameters are what the file stores; the
    seed and preset record how they were made.
  - **`vary`** (0..1): per trigger, each unlocked parameter moves by up to `vary` × 5 % of its range, drawn from the
    World's generator (§7). 0 (the default) plays the stored blip exactly.
- **Silence** (Wwise Silence): `length` 0–60 s (1), `lengthRandom` 0–60 s (0; ± uniform). A placeholder, a spacer in
  a continuous Queue or a sequence, a "nothing this time" pick in a random Queue that still counts as a play (unlike
  `weight` 0 or `chance`).

### 3. The generator voice in the core

**A PLAY variant, not a new voice opcode.** A generator voice is a PLAY of a **reserved generator clip id**
(`GEN_CLIP_ID_FIRST` `0xFFFF0300` + kind: 1 oscillator, 2 synth, 3 blip, 4 silence; the reserved range is never
uploaded and takes no clip memory), so ids, generations, buses, pausing, the mixed/virtual machinery, STOP, FADE,
SET_PARAMS, ROUTE, SET_VOICE_FX, groups and REPLAY need nothing new. Its parameters come in one new record:

- **GEN (`0x21`)**, stamped like any record: `voiceId`, `mask: u32` (parameter i present), `seed: u32`, `rampFrames:
  u32`, then the masked values as `f32` (popcount of the mask). The runtime sends GEN with every parameter set in the
  same batch and frame as the PLAY (as LOOPS rides beside a clip PLAY), and again with a partial mask when a value
  changes. A later GEN glides changed smooth parameters over `rampFrames` (frequencies in log2, as 0345's effects);
  choices and `smooth: false` parameters step. A GEN for a voice that isn't a generator is ignored. A generator PLAY
  with no GEN plays its kind's defaults.
- **AUTOMATE target 5, "generator parameter"**: `target` bits 8–15 hold the parameter index; the curve's value
  replaces the parameter (as 0345's effect-parameter bindings do), per quantum, glided like a GEN change. Time
  parameters (0346) key them like any binding: a sweep over `voiceTime`, a cutoff on a game parameter.
- **State** lives in a new `GenEntries` region, **max(16, `max_mixed` / 4) entries** (64 on the high preset), derived
  from the existing init parameters so `myco_audio_init` is unchanged. An entry (≈ 0.5 KB; 4.6 KB for a blip, whose
  phaser keeps sfxr's 1,024-sample line) holds the parameters, their glides, the oscillator phases, the filter and
  envelope states, the LFO and the noise generator. A generator PLAY takes an entry for the voice's life (mixed or
  virtual); with none free the voice plays silent, keeps time and ends by its envelope, counted in STATUS
  (`genStarved`) and shown in the profiler with the reason "generator pool full", as 0345's submix pool does.
- **ABI 5.1** (minor: a reserved clip-id range, an opcode, a binding target, a region carved from existing
  parameters; no existing record changes layout). The wire schema (`schema/generator.rs`), its hash, the vectors and
  `wire.generated.ts` are regenerated.

**DSP** in a new `audio_dsp::gen` module (no allocation, `libm`, deterministic, shared with the offline render):
- **Band-limited oscillators by PolyBLEP**: saw and pulse (with pulse width) get a two-sample polynomial residual at
  each discontinuity; triangle gets the integrated residual (PolyBLAMP) at each corner, with no leaky integrator to
  drift; sine is a phase accumulator through a polynomial sine. Phase is `f64` per oscillator so long drones keep
  pitch. Residual aliasing is ≈ −40 to −60 dB for fundamentals under 4 kHz, the generators' range in practice.
- **Noise**: xorshift32 seeded per voice; pink by Paul Kellet's seven-pole filter on white; brown by a leaky
  integrator (−6 dB/octave) normalised to the same RMS.
- **Filter**: a topology-preserving state-variable filter (Zavalishin, Simper), low-, high- and band-pass from one
  structure, stable under per-sample modulation; coefficients recomputed every 16 samples while the envelope or LFO
  moves it, at once when settled. The blip keeps sfxr's own low- and high-pass (its sweeps are part of the sound).
- **Envelopes**: the synth's ADSR has a linear attack and exponential decay and release (each reaching 1 % of its
  span at the set time); the blip's is sfxr's attack–sustain–punch–decay, linear.
- **Mono output.** A generator voice is a mono voice (`panner.channels` 1), so spatial, HRTF, beds, spread and zones
  treat it as any mono sample.

**How it plays.**
- **Pitch** multiplies every frequency: the render passes the voice's per-sample step array (the PLAY pitch ×
  SET_PARAMS pitch × the pitch binding; `rate_ratio` is 1) to the oscillators, so the playlist's `pitch`,
  `pitchRandom`, entry pitch curves, quantised pitch lanes (0353) and Doppler transpose a generator as they do a
  sample. The blip's slide and arpeggio are relative to it.
- **The render branch** is a third source beside PCM and ADPCM in `render_voice`: a mixed generator voice fills its
  `l` buffer from `gen::render` instead of the resampler, then runs the same chain (gain, fade, mix, filters, sends,
  automation, pan, panner). A **virtual** generator voice advances only its envelopes and its clocks (no oscillator or
  filter work); a promote resumes from there with 0157's 5 ms fade-in.
- **Length and end.** A generator with `length` > 0 keys itself off at that time (in the core, sample-exactly). The
  voice ends when its amp envelope reaches silence after key-off, or for a blip at the end of its envelope. With
  `length` 0 an oscillator or synth sounds until released or stopped.
- **Loops.** PLAY's loop flag means *endless*: a looping generator simply runs (no wrap, no seam) until key-off or
  stop. Sample loops and LOOPS programs don't apply. A blip with the loop flag re-triggers at its end (sfxr's
  repeat, endless).
- **Release** is SET_LOOP release, the voice's key-off since ABI 4.3: the amp and filter envelopes enter release, so
  `handle.release()`, a sequence clip's end and an `untilStopped` playlist's release all work unchanged; STOP fades
  as for any voice. A sequence generator clip keys on at its start and off at its end, and its release rings past the
  clip like a note.
- **Silence** is always virtual: main's selection never promotes it (as for a paused voice), so it costs the O(1)
  virtual path, keeps time, reports its end and lets queues, sequences and the trigger gate count it.
- **Routing**: generators play through buses, instance and level submixes (ROUTE), sends, returns, snapshots on their
  buses, ducking and beds exactly as sample voices do. Voice-level catalogue effects apply as to any voice.
- **The adaptive cap** weighs a generator voice by its kind's work units (oscillator ≈ a sample voice, synth ≈ 1.2×,
  silence 0) so a scene of synths sheds voices before it runs late.

**Cost**, estimated from the kernels' operation counts and to be measured in G2 against the sample voice:

| Per mixed voice per quantum | Estimate | Against `automation-base`'s 39.4k |
|---|---|---|
| Sample voice (resampler read ≈ 4.5k of it) | 39.4k | 1.00 |
| Oscillator (sine; PolyBLEP saw ≈ +1k) | ≈ 37–40k | ≈ 1.0 |
| Oscillator, pink noise | ≈ 39k | ≈ 1.0 |
| Synth (2 PolyBLEP oscillators, SVF with 8 coefficient updates, 2 envelopes, LFO) | ≈ 45k | ≈ 1.15 |
| Blip (sfxr kernel, phaser on) | ≈ 43k | ≈ 1.1 |
| Silence (virtual) | as a virtual voice | — |

G2 adds metered scenes `gen-osc` (256 looping saw oscillators), `gen-noise` (256 pink), `gen-synth` (128 synths with
an LFO on the cutoff), `gen-blip` (256 blips retriggered at 200 a second) and `gen-silence` (4,096 silences), each
reported against its sample twin (`automation-base`, `pitch4`, `default`) in a `GEN_PAIRS` table as the ADPCM pairs
are; the record's table is then replaced by the measured numbers. **Tripwire:** a generator kind costing more than
1.5× its twin per voice is logged and raised with the owner (CLAUDE.md: a tripwire, not a design limit). The kernels
add an estimated 10–15 KB to the mixer, which may pass the 512 KB tripwire (≈ 22.7 KB left); if so it is raised with a
build-log line, not traded for quality.

### 4. Parameters, curves and automation

- `EntryUse.curves["gen:<param>"]`: a voice curve over voice time or a parameter (0346), sent as an AUTOMATE target 5
  binding. Log parameters interpolate in log space; a choice parameter takes step keys only (linted
  `genCurveNotStep`). `quantize` (0353) works on them as on any voice curve.
- Sequence clips with a generator source take `gen:<param>` automation over clip or sequence time.
- Instance-level automation (`PlaylistBody.automation`) doesn't take `gen:` targets (it acts on the instance, not a
  voice; linted `genTargetIgnored`).
- **Snapshots** override bus and return effects (0344), so they reach a generator through its bus; they don't set a
  generator's own parameters in v1 (a parameter-driven curve does that).
- Lints: `generatorNeverEnds` (a one-shot playlist playing an endless generator with no length), `genTargetUnknown`
  (a target its kind doesn't have), `generatorClipNoLength` (an endless generator in a sequence clip of length 0).

### 5. The runtime

The playlist runtime resolves a generator entry when it is picked: it reads the patch (linked asset or embedded),
applies `vary` and draws the noise seed and silence length from the World's generator (§7), and sends PLAY (reserved
id) + GEN + AUTOMATE (its curves) as one stamped group, like a sample voice's PLAY + LOOPS + AUTOMATE. Main's voice
table keeps the generator kind for selection, the cap weight, `Audio.debug()` voice rows ("Generator · synth") and
captures. REPLAY after a hard rebuild re-sends GEN with every parameter at its current value. Hot reload of a
`*.generator.json` sends a GEN to its playing voices (a 20 ms glide), as playlist hot reload does for curves.

### 6. The offline path: Bake to sample

- `audio-offline` gains `myco_offline_generate(spec, specLen)` (its **ABI 1.2**): a generator spec (kind, resolved
  parameters, seed, context rate, key-off time, total length, time-keyed parameter and pitch lanes) rendered by the
  same `audio_dsp::gen` kernels, then, when the spec carries effects, through the existing baked-effect render (0342,
  0345). At pitch 1 with no automation the offline output is **bit-identical** to the core voice's mono signal before
  its gain (a golden test on both builds).
- **Bake** writes `<name>.baked.wav` beside the generator (32-bit float, mono, 48 kHz; `<name>.baked2.wav` if taken)
  and its sidecar with a `sample` block (kind `oneshot`; root note from the frequency; an endless generator baked
  with a chosen length gets kind `loop` and one loop crossfaded over its last 50 ms) and a new **`generated`** block,
  optional, in `myco.import@1` (amending 0342 and 0040):
  `"generated": { "generator": "audio/ui/coin.generator.json", "hash": "<sha256 of the resolved patch>", "seed": 1734,
  "variation": 0 }`. The Samples screen shows "Baked from coin.generator.json" and "out of date" when the patch's hash
  differs, with **Rebake**.
- **Bake variations** renders N files from seeds `seed`, `seed + 1`, … (the blip randomiser's draws, or `vary` for
  other kinds) and optionally a Queue playlist (random, avoid-repeat 1) over them, the classic sfxr variety workflow.
- **Replace uses** (an option in the Bake dialog) points the playlist entries that use the generator at the baked
  sample, one undo step per file.
- Generators aren't converted at export (they are JSON); baked samples are samples and follow 0351's encoding.

### 7. Determinism: seeds and takes

- The **blip randomiser** draws from mulberry32 seeded by the generator's `seed`: authoring is repeatable and the file
  stores the result.
- **Per-trigger draws** (the noise seed when `seed` is null, `vary`, silence's `lengthRandom`) come from the World's
  seeded generator on the main thread at pick time, in pick order, like Queue picks (0343). A take (0348) records the
  World's seed and the triggers, so a replay plays the same noise, variations and silences. A generator with a fixed
  `seed` plays the same noise every time.
- The core's noise is xorshift32 from the GEN seed; the same seed and parameters give the same samples in the core,
  the offline render and the fallback's render (§8).

### 8. The Babylon fallback

The fallback (0179) has no core. When it plays a generator it renders it with the offline module at the trigger's
parameter values (a finite generator to its end; an endless one 2 s, looped with a 50 ms crossfade), caches the render
by the patch's hash and seed, and plays it as a clip; parameters and curves don't follow during playback, with one
warning per session. The offline module is fetched only on the fallback and only by a build whose project contains
generators. The fake backend records generator PLAYs and GENs for runtime tests.

### 9. The Studio

Generators are edited **inside the Playlists screen**, as Wwise edits a source plugin in the sound's Source Editor and
FMOD a plug-in instrument in the event, not on a screen of their own: a generator is a source that playlists use.
- The **library** lists `*.generator.json` beside playlists (a generator icon and kind badge); **New > Generator**
  (Oscillator, Synth, Blip, Silence), **Add > Generator** in Clip playlists and sequence clips, and drag from the
  library. Selecting a generator, or an embedded generator entry, opens the **Generator editor** in the main area.
- **Generator editor** (0349 kit, theme tokens): the parameters as generated rows from the generator catalogue, grouped
  (Oscillators, Filter, Envelopes, LFO; for blips sfxr's groups) with real-unit readouts; a **waveform preview** of the
  first 2 s (or to the end) from the offline render in a worker, redrawn after edits with the amp envelope overlaid;
  the **preset** menu; for blips **Randomise**, **Mutate**, a **seed** field, per-parameter locks and the `vary`
  slider; **Audition**: Play, and hold Space (or the Play button) to gate, release to key off, through the Studio's
  runtime so buses and effects apply; a one-octave keyboard for oscillator and synth that transposes from
  `frequency`; and **Bake…** (length for endless ones, variations, folder, Queue, Replace uses). Every edit is one undo
  step; Randomise and Mutate are one step each.
- Voice curves on `gen:` targets use the shared curve editor (0346) with the parameter's unit and scale.
- The Profiler's voice rows and the effects-cost track show generator voices by kind.

## Alternatives considered

- **Generated sample assets only (offline)** — no runtime cost and works on the fallback, but nothing follows the
  game, endless tones become loops, and every variation is PCM; kept as Bake.
- **A playlist type `generator`** — would make a source into a container and duplicate Clip's role; an entry kind
  keeps "wrap in a Clip" uniform with samples.
- **Inline patches only (no asset)** — no library, no reuse, no `Audio.play(path)`; linked and embedded mirror
  playlists.
- **A new PLAY_GEN opcode with the parameters in it** — a second voice-start path through REPLAY, groups and stamping;
  the reserved-id PLAY plus GEN reuses all of it, as LOOPS does.
- **Generator state in the voice slot** — the 192-byte slot is full; a pool keeps 4,096 logical slots unchanged.
- **minBLEP** — cleaner at high fundamentals, but needs a table and a per-oscillator ring; PolyBLEP is table-free and
  enough under 4 kHz. **Oversampling** (sfxr's 8× supersampling) costs ≈ 8× per oscillator.
- **Generators as plugins** (0352's ABI with no input; Unity's `OnAudioFilterRead`) — user-written sources are a
  later record; built-ins must work with no plugin, on the core's own budget.
- **A JS `AudioWorkletNode` or main-thread synthesis into a stream** — outside the core: no buses, sends, spatial or
  submixes, GC on the audio thread, engine-dependent maths.
- **A MetaSounds-style node graph** — far larger than "tone, noise, simple synths"; a later record could build one on
  `audio_dsp::gen`.
- **The `fundsp` crate** — a capable graph DSP library, but it allocates nodes at build time, would add size to a
  mixer near its tripwire, and doesn't port sfxr; the kernels needed here are a few hundred lines.

## Consequences

**Positive**
- UI blips and prototype sounds with no audio files, driven by game parameters, through every playlist, sequence,
  spatial, effect and mix feature.
- sfxr-style blips with repeatable seeds, and a path from a generator to an ordinary sample file.
- Deterministic in takes, the core, the offline render and the fallback.

**Negative / costs**
- ABI 5.1 and wire work (an opcode, a binding target, a region), regenerated vectors and goldens; the mixer grows
  ≈ 10–15 KB and may need its tripwire raised.
- A generator pool to size (64 entries on high, ≈ 32–300 KB depending on kinds); a full pool plays silent.
- The fallback renders instead of synthesising: parameters don't follow there, and games with generators ship the
  offline module (139 KB, fetched only on the fallback).
- Band-limited blips sound slightly cleaner than sfxr's aliased originals.
- Mono only in v1: no stereo detune spread.

## Deprecates

Nothing.

## Open questions

- Stereo generators (detune spread, a stereo noise bed) and an `audio.json` setting for the pool size (needs an init
  parameter, a major ABI change).
- Hard sync, FM and wavetables for the synth; a MetaSounds-style graph.
- Generator plugins on 0352's ABI.
- Snapshot overrides of generator parameters.

## References

- Audiokinetic Wwise: Synth One, Tone Generator and Silence source plugins; FMOD Studio: plug-in instruments and the
  oscillator DSP; Unity: `OnAudioFilterRead`, `AudioClip.Create`; Unreal Engine: MetaSounds generator nodes; sfxr
  (DrPetter, MIT), bfxr, jsfxr; Välimäki and Huovilainen, "Antialiasing oscillators in subtractive synthesis" (PolyBLEP);
  Zavalishin, *The Art of VA Filter Design* (TPT SVF); Paul Kellet's pink noise filter.
- `native/audio/crates/audio-core/src/voices.rs` (`render_voice`), `adpcm_voice.rs`, `layout.rs`, `automation.rs`;
  `audio-dsp/src/fx/mod.rs`; `audio-offline/src/lib.rs`; `audio-wire/src/schema/`; `audio-wasm/src/lib.rs` (ABI);
  `src/engine/audio/playlist/types.ts`, `effects/catalogue.ts`; `src/plugins/audio/runtime/playlists/host.ts` (World
  generator); `tools/audio-bench/metered-gate.mjs`, `metered/baseline.json`; `native/audio/build.mjs` (size gates).

## Build plan

| # | Milestone | Contents | Files (owner) |
|---|---|---|---|
| G1 | Format | `myco.generator@1` types, parse and write (lenient, 0306 limits), the generator catalogue in wire order, blip presets and the seeded randomiser and mutate, synth presets, `vary` and resolve (pure, given a draw function); `GeneratorEntry`, `Clip.generator`, `gen:` targets in the playlist format and lint; the `generator` asset kind with reference rewriting; the sidecar `generated` block; unit tests (round trip, clamps, presets and seeds stable across runs, lints) | `src/engine/audio/generators/**`, `src/engine/audio/playlist/{types,format,lint,references}.ts`, `src/engine/scene/importSettings.ts`, the asset-kind registration |
| G2 | Core and wire | `audio_dsp::gen` (PolyBLEP/BLAMP oscillators, noise colours, TPT SVF, ADSRs, LFO, the sfxr kernel) with native tests (spectra under the aliasing bound, pink and brown slopes, envelope times, determinism); `audio-core/src/generator.rs` (`GenEntries` region, GEN apply, the render branch, virtual advance, key-off and length, target 5); ABI 5.1; schema `generator.rs`, regenerated vectors and `wire.generated.ts`; bench scenes, `GEN_PAIRS`, baseline; size and build-log notes | `native/audio/crates/audio-dsp/src/gen/**`, `audio-core/src/{generator,voices,layout,automation}.rs`, `audio-wire/**` (wire single writer for the wave), `audio-wasm/src/lib.rs`, `audio-bench/**`, `tools/audio-bench/{metered-gate.mjs,metered/**}`, `native/audio/build.mjs` (gate note), `src/plugins/audio/runtime/wire.generated.ts`, the committed wasm |
| G3 | Runtime | generator entries and sequence clips in the playlist runtime (PLAY + GEN + AUTOMATE groups, World-generator draws, release, hot reload, REPLAY); silence forced virtual in selection; cap weights; `Audio.play` of a generator path; fake-backend recording; `Audio.debug()` and capture voice kinds; tests on the fake backend and loopback tests through the core (a sine's level and pitch, key-off ends the voice, seeds replay) | `src/plugins/audio/runtime/playlists/**`, `runtime/core/{selection,voiceTable,commandWriter,replay,coreBackend}.ts`, `backend.ts`, `testing.ts`, `debugTypes.ts`, `capture/**`, `Audio.ts` |
| G5 | Offline and bake | `myco_offline_generate` (offline ABI 1.2) with the bit-identity golden against the core; `generators/generatorRender.ts`; bake writer (WAV, sidecar, `generated`, variations, Queue, replace uses); the Babylon fallback's render-and-cache path and lazy module fetch; export plan includes the offline module when a project has generators | `native/audio/crates/audio-offline/**`, `src/engine/audio/sample/wasm/`, `src/engine/audio/generators/{generatorRender,bake}.ts`, `src/plugins/audio/runtime/babylonBackend.ts`, `src/export/webBuild.ts` |
| G4 | Studio | Playlists library entries and New/Add Generator; Generator editor (generated rows, groups, waveform preview worker, presets, Randomise/Mutate/seed/locks/vary, audition with gate and keyboard, Bake dialog); `gen:` curves; Samples inspector provenance and Rebake; Profiler kinds; stories with `play` tests | `src/studio/screens/playlists/generator/**`, `src/studio/screens/playlists/{LibraryList,AddDialog,addDialogModel,libraryModel,PlaylistInspector,voiceCurves}.ts(x)`, `src/studio/screens/samples/InspectorPanel.tsx`, `src/studio/screens/profiler/**` |
| G6 | Docs and e2e | `docs/wiki/guide/sound-generators.md`, a Generators section in `playlists.md`; e2e: Studio makes a Coin blip, Randomise with a fixed seed gives the same parameters after reload, audition reaches the bus meter, Bake writes the WAV and sidecar with `generated`; a runtime spec plays a generator through `myco` and its handle's release ends it; `@slow` an exported web build plays a generator | `docs/wiki/guide/**`, `tests/e2e/audio-generators.spec.ts` |

G1 and G2 run in parallel (the parameter order is fixed by §2 and the catalogue G1 writes; G2 reads the same order).
G3 needs G1 and G2; G5 needs G1 and G2; G4 needs G1, G3 (audition) and G5 (preview, bake); G6 last. The wire schema,
`audio-wasm/src/lib.rs` and `native/audio/build.mjs` have one writer per wave.

## Owner decisions (each with the default this record builds)

1. **Where generators are edited:** inside the Playlists screen (**default**) or a Generators screen of their own.
2. **sfxr fidelity:** band-limited blips (**default**) or an extra "Retro (aliased)" choice that reproduces sfxr's
   aliasing.
3. **Fallback:** render through the offline module (**default**; +139 KB fetched only on the fallback) or play nothing
   with a warning.
4. **Channels:** mono generator voices (**default**) or stereo synths with detune spread (more cost, a wider pool
   entry).
5. **Pool size:** derived, max(16, `max_mixed` / 4) (**default**, no init change) or an `audio.json` setting (an ABI
   major bump).
6. **Snapshots:** no generator-parameter overrides in v1 (**default**) or snapshot targets on generator parameters.
7. **Automatic bake at export** for generators nothing drives: no, Bake stays explicit (**default**), or yes.
8. **Bake format:** 32-bit float mono at 48 kHz (**default**) or 24-bit PCM at the project's rate.

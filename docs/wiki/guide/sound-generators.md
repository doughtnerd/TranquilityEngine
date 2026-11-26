# Sound generators

A **sound generator** (`*.generator.json`, [ADR 0360](../../decisions/0360-sound-generators-are-a-playlist-entry-played-by-a-core-generator-voice-and-baked-to-samples-on-demand.md)) makes a sound from parameters instead of a recording: a test tone, a UI beep pitched by a slider, an engine drone on a parameter, an sfxr-style coin or laser, or a stretch of silence. It plays like a sample: from a script, in a playlist, on a sequence clip, through buses and effects. When you want files instead (to hand to a sound designer, or for a build with no generator cost), **Bake** renders it to samples.

You make and edit generators in the **Audio Studio**, on the **Playlists** screen: generators sit in the library beside playlists.

## Kinds

| Kind | What it is | Use it for |
|---|---|---|
| **Oscillator** | One waveform (sine, square, saw, triangle, or noise: white, pink or brown) with an ADSR envelope | test tones, hums, placeholders, noise beds |
| **Synth** | Two oscillators through a resonant filter, with a filter envelope, an amp envelope and an LFO | plucks, basses, pads, drones, whooshes |
| **Blip** | sfxr's synthesiser, with sfxr's own parameters | retro game sounds: coins, jumps, lasers, hits, power-ups |
| **Silence** | Nothing, for a length | a spacer in a Queue or a sequence, a "nothing this time" pick that still counts as a play |

A generator is mono, so spatial sound, HRTF and attenuation treat it as a mono sample.

## Parameters

Selecting a generator in the library, or a Clip whose source is one, opens the **Generator editor**: every parameter as a row, grouped (Oscillators, Filter, Envelopes, LFO; for blips sfxr's groups), with its value in real units (Hz, ms, st, dB).

- **Oscillator**: `waveform`, `noiseColour`, `frequency` (20 Hz–20 kHz, 440), `pulseWidth` (square only), `level` (−60–0 dB, −12), `attack`, `decay`, `sustain`, `release`, `length`. The default 2 ms attack and 10 ms release keep it from clicking.
- **Synth**: the two oscillators' waves, oscillator 2's pitch (±24 st) and `detune`, their mix, `pulseWidth`, `frequency` (220); the filter (`filterType` low-, high- or band-pass, `cutoff`, `resonance`, `filterEnvAmount` ±48 st and its own ADSR); the amp ADSR; the LFO (`lfoWave` sine, triangle, square, saw or sample-and-hold, `lfoRate` 0.05–20 Hz, `lfoDepth`, and `lfoTarget`: pitch ±2 st, cutoff ±4 octaves, amp, or pulse width ±49 % at full depth); `level`, `length`.
- **Blip**: sfxr's parameters in sfxr's units (0..1, or −1..1 for slides and sweeps), so settings from sfxr, bfxr and jsfxr carry over: `waveform`, the attack–sustain–punch–decay envelope, `baseFrequency` and `frequencyLimit`, `slide` and `deltaSlide`, vibrato, the arpeggio (`arpeggioAmount`, `arpeggioSpeed`), `duty` and `dutySweep`, `repeatSpeed`, the phaser, the low- and high-pass filters and their sweeps, and `level` in dB. A blip sounds the same at every sample rate.
- **Silence**: `length` and `lengthRandom` (± that much, drawn per play).

**Length.** An oscillator or synth with `length` 0 sounds **until it is released** (a handle's `release()`, the end of a sequence clip, an `untilStopped` playlist's release), then plays its release. With a length it keys itself off at that time. A blip ends with its envelope.

**The waveform preview** under the parameters shows the first 2 s of the sound (or all of it, when it is shorter) with its amp envelope drawn over it and a line where it keys off. It is rendered by the same code that plays the sound, so what you see is what you hear. It redraws a moment after each edit.

Every edit is one undo step; dragging a knob is one step.

## Presets, Randomise, Mutate and the seed

The **preset** menu fills the parameters from a starting point:

- **Blip**: Coin, Jump, Laser, Hit, Power-up, Blip, Explosion and Random, each sfxr's own generator.
- **Synth**: Beep, Click, Pluck, Bass, Lead, Pad, Drone and Whoosh.

For blips:

- **Randomise** picks a new seed and runs the preset again, so you get another coin, another laser.
- **Mutate** nudges every parameter a little from where it is now.
- The **seed** is what Randomise and Mutate draw from. The same preset, seed and locks give the same sound on every machine, so you can type a seed back in to get a sound again. The file stores the resulting parameters; the seed and preset only record how they were made.
- **Locks.** The lock beside a parameter keeps it through presets, Randomise and Mutate (locks aren't saved).
- **Vary** (0..1) changes the sound on each play: every parameter moves by up to `vary` × 5 % of its range, drawn from the World's random generator, so a take replays the same variations. 0 plays the stored blip exactly.

The seed also seeds the noise. A blank seed draws new noise on every play.

## Quality

Oscillators, synths and blips have a **Quality** parameter:

- **Standard** (the default) smooths each waveform edge over two samples. It is cheap; some aliasing remains at high pitches (a bright, slightly metallic edge above a few kHz).
- **High** uses a longer band-limited edge. It aliases far less and stays flat to about 14 kHz, at more CPU: roughly 7–12 % more per voice in the engine's cost benchmarks, and the signal is two samples later.

Use High for bright saws and squares played high, or anything you will bake; Standard is fine for most game sounds. Sine and noise don't alias either way.

## Audition

**Play** in the editor plays the generator through the Studio's runtime, so its bus, effects and snapshots apply. **Hold Play, or hold Space**, to gate it: it keys on while held and releases when you let go, which is how you hear an endless tone's release. For oscillators and synths a **one-octave keyboard** plays the generator transposed from its `frequency`; the computer keys under it work too. Editing while it plays changes the sound at once.

## Bake

**Bake…** renders the generator to samples beside it (a generator file only; an embedded one has no file to bake beside, and a silence has nothing to bake). The dialog asks for:

- **Length** (endless generators only): how many seconds to render. The sample becomes a loop: the attack plays once, then a loop crossfaded over 50 ms.
- **Variations**: how many files. Variation 1 is the generator exactly; the others use seeds `seed + 1`, `seed + 2`, … (a blip is mutated with each seed; other kinds apply `vary`).
- **Folder**: where the files go (default: beside the generator).
- **Make a Queue playlist** (several variations): also writes a random Queue (avoid-repeat 1) over them, the classic sfxr way to get variety.
- **Replace uses**: points the playlists and sequence clips that play the generator at the baked sample (or at the Queue where a playlist fits), dropping their `gen:` curves. One undo step per file.

Each bake writes `<name>.baked.wav` (`<name>.baked2.wav`, … when taken): 32-bit float, mono, 48 kHz, with a sidecar that has a `sample` block (one-shot or loop, the root note from the frequency) and a `generated` block naming the generator, its patch hash, seed and variation.

On the **Samples** screen a baked sample's inspector says **Baked from coin.generator.json** (click to open the generator). When the generator has changed since, it says **out of date** and offers **Rebake**, which renders that sample's variation again from the generator as it is now, over the same file.

Baked samples are ordinary samples: they export, encode and stream like any other. Generators themselves are small JSON files and aren't converted at export.

## Playing one from a script

```ts
import { Audio } from "myco";

Audio.play("audio/ui/coin.generator.json");                    // as a one-sample Clip playlist would play it
const hum = Audio.play("audio/ambience/hum.generator.json", { bus: "Ambience", volume: 0.5 });
hum.release();                                                 // an endless tone plays its release, then ends
```

`Audio.play` takes the same options and returns the same `AudioPlaylistHandle` as for a sample or a playlist. There are no generator-specific members: drive a generator's parameters with `gen:` curves keyed on parameters (below), and set those parameters with `handle.setParameter` or `Audio.setParameter`.

## In playlists and sequences

- **Clip playlists**: a generator is an entry beside samples (**Add > Generator**, or drag it from the library). In other playlist types the Studio wraps it in an embedded Clip, as it does a sample. An entry links a generator file or holds an embedded one (**New generator > New … in "<playlist>"**).
- Everything an entry has applies: `volume`, `pitch` and its curves (pitch transposes every frequency, a blip's slide and arpeggio included), weights, Blend positions, buses, effects, spatial settings.
- **Sequences**: a generator clip sits on an audio track. It keys on at the clip's start and off at its end, and its release rings past the clip like a note. Adding one makes the clip as long as the sound (2 s for an endless one).
- **Silence** in a random Queue is a pick that plays nothing but still counts as a play (unlike `weight` 0).

Lints catch the usual mistakes: an endless generator in a one-shot playlist (`generatorNeverEnds`), an endless one in a sequence clip of length 0 (`generatorClipNoLength`), a curve on a parameter the kind doesn't have (`genTargetUnknown`), a `gen:` lane where no generator plays (`genTargetIgnored`), and a curve on a choice such as `waveform` with keys that aren't steps (`genCurveNotStep`).

## `gen:` curves

A generator's parameters can follow a curve, as the gain or low-pass does: the target is `gen:` and the parameter's name.

```jsonc
"curves": {
  "gen:cutoff": { "input": { "parameter": "Charge" }, "curve": [[0, 300], [1, 6000]] },   // a charging laser opens up
  "gen:frequency": { "input": "voiceTime", "curve": [[0, 220], [0.5, 880]] }             // a rising sweep
}
```

- On an entry's voice curves (keyed on voice time or a parameter), and as `gen:` lanes in a sequence generator clip's automation (clip or sequence time).
- Log parameters (frequencies, `lfoRate`) interpolate in log space, so a sweep rises evenly by octaves. Choices (`waveform`, `filterType`) take step keys only.
- `quantize` works on them as on any voice curve.
- A playlist's own automation and snapshots don't reach a generator's parameters (snapshots still shape its bus).

In the Studio, `gen:` curves use the usual curve editor, with the parameter's unit and scale.

## On the Web Audio fallback

The Babylon fallback (see [Playing sound](playing-sound.md#which-backend-plays)) has no generator voice. It plays each generator as a **pre-rendered sample**, made when the generator is first triggered: a finite one to its end, an endless one 2 s looped with a 50 ms crossfade. Renders are cached by patch and seed. **Parameters and `gen:` curves don't follow while it plays**, so a cutoff on a parameter stays where it was at the trigger; the console says so once per session. Volume, buses and the fallback's own spatial handling still apply. The renderer is fetched only by builds whose project contains generators, and only when the fallback plays one. For a sound that must change live on every backend, use the audio core (the default).

# Playlists

A **playlist** (`*.playlist.json`, ADR 0343) is how a sound is authored as data: variations, layers, a parameter that picks or blends what plays, held loops, timelines and music. You build playlists in the **Audio Studio** (Playlists screen; the Sequencer for sequences) and play them from a script or an `AudioSource`. A plain audio file plays the same way.

Playlists replace the old audio events (`*.audioevent.json`, ADR 0158) and music events (ADR 0166). Opening a project that still has old event files in the editor or the Audio Studio offers to migrate them once; `npm run audio:migrate -- <project folder>` does it from the command line. The engine, exports and the dedicated server refuse an old event file with a message naming the migration. Music on playlists is in [Interactive music](interactive-music.md).

## Playing one

```ts
import { Audio, AudioSource } from "myco";

Audio.play("audio/footsteps.playlist.json");                         // a playlist
Audio.play("sfx/click.wav", { volume: 0.5 });                         // a sample, as a one-sample Clip playlist
const engine = Audio.play("audio/engine.playlist.json", {
  bus: "Engine",                       // override the playlist's output
  parameters: { RPM: 0 },              // initial values of its local parameters (labelled ones by label)
  position: car.worldPosition,         // a spatial playlist plays here
  volume: 1, pitch: 1, priority: 128,  // multipliers and the voice priority
  at: Audio.time + 0.5,                // start at a time on the audio clock
  offset: 2,                           // start as if 2 s had played
});
```

`Audio.play` never throws and always returns an `AudioPlaylistHandle` (an inert one, `playing` false, when nothing played: a missing file, a trigger the playback rules refused, an old event file; `Audio.debug().playlistTotals.refused` counts why):

```ts
engine.setParameter("RPM", 0.8);   // a local parameter; Audio.setParameter sets a global one
engine.getParameter("RPM");
engine.release();                  // let held loops go by their exit settings (an engine's tail plays)
engine.stop();                     // fade everything out over 120 ms (stop(seconds) picks the fade)
engine.fade(0.5, 1);               // this instance's own volume, 0..4, over 1 s
engine.playing; engine.reason; engine.position; engine.panner; engine.occlusion;
engine.trigger("hit");             // a stinger (Interactive music)
engine.onMarker("cue", (e) => {}); // Cue, Exit and Hit markers passing: { type, name, sample, time }
engine.music;                      // the musical clock, when the playing entry has a tempo (Interactive music)
engine.pause();                    // hold it where it is; engine.paused is true until resume() or stop()
engine.resume();                   // continue from exactly where it held
```

`pause()` holds the whole playback: its voices, the sequence playhead and musical clock, its pending picks and the
starts and fades it has planned. `resume()` continues it from the same position, sample-exact on the audio core;
everything it had planned plays as much later as the pause lasted, and `music`, markers and beat callbacks hold with it.
A pause lands at the earliest exact point (a frame or two after the call), and the sound fades out over 5 ms into it and
back in over 5 ms when it continues. What the playlist had already scheduled for later (a sequence plans a little
ahead: the next clip, a cut or a crossfade) waits with it and lands as much later as the pause lasted. Pausing twice or resuming a
playlist that isn't paused does nothing; `stop()` stops a paused playlist at once. Parameter changes made while it is
paused take effect when it resumes.

`AudioEventHandle` is still exported as a deprecated alias of `AudioPlaylistHandle` for one release.

An `AudioSource` whose `clip` is a playlist plays it as an instance: `volume` and `pitch` apply on top, a spatial playlist follows the node, `minDistance`/`maxDistance` stretch its attenuation, and `play()`, `stop()`, `pause()` (the playback pause above; a deactivated node pauses it), `resume()`, `release()`, `setParameter` and `getParameter` reach the instance. A behaviour on the node hears the playlist's markers in `onAudioMarker(e)` and its beats in `onMusicBeat`/`onMusicBar`.

## Global parameters

Global parameters (the Audio Studio's Parameters, stored in `audio.json`) are shared by every playlist and by the mix: `Audio.setParameter("Surface", "Gravel")`, `Audio.getParameter("Surface")`. Numeric ones have a range and a seek speed (the value glides toward a new target); labelled ones are a state and jump.

## The file

```jsonc
{
  "format": "myco.playlist@1",
  "type": "queue",                 // clip | queue | switch | blend | layer | sequence
  "output": "SFX",                 // a bus; null: the referencing playlist's, else Master
  "playback": { "plays": "oneShot", "maxInstances": 4, "whenFull": "stealOldest", "cooldown": 0.05, "chance": 1, "delay": 0, "priority": 128 },
  "volume": 0, "pitch": 0, "volumeRandom": [-3, 0], "pitchRandom": [-1, 1],   // dB and semitones
  "parameters": [{ "name": "RPM", "min": 0, "max": 1, "default": 0, "seekSpeed": 1.5 }],
  "entries": [
    { "embedded": { "type": "clip", "entries": [{ "sample": "audio/step-1.wav" }] } },
    { "playlist": "audio/shared/step-extra.playlist.json", "weight": 2 }
  ],
  "queue": { "pick": "random", "avoidRepeat": 1, "continuous": null }
}
```

Entries are always playlists: an **embedded** one belongs to its parent, a **linked** one (`"playlist": path`) is shared. Only a Clip playlist holds samples. Each entry use carries `volume` (dB), `pitch` (semitones), `weight` (a random Queue's, 0 never plays), `x`/`y` (its Blend position) and `curves` (gain, pitch, pan, low-pass and high-pass over voice time or a parameter). Down the tree gains add in dB and pitch in semitones.

| Type | What it does |
| --- | --- |
| **Clip** | One sample. Its loops come from the sample's sidecar (the Samples screen); `loop: "on"` loops the trimmed region until released, `"off"` never loops. |
| **Queue** | Picks one entry per trigger: `random` (weighted, skipping the last `avoidRepeat`), `shuffle` (a deck) or `roundRobin`. `continuous: { gapMs, shape }` plays entries back to back until stopped (a negative gap crossfades, in `shape`: a fade shape, default `equalPower`, see Interactive music). |
| **Switch** | A labelled parameter picks the entry (`map`: label → entry index). A change follows `onChange` or the best-matching rule (see Interactive music). |
| **Blend** | One or two scalar axes (a parameter, or voice time) place the entries; `crossfade` or `layer`, linear or equal power, `follow` glides the input or `hold` samples it at the trigger, and an optional ADSR envelope. Entries can carry a region (1D) and a weight curve (below). |
| **Layer** | Plays every entry together. |
| **Sequence** | A timeline of audio and playlist tracks with clips, loops, hold points, markers and automation (the Sequencer). |

**Blend regions and weight curves** (ADR 0350). By default a 1D entry is full only at its `x` and crossfades out to its
neighbours' positions (`layer`: it ramps in from the previous one and stays). Like an FMOD instrument on a parameter
sheet or a Wwise blend-track range, an entry can instead say where it plays:

```jsonc
{ "embedded": { ... }, "x": 0.5, "region": { "start": 0.05, "end": 0.95, "fadeIn": 0.4, "fadeOut": 0.4, "shapeOut": "sCurve" } }
```

Its weight is 0 outside `[start, end]`, ramps up over `fadeIn` and down over `fadeOut` (axis units), 1 between, so
neighbours overlap where their regions do, and a layer can end. The fades' shapes default to the blend's `curve`
(`equalPower` → sin/cos); `crossfade` and `layer` only change how regions are derived for entries without one. In the
Studio's lane each region is a trapezoid with handles for its edges and fade widths (drag, or ← → with Shift ×10);
"Reset to automatic" clears it. A **weight curve** (`"weightCurve": [[0, 0], [0.4, 0], [1, 1]]`) maps an entry's raw
weight (0..1) to its gain: in 2D, where regions don't apply, it narrows or shapes an entry's reach (an equal-power 2D
blend is normalised to constant power); in 1D it applies after the region. The Studio offers presets matching the fade
shapes, and the curve editor for the rest; the 2D plane tints each entry's shaped influence.

**Playback rules** gate each trigger in order: cooldown since the last accepted trigger, chance, then max instances (steal the oldest, quietest or farthest with a 40 ms fade, or refuse). `untilStopped` keeps the instance alive until the game stops it. Only the root playlist's rules gate.

**Loops and release.** A loop is `always`, `held` (until `release()`) or bound to a parameter (`binding: { parameter, op, value }`). An inactive loop is left by its `exit`: `finish` plays the pass out, `jump` leaves at once, `crossfade` leaves with `exitFadeMs`. In a Sequence, a loop over **sync** clips moves the playhead and restarts their audio each pass; an **async** clip runs its own voice and loops only by its sample's own loops, so a held engine loop belongs on the sample (its sidecar) or on sync clips.

**Second inputs ("And by", ADR 0362).** A voice curve, a sequence clip or track automation lane, and a Mixer bus or
bus-effect automation lane (`audio.json`) can also follow a second game parameter, `by`:

```jsonc
"by": { "input": "Speed", "mode": "morph", "curve": [[0, -6], [2, 0]] }        // blend toward a High curve as Speed rises
"by": { "input": "Load", "mode": "scale", "curve": [[0, 1], [1, 0.5]] }        // multiply the lane by a curve of Load
"by": { "input": "Speed", "mode": "rate", "curve": [[0, 1], [100, 2]] }        // time lanes: run the clock faster
"by": { "input": "Surface", "mode": "labels", "labels": { "Wood": [[0, -3]] } } // one curve per label (the first label is the lane's own)
```

`morph` blends the lane's curve (Low) and `curve` (High) by where the second parameter sits in its range; `scale`
multiplies the lane's value by `curve` at the second parameter; `rate` (lanes keyed on time only) reads the lane at its
time × `curve` at the second parameter (a change of rate applies at once, it isn't integrated); `labels` (a labelled
parameter only) plays one curve per label. In the curve editor, pick the parameter in **And by**, then how it follows
and which curve to edit; the dashed line previews the result at the **Preview at** value. The runtime plays a lane's
slice at the second parameter's value and re-slices when that parameter changes. The parse drops `rate` on a lane keyed
on a parameter; the Studio lints a second input that names no parameter, one on a `gen:` curve or lane (generator
parameters follow one input), or a per-label lane on a parameter without
labels (`byIgnored`), and a Mixer lane's parse drops those (and one that names the lane's own parameter).

**Reverse.** A sequence clip with `reverse: true` plays its span backwards: its tail first, then its loop's passes run backwards inside the span, then the pickup, ending at the clip's offset (the Sequencer's Direction control). A reversed clip that streams is decoded whole for it, and a sample shipped compressed (ADPCM, load "compressed") is silent reversed (one warning; set it to decode). A reversed sync clip's loop drives the playhead on the mirrored clip: it wraps on the passes after the tail, and once it leaves, the first pass and the pickup play out (a clip with no pass besides its first follows, with one warning). A reversed async clip reports its sample markers where they are heard as its voice reads down. A reversed sample never gives the sequence its musical clock (its bars would run backwards); give the sequence a tempo. Reverse needs the audio core; the Web Audio fallback plays it forward.

**Amp envelope on clips.** A sequence clip's `envelope` effect (Attack, Hold, Decay, Sustain, Release) shapes the clip's own voices sample by sample: it rises from silence over the attack at the clip's start, holds, falls to the sustain, and its release ends on the clip's end (the clip's key-off). A clip shorter than the stages squeezes them in order, the release first. Drag the ADSR handles drawn over the clip in the Sequencer to set them; what is drawn is what plays. A sample's baked Amp envelope (the Samples screen) is the same envelope over the sample.

**Effects, spatial, attenuation.** `effects` run once per playing instance on its mixed output; tracks and clips have their own. `spatial` names an attenuation preset (`*.attenuation.json`) or inline curves, occlusion, Doppler and spread ([Spatial audio](spatial-audio.md)).

Limits (the parse drops what is past them, with one problem line each): 256 entries, nesting 16, 32 tracks, 512 clips, 64 keys per curve, 16 local parameters. The parse is lenient: a bad value falls back to its default and is reported once in the console.

## Generators

A Clip playlist can play a **sound generator** (`*.generator.json`: an oscillator, a two-oscillator synth, an sfxr blip, or silence) beside its samples, linked (`{ "generator": "audio/ui/coin.generator.json" }`) or embedded (the generator object itself), and a sequence clip can have a generator as its source instead of a sample or a playlist. Its parameters follow `gen:<param>` voice curves and clip automation. `Audio.play("audio/ui/coin.generator.json")` plays one directly. Making them, presets, audition, Bake and the fallback's limits are in [Sound generators](sound-generators.md).

## Debugging

`Audio.debug().events` lists the playing instances (`id`, `asset` = the playlist path, `voices`, `parameters`, `lateStarts`); `Audio.debug().playlistTotals` has the refused triggers by reason, the latest refusals and steals, and the late starts. The Audio Studio's Profiler shows the same in a capture or a take. See [Why is there no sound?](why-no-sound.md).

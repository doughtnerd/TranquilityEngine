# Audio mixer (ADR 0097)

How to play sounds is in [Playing sound](playing-sound.md); if a bus is silent, see [Why is there no sound?](why-no-sound.md#4-a-sounds-reason).

Sound plays on **buses**: a tree that starts at `Master` (default children `Music`, `SFX`, `UI`, `Voice`). Edit it in Project Settings > Audio, or in `project.json`:

```jsonc
"audio": {
  "buses": [
    { "name": "Master" },
    { "name": "Music", "parent": "Master", "volume": 0.8, "effects": [{ "type": "lowpass", "frequency": 18000 }] },
    { "name": "SFX",   "parent": "Master", "effects": [{ "type": "reverb", "send": 0.2 }] },
    { "name": "Voice", "parent": "Master" }
  ],
  "snapshots": [{ "name": "Paused", "volumes": { "Music": 0.3, "SFX": 0 }, "lowpass": { "Music": 800 } }],
  "ducking":   [{ "target": "Music", "trigger": "Voice", "amount": 0.4, "attack": 0.1, "release": 0.6 }]
}
```

- `volume` is linear 0..2. Effects run in order: `lowpass`/`highpass` (`frequency`, `q`), `compressor` (`threshold`, `knee`, `ratio`, `attack`, `release`), `reverb` (`send` 0..1 into one shared reverb).
- **AudioSource**: set `output` (a dropdown of your buses). Empty means Master. **One-shots**: `Audio.playOneShot("asset:boom.wav", { bus: "SFX" })`.
- **Snapshots** multiply bus volumes and can low-pass a bus; **ducking** lowers `target` while `trigger` has sounds playing.

## Scripting

```ts
Audio.bus("Music").volume = 0.5;          // options menu slider
Audio.bus("SFX").mute = true;
Audio.bus("Music").solo = true;           // only Music (and what it feeds) is heard
Audio.bus("Music").fadeTo(0, 2);          // fade out over 2 s
Audio.snapshot("Paused", 0.3);            // fade to a named mix
Audio.clearSnapshot(0.3);
Audio.bus("Voice").activeVoices;          // sounds playing on it
```

Unknown bus names warn once and are ignored. Script changes are runtime state: save a player's volumes yourself (`Storage`) and set them at start.

## Choosing the backend

`audio.backend` is `"core"` by default: the Rust mixer with effects, priorities, virtual voices, HRTF and a limiter. `"babylon"` selects the Babylon fallback, which an engine that can't run the core uses too (one warning, then the fallback). One exception: a **macOS desktop build** (the Tauri app on macOS, WKWebView) defaults to `"babylon"` until macOS passes its real-time gate. A browser on macOS, Safari included, gets the core. Writing `audio.backend: "core"` (or `"babylon"`) in `project.json`, or choosing it in Project Settings > Audio, wins on every platform. Projects from before the switch that don't set the key now play on the core.

## Limits

Buses, volume, mute, solo, snapshots (their volumes) and ducking work on every backend. What differs is the **Babylon fallback**, the backend an engine uses when `audio.backend` is `"babylon"` (the default on macOS desktop builds) or when the audio core can't run there (see [audio-minimum-versions.md](audio-minimum-versions.md)):

- No bus effects. Reverb, filters and the compressor are skipped.
- A snapshot's low-pass does nothing. Its volumes still apply.
- No priorities and no virtual voices. Sounds are never stolen by priority.
- `maxVoices` is approximate: when a bus is over its limit, the oldest sound on it is stopped.
- Clips with `stream` on in their import settings play through a streaming source (the browser's own HTML5 audio): flat (a spatial one plays flat, with a warning) and with no pitch change. The fallback decodes clips with the browser, not the engine's decoder, so the formats it supports are the browser's.
- Spatial sound uses the browser's own panner, so 3D sound differs from browser to browser.

On the audio core (`audio.backend` `"core"`), clips decode on a worker (WAV, FLAC, MP3 and Ogg Vorbis, each at its file's own rate; AAC too with `audio.codecs.aac` on, which loads a larger decoder, otherwise AAC assets don't play there and warn once each); a clip with `stream` on decodes in pieces while it plays instead of loading whole, and is otherwise a voice like any other (spatial, pitched, on its bus and its effects). Loops are gapless, clips and streams alike, wherever the file states its encoder delay and padding (see [Gapless loops](atmosphere-and-sound.md#sound-files-and-decoding)); the Babylon fallback loops whatever the browser decoded. A bus runs its first 4 effects and at most one `compressor` (the first in its list). Further effects, and a second compressor, are skipped.

The audio core ends in a master limiter, after the master volume: the output never goes above 0 dBFS, so many loud sounds at once are turned down for a moment (released over about a quarter of a second) instead of clipping. While the mix stays under full scale it changes nothing. The Babylon fallback has no limiter.

The limiter looks ahead: it delays all of the core's output by a fixed time, set by `audio.limiterLookaheadMs` in `project.json` (Project panel > Audio > Playback > **Limiter look-ahead (ms)**; 0 to 5, default 1.5). With that head start it lowers the volume smoothly over the moment before a loud peak, so the peak comes out as the same sound, only quieter. Longer is gentler on sharp attacks but adds more delay. The delay is always there, limiting or not, and `Audio.time` and `at` already allow for it, so sounds still start exactly when you schedule them. 0 gives zero added latency, but the limiter then has to react on the peak itself, which flattens the start of a sound that goes over. A change takes effect the next time the audio core starts, for example after a page reload, never in the middle of a session.

Pitch on the audio core uses 4-point interpolation: changing a sound's pitch keeps it clean, with very little added distortion. Raising the pitch a long way can still fold very high frequencies back down as faint false tones (aliasing). Small changes, such as a random semitone or two on footsteps, are not affected, because only content above about 21 kHz folds and it stays inaudible. Raising a bright sound by half again or more (pitch 1.5 or higher) can make it audible. If a sound must go that high, author it with less top end, or record it closer to the pitch it plays at.

Bus volume changes ramp over about 15 milliseconds, so a mute or a ducking step doesn't click.

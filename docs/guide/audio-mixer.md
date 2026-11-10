# Audio mixer (ADR 0097)

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

## Limits

Buses, volume, mute, solo, snapshots (their volumes) and ducking work on every backend. What differs is the **Babylon fallback**, the backend an engine uses when `audio.backend` is `"babylon"` or when the audio core can't run there (see [audio-minimum-versions.md](audio-minimum-versions.md)):

- No bus effects. Reverb, filters and the compressor are skipped.
- A snapshot's low-pass does nothing. Its volumes still apply.
- No priorities and no virtual voices. Sounds are never stolen by priority.
- `maxVoices` is approximate: when a bus is over its limit, the oldest sound on it is stopped.
- Clips with `stream` on in their import settings play through a streaming source with no pitch change.
- Spatial sound uses the browser's own panner, so 3D sound differs from browser to browser.

On the audio core (`audio.backend` `"core"`), a bus runs its first 4 effects and at most one `compressor` (the first in its list). Further effects, and a second compressor, are skipped.

Bus volume changes ramp over about 15 milliseconds, so a mute or a ducking step doesn't click.

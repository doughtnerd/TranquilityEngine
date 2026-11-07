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

Clips with `stream` on in their import settings play through an HTML5 audio element, so they get their bus's volume but no effects and no spatial sound. Effects need Web Audio. The Howler routing is only covered by unit tests with Howler mocked: if a sound ignores its bus in a real browser, report it.

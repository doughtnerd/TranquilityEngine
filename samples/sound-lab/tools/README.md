# Sound Lab tools

`makeTones.mjs` writes the generated clips in `../audio/` (mono, 16-bit PCM; 48 kHz, except the 24 kHz `melody-loop.wav`; about 680 KB in all). It is deterministic, so rerunning it rewrites identical files:

```
node samples/sound-lab/tools/makeTones.mjs
```

`bright.wav`, `loud.wav`, `noise-loop.wav` and `melody-loop.wav` (streamed: see its `.meta.json`) serve the listening pass, `docs/design/0157-audio-core/listening-pass.md`.

`../audio/loops/` holds one loopable second (whole cycles, no fades, 48 kHz stereo) as WAV, FLAC, Ogg Vorbis and MP3 with a LAME tag. They are copies of the decoder's `loop-48000-stereo.*` test fixtures, written by `native/audio/crates/audio-decode/tests/fixtures/generate.mjs` (ffmpeg in bit-exact mode); regenerate them there and copy them here.

## Events page clips

The same script writes `../audio/events/` (23 files, about 1.3 MB), the clips of the events page (`scenes/events.scene.json`, ADR 0158 §8) and of the `*.audioevent.json` files beside them. They are synthesised from seeded noise and sines, so they carry no licence and a rerun is byte-identical:

- `step-{grass,gravel,wood,metal}-{1,2,3}.wav`: footsteps, 48 kHz, 0.25 to 0.35 s; the three variants of a surface differ in seed, pitch and grain pattern.
- `engine-{idle,mid,high}.wav`: 24 kHz engine loops at 30, 60 and 110 Hz firing rate. Each is 1.3 s: a 0.15 s lead-in, exactly 1 s of loop and a 0.15 s tail. The loop region is **0.15 to 1.15 s**, written both into the file (a WAV `smpl` loop) and, authoritatively, into the event's `loopRegion`.
- `engine-start.wav` (0.9 s: starter and ragged firing settling at idle) and `engine-off.wav` (1.2 s spin-down and a thump): the start and end of the sustain container.
- `engine-single.wav`: 2.5 s, a 0.5 s run-up, a loop region of **0.5 to 1.5 s** (also a `smpl` loop) and a 1 s spin-down tail, for one clip played with `sustain: true`.
- `music-{pad,pulse,lead}.wav`: 24 kHz, 4 s, 120 bpm in A minor, the same length so the layers stay in time. The pad is always on; Intensity fades the pulse and the lead in.

What the page does, and what to listen for, is in the comments of `scripts/behaviors/Footsteps.ts`, `EngineBench.ts` and `MusicIntensity.ts`. Press E in the main scene to open it, B to come back.

## Music page clips

`../audio/music/` (9 clips, about 1.46 MB, mono 16-bit, 22.05 kHz) holds the stems of the music page (key M on the tour page, `scenes/music.scene.json`, `scripts/behaviors/MusicLab.ts`). They are written by `tools/makeMusic.mjs` at the repository root, not by `makeTones.mjs` (`node tools/makeMusic.mjs`; `--check` tells whether the files are current; `node --test tools/makeMusic.test.mjs` tests it). Every clip is on one grid, 120 bpm in 4/4 (a bar is 2 s), so any segment can follow any other. The three `*.audioevent.json` files beside them are hand-written to the format in `docs/guide/interactive-music.md`: `music-world` (a switch on State with a rule for every pair, a bridge and two stingers), `music-loop` (a loop region with a tail that loops while Loop is hold) and `music-playlist`.

## Rhythm page clips

`samples/sound-lab/tools/makeClick.mjs` writes `../audio/music/click-track.wav` (one bar at 120 bpm, a click on every beat, beat 1 higher; deterministic: `node samples/sound-lab/tools/makeClick.mjs`). The rhythm page (key R on the tour page, `scenes/rhythm.scene.json`, `scripts/behaviors/RhythmLab.ts`) plays it through `rhythm-click.audioevent.json` for the calibration, and `rhythm-game.audioevent.json` (the combat drums and bass) for the tap game.

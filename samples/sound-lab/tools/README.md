# Sound Lab tools

`makeTones.mjs` writes the generated clips in `../audio/` (mono, 16-bit PCM; 48 kHz, except the 24 kHz `melody-loop.wav`; about 680 KB in all). It is deterministic, so rerunning it rewrites identical files:

```
node samples/sound-lab/tools/makeTones.mjs
```

`bright.wav`, `loud.wav`, `noise-loop.wav` and `melody-loop.wav` (streamed: see its `.meta.json`) serve the listening pass, `docs/design/0157-audio-core/listening-pass.md`.

`../audio/loops/` holds one loopable second (whole cycles, no fades, 48 kHz stereo) as WAV, FLAC, Ogg Vorbis and MP3 with a LAME tag. They are copies of the decoder's `loop-48000-stereo.*` test fixtures, written by `native/audio/crates/audio-decode/tests/fixtures/generate.mjs` (ffmpeg in bit-exact mode); regenerate them there and copy them here.

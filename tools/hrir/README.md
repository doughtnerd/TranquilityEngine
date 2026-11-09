# HRIR converter (ADR 0157, task H2)

`convert.mjs` turns the IRCAM Listen IRC_Composite_C responses, as Chromium processed them
(commit `cbba46fd94646232cfd2318ac962138c2a98c1f9`), into `src/plugins/audio/runtime/wasm/myco_hrir.bin`, the
`format = 2` blob the audio core's HRTF panner reads (layout: `native/audio/crates/audio-dsp/src/hrtf/database.rs`).

Licence and acknowledgement: `docs/design/0157-audio-core/hrir-licence.md`.

## Running it

```
node tools/hrir/convert.mjs                 # writes the blob and tools/hrir/PROVENANCE.json
node tools/hrir/convert.mjs --out some.bin  # writes the blob elsewhere (PROVENANCE.json still updated)
npx vitest run src/plugins/audio/runtime/core/hrirBlob.test.ts
```

- The 240 source WAVs are fetched from `chromium.googlesource.com` into `tools/hrir/raw/` (git-ignored) only when
  missing. Requests run four at a time and retry on HTTP 429 and 5xx. Nothing else is fetched.
- The blob is committed. Rerun the converter only when the source or the conversion changes, then commit the new
  blob and `PROVENANCE.json` together.
- Node 18 or later (uses global `fetch`). No npm dependencies.

## What it does

1. Maps each file name to a direction `d = azIdx * 10 + elIdx` (azimuth T in 15 degree steps, elevation P from -45 up).
2. Parses each WAV (RIFF chunks, PCM16 stereo 44.1 kHz, 256 frames) and samples as `s / 32768`.
3. Removes each ear's leading delay with a port of `extract_average_group_delay` (kernel.rs), in f64 with a
   self-written 256-point FFT. The delay table keeps the removed delays in frames.
4. Scales by one factor only if the delay-removed peak exceeds 1.0 (to 0.999). Otherwise the gain is 1.0.
5. Quantises with `round(x * 32768)`, clamped to int16, and writes the little-endian blob.

`PROVENANCE.json` records the Chromium commit, URL pattern, SHA-256 and size of each source, the blob's SHA-256 and
size, the raw and delay-removed peaks, the scale factor, and the date.

Note: 53 of the 240 source WAVs are byte-identical copies (upper-hemisphere elevations at several azimuths), consistent with Chromium capping the elevations for those azimuths (`kMaxElevations`); the table keeps them, and the core never reads the extras.

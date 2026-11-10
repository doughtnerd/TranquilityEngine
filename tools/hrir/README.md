# HRIR converter (ADR 0157, tasks H2 and H5)

`convert.mjs` turns the IRCAM Listen IRC_Composite_C responses that Chromium ships (commit
`cbba46fd94646232cfd2318ac962138c2a98c1f9`) into `src/plugins/audio/runtime/wasm/myco_hrir.bin`, the HRIR asset
main fetches. Main (`src/plugins/audio/runtime/core/hrir.ts`) turns the asset into the `format = 2` blob the audio
core's HRTF panner reads (layout: `native/audio/crates/audio-dsp/src/hrtf/database.rs`) for the context's rate.

Licence and acknowledgement: `docs/design/0157-audio-core/hrir-licence.md`.

## Running it

```
node tools/hrir/convert.mjs                 # writes the asset and tools/hrir/PROVENANCE.json
node tools/hrir/convert.mjs --out some.bin  # writes the asset elsewhere (PROVENANCE.json still updated)
npx vitest run src/plugins/audio/runtime/core/hrirBlob.test.ts
```

- The 240 source WAVs are fetched into `tools/hrir/raw/` (git-ignored) only when missing: from
  `chromium.googlesource.com` (four at a time, retrying HTTP 429 and 5xx), else from Chromium's GitHub mirror
  (`raw.githubusercontent.com/chromium/chromium/<commit>/...`) at the same commit. Nothing else is fetched.
  `PROVENANCE.json` keeps each file's SHA-256, so a fetch from either is checked against the other.
- The asset is committed. Rerun the converter only when the source or the conversion changes, then commit the new
  asset and `PROVENANCE.json` together.
- Node 18 or later (uses global `fetch`). No npm dependencies.

## What it does

1. Maps each file name to a direction `d = azIdx * 10 + elIdx` (azimuth T in 15 degree steps, elevation P from -45 up).
2. Parses each WAV (RIFF chunks, PCM16 stereo 44.1 kHz, 256 frames).
3. Writes the 16-byte header (`u32 elevations = 10; u32 azimuths = 24; u32 irLength = 256; f32 rate = 44100`) and
   then every direction's 256 frames as stored (int16, interleaved left, right). 245,776 bytes. Nothing else: the
   leading delays stay in (H5).

The samples equal Chromium's own resource (`Composite.flac`, `IDR_AUDIO_SPATIALIZATION_COMPOSITE`), decoded, in that
file's order (elevation 0, 15, ..., 90, 315, 330, 345 within each azimuth). Chromium resamples each 256-frame response
on its own with its delay in (`AudioBus::TryCreateBySampleRateConverting`, media's `SincResampler`) and extracts its
average group delay at the context rate (`HRTFKernel`); `hrir.ts` ports both, so the asset must keep the delays. H2's
asset had them removed at 44.1 kHz, which made 48 kHz differ from Chromium by up to 5.7 dB (issue #111).

`PROVENANCE.json` records the Chromium commit, the URL patterns, SHA-256 and size of each source, the asset's SHA-256
and size, the peak, and the date.

Note: 53 of the 240 source WAVs are byte-identical copies (upper-hemisphere elevations at several azimuths), consistent with Chromium capping the elevations for those azimuths (`kMaxElevations`); the table keeps them, and the core never reads the extras.

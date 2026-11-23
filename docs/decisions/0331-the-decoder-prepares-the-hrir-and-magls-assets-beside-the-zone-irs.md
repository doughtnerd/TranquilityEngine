# 0331. The decoder prepares the HRIR table and the MagLS filters for the context rate, beside the zone impulse responses

- **Status:** Accepted
- **Date:** 2026-11-22
- **Deciders:** Chris Carlson
- **Supersedes:** —
- **Amends:** 0157 (H5: the HRIR table is prepared for the context rate in the decoder worker, not on main), 0162 (A3: the MagLS filters likewise)
- **Related:** 0157 (H2, H5, A3.4c; the decoder worker and its ABI), 0162 (A3, C2a, C9: the zone IR preparation in the decoder, `irPrepare.ts`), 0223 (the decoder worker's channel to the worklet)

## Context

Two spatial assets reach the core as reserved clips: the HRIR table (clip format 2) and the MagLS bed filters (format 4).
Both ship at 44.1 kHz and are prepared for the context rate at load with Chromium's pipeline: media's `SincResampler`
(32 taps, 33 kernel offsets, cutoff 0.9, 64-frame requests), `HRTFKernel`'s `ExtractAverageGroupDelay`, and
`HRTFPanner::FftSizeForSampleRate`. That preparation was 385 lines of TypeScript on the main thread
(`runtime/core/hrirResample.ts`, called from `hrir.ts` on the first spatial play and on every rebuild at a new rate),
with its own radix-2 FFT and its own copy of the FFT-size rule.

The same kind of work already lives in Rust in the decoder: `myco_ir_prepare` decodes, resamples and transforms zone
impulse responses in the decoder worker (ADR 0162 C2a, `audio-decode/src/ir.rs`), main asks for it through
`irPrepare.ts`, and audio-dsp owns the FFT-size rule (`hrtf::elevation_index::fft_size_for_sample_rate`) and the core's
FFTs. The blob layouts were therefore written in TypeScript (producer) and Rust (consumer), and the FFT-size rule in
both.

The HRTF golden scenes (`audioGolden.test.ts`, ADR 0157 H5; the bed scenes, ADR 0162 A3) and the HRTF parity scenes
(`hrtfParity.test.ts`) render the prepared blobs, so their digests pin the preparation's exact output.

## Decision

**The decoder wasm prepares both assets.** `audio-decode/src/spatial.rs` holds the preparation, beside `ir.rs`; the
decoder ABI becomes 1.4 with four exports:

- `myco_hrir_prepare(ptr, len, rate: f64) -> i32` and `myco_magls_prepare(ptr, len, rate: f64) -> i32`: take the asset
  from `myco_decode_alloc` (owned from then on, as `myco_ir_prepare`), return the blob's byte length or an `ERR_*`
  (`ERR_ARG` for a rate that isn't finite and positive, `ERR_FORMAT` for an asset that isn't the documented layout).
- `myco_spatial_blob_ptr()` / `myco_spatial_blob_len()`: the blob, valid until the next prepare of either kind.

The blobs are the existing formats 2 and 4, unchanged. The FFT size is audio-dsp's `fft_size_for_sample_rate` (the
TypeScript copy is gone); the MagLS header is audio-wire's generated `MaglsHeader`.

**Bit-exact with the TypeScript it replaces.** The port keeps every f32/f64 step of `hrirResample.ts`, including its
radix-2 f64 FFT whose spectrum is rounded to f32 between steps (as `FFTFrame` keeps it). It does not reuse audio-dsp's
f32 real FFT or its `extract_average_group_delay`: those round differently, so the blobs, and with them the golden
digests, would move. audio-decode's `tests/spatial.rs` pins the SHA-256 of both blobs at twelve rates (8 kHz to
176.4 kHz, including 47,999.6 Hz), recorded from the TypeScript before it was deleted; every golden and parity digest is
unchanged, and none was re-recorded.

**Main asks the decoder worker, as for zone IRs.** The protocol gains `prepareSpatial {id, kind: "hrir" | "magls",
bytes, rate}`, answered by `spatialPrepared {id, bytes}` or `spatialFailed {id, code, message}`. `DecoderClient`
gains `prepareSpatial(kind, asset, rate): Promise<ArrayBuffer>`; a worker that dies or is refused rejects it
(`DecoderUnavailableError`, not posted again, as peaks). The blob comes back to main because the clip registry owns
reserved clips: it paces their chunks and re-sends them after a rebuild.

**One loader lifecycle for both assets.** `hrir.ts` keeps `createHrirLoader` and `createMaglsLoader` as two specs of
one loader: fetch once on first use, `prepare(kind, asset, rate)` (default: the core's decoder client), then
`clips.acquireReserved`. A retarget during the first preparation prepares again for the new rate.

**The rebuild at a new rate waits for the new blob.** Preparation is now asynchronous, and a core refuses an HRIR table
at another rate (it sets `hrtfLoadFailure` 2), so the registry's `updateReserved(id, next: Promise<ReservedClipData>)`
takes the pending blob: chunks of the old one stop at once, a `resend` before it lands sends nothing for that clip
(state `copying`), and the blob begins when it lands. A rejected `next` marks the clip `failed` and the loader warns once.

**Also fixed:** the doc comment of `INFO_BYTES` in `audio-decode/src/lib.rs` described the info record only up to
`flags` bit 0; it now names bit 1 (the file states a loop) and the loop start and end at bytes 32 and 36, which
`decoder/wasm.ts` reads.

## Alternatives considered

- **Reuse audio-dsp's f32 FFT and `extract_average_group_delay`** (one FFT in Rust) — changes the blobs in the low bits,
  so every HRTF golden digest and the parity measurements move, which would need re-recording with no gain in accuracy.
  The f64 FFT is 50 lines, private to the offline preparation.
- **Reuse `ir.rs`'s resampler** — a different kernel (256 interpolated phases, other alignment) from Chromium's
  `SincResampler`; HRTF parity with Chromium is the reason the preparation exists.
- **Have the worker send the blob straight to the worklet**, as zone kernels go — the clip registry would lose the
  reserved clips it re-sends after a rebuild and reports through `state()`; a second owner for reserved ids.
- **Keep the TypeScript on main and only share the size rule** — the work stays on the main thread, and the blob layout
  stays written in two languages.

## Consequences

**Positive**
- The preparation leaves the main thread (a few milliseconds per asset per rate, on the first spatial play and on a
  rebuild at a new rate).
- One producer per blob layout, in the crate family that consumes it; one FFT-size rule.
- The rebuild at a new rate no longer resends a stale table: before, the new table was computed synchronously; now the
  registry waits for it explicitly.

**Negative / costs**
- The decoder wasm grows by about 17.5 KB (804,382 B to 821,938 B; gate 900 KB).
- Rust has two FFTs: audio-dsp's f32 transforms for the real-time path and this f64 one for the offline preparation.
- Loading the HRIR now needs the decoder worker; a page whose worker can't run stays on equal-power (as it already
  could not stream or decode clips).

## Deprecates

`src/plugins/audio/runtime/core/hrirResample.ts` (`resampleHrir`, `resampleMagls`, `sincKernels`, `sincResample`,
`extractAverageGroupDelay`, `hrtfFftSize`, `readHrirHeader`) is removed. The TypeScript unit tests of the resampler and
the group delay move to Rust (`spatial.rs`); the format tests run through `DecoderWasm` in process
(`testing.ts`'s `inProcessSpatialPrepare`).

## Open questions

- audio-core's `tests/hrtf.rs`, audio-bench and `tools/bake-magls` still build format 2 tables in Rust with audio-dsp's
  `extract_average_group_delay` (no resampling). They could call `audio_decode::spatial::prepare_hrir` instead; left to
  the owners of those crates.

## References

- `native/audio/crates/audio-decode/src/spatial.rs`, `tests/spatial.rs`; `src/plugins/audio/runtime/core/hrir.ts`,
  `core/clipRegistry.ts` (`updateReserved`), `decoder/{wasm,protocol,handler,decoderClient}.ts`,
  `decoder/spatialPrepare.test.ts`.
- Chromium sources in `native/audio/third_party/blink/` (`sinc_resampler.cc`, `audio_bus.cc`, `hrtf_kernel.cc`).
- `docs/design/0157-audio-core/build-log.md` (ADR 0331 entry).

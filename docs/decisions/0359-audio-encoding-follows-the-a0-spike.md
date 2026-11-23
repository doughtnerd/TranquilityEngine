# 0359. Audio encoding follows the A0 spike

- **Status:** Accepted
- **Date:** 2026-11-22
- **Deciders:** Chris Carlson
- **Supersedes:** — (amends 0351)
- **Related:** 0351, 0157, 0040

## Context

ADR 0351 (per-platform encoding and packages) asked for a spike (A0) before building. It ran on wasm32-wasip1 with
wasi-sdk 25 in Node 22 and Chrome 153 (WebKit not installed here). Results: `docs/design/audio-studio/spikes/0351-a0.md`,
code and raw data in `spikes/audio-encode/`. Every codec is a go; several of 0351's numbers and rules change.

## Decision

We will keep 0351's design and change these rules:

1. **Encoder build.** Built with SIMD; its size tripwire is 1.75 MB (measured 1,483,882 B with all codecs; the 1.5 MB
   figure was an estimate, and per CLAUDE.md a project tripwire is raised with a reason rather than trading speed). The
   encoder is a WASI **reactor** that passes bytes through linear memory, never file descriptors (six WASI imports; a
   ≤ 60-line shim in the browser; also avoids a Node 22 `node:wasi` crash on large `fd_read`).
2. **Resampling.** rubato's FFT resampler for every fixed-ratio conversion (the rate ceiling, Opus's 48 kHz): ≈300×
   realtime against ≈86× for sinc, which doubled Opus's cost.
3. **Encode speed** (one core, × realtime): Vorbis 63–71× at q ≥ 0.3, 36–40× below; Opus ≈80×; ADPCM 220–270×; three
   parallel workers scale linearly. Studio encodes are capped at 2 concurrent (73–132 MB each for an 82 s clip).
4. **Opus decode.** libopus (fixed point, no imports) in the default decoder: +173,505 B. The decoder tripwires rise
   to 1,000 KB (default) and 1,350 KB (AAC build) with this reason. Pure-Rust Opus decoders are not mature enough
   (opus-rs larger; symphonia-opus MPL and new).
5. **ADPCM in the core.** Decode incrementally each quantum (branchless), not whole blocks on entry: +23k instructions
   per voice per quantum (≈ +58% on a real voice), with no 9.4× spike when voices cross a block together. An ADPCM scene
   joins the metered gate. Our 1,024-frame block layout isn't WAV IMA, so the core's block reader is shared with the
   decoder worker; symphonia's `adpcm` stays only for imported WAV IMA sources.
6. **Licences.** Notices go in the root `THIRD_PARTY_NOTICES.md` (not `PORTS.md`), including wasi-libc/musl (MIT); C
   sources are vendored under `native/audio/third_party/` like libebur128; game exports ship the notices.
7. **Spike report path** is `docs/design/audio-studio/spikes/0351-a0.md`.

## Alternatives considered

- **Size-optimised encoder (`-Os`, 1.22 MB)** — fits 1.5 MB at the same codec speed, but SIMD resampling gains more
  than the size saves; kept as a fallback if a platform caps it.
- **Block-cache ADPCM as 0351 wrote** — same average cost, 9.4× worst-quantum spikes.

## Consequences

**Positive**
- Every codec has measured cost and size; the export can plan around real speeds.

**Negative / costs**
- Contributors rebuilding the encoder need wasi-sdk; three size tripwires rise (logged here).
- WebKit (Safari, Tauri's webviews) unmeasured until a machine with it runs the spike.

## Deprecates

0351's encoder size figure, its block-cache ADPCM, its notices file name and report path.

## Open questions

- WebKit numbers; encode quality scores (PEAQ/ViSQOL) per quality setting.

## References

`docs/design/audio-studio/spikes/0351-a0.md`; `spikes/audio-encode/`.

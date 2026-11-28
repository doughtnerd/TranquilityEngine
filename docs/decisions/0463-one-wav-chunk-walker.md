# 0463. One WAV chunk walker

- **Status:** Accepted
- **Date:** 2026-11-28
- **Deciders:** Chris Carlson
- **Supersedes:** —
- **Related:** 0158, 0342

## Context

`src/engine/audio/sample/wavChunks.ts` owns the WAV reader (ADR 0342): `walkWavChunks` and `readSmplChunk`, used by
`readWavMetadata` and the Studio's sample import. The Babylon fallback's `src/plugins/audio/runtime/loopPointsReader.ts`
(ADR 0158 §4, a TypeScript port of `native/audio/crates/audio-decode/src/loop_points.rs`) walked the chunks twice more
on its own (`wavLoopPoints`, `fileSampleRate`) and parsed `smpl` again (`smplLoopPoints`). The copies disagreed:

- **Sample rate.** `fileSampleRate` took the first `fmt ` chunk of 8 bytes or more and read its rate even when the chunk
  ran past the end of the file; `readWavMetadata` needs a whole chunk of at least 14 bytes. A 10-byte `fmt ` gave a rate
  in one and null in the other.
- **Which loop.** The Studio's import keeps every `smpl` loop, sorted by start; the runtime loops a plain clip on the
  first forward (type 0) record. Loops `[{type 1, 100..200}, {type 0, 300..400}]` show as `l1 = 100..200` in the Studio
  while a plain clip of that file loops `300..401`.

## Decision

We will keep the WAV rules in `wavChunks.ts` and make `loopPointsReader.ts` a thin layer over it.

- `wavSampleRate(walk: RiffWalk): number | null`: the first `fmt ` chunk's rate when that chunk is whole, at least 14
  bytes, and the rate is above 0. `readWavMetadata` and `fileSampleRate` both use it (the stricter, metadata rule).
- `firstForwardLoop(loops: readonly WavLoop[]): WavLoop | null`: the first type-0 loop in record order. It is the
  runtime's rule and Rust's (`smpl_loop_points`), unchanged.
- `loopPointsReader.ts` keeps its exports and their contracts: `wavLoopPoints` = `walkWavChunks` + the first `smpl`
  chunk; `smplLoopPoints` = `readSmplChunk` + `firstForwardLoop`; `fileSampleRate`'s WAV branch = `wavSampleRate`. Its Ogg
  comment reader stays its own. Its tests still mirror the Rust tests one for one (the parity rule); Rust is unchanged.

The Studio's sample import keeps every loop. That list is a different feature: a sample block authors several loops
(direction, count, active, exit; `SAMPLE_LIMITS.loops`), and the sample player plays them all. Nothing in the Studio
states which single loop a plain clip of the file will loop, so no Studio code calls `firstForwardLoop` yet; anything
that comes to state it uses it.

## Consequences

**Positive**
- One chunk walk and one `smpl` parser in TypeScript. The Babylon fallback and the Studio agree on a file's rate.

**Negative / costs**
- Behaviour change: on the Babylon fallback, a WAV whose `fmt ` chunk is 8–13 bytes or cut off by the end of the file now
  has no sample rate, so its file loop points are not used (`loadFileLoopPoints` reads them only with a rate). Such a file
  is malformed (PCM `fmt ` is 16 bytes or more).

## Deprecates

`loopPointsReader.ts`'s own chunk loop in `wavLoopPoints`, its `smpl` record loop, and `fileSampleRate`'s WAV walk:
removed.

## As built

- `src/engine/audio/sample/wavChunks.ts` (`wavSampleRate`, `firstForwardLoop`); `src/plugins/audio/runtime/loopPointsReader.ts`.
- Tests: `wavChunks.test.ts` "ADR 0463" (a 10-byte or cut-off `fmt ` gives null; the metadata lists both loops while
  `firstForwardLoop` gives 300..401); `loopPoints.test.ts` "ADR 0463" (`fileSampleRate` gave 44100 for both malformed
  files before). `loopPointsReader.test.ts` (the Rust mirror) passes unchanged.

# 0456. The audio runtime has one decibel law and one meter reader

- **Status:** Accepted
- **Date:** 2026-11-28
- **Deciders:** Chris Carlson
- **Supersedes:** —
- **Related:** 0162, 0166, 0343, 0344, 0347, 0362

## Context

The Audio Studio's decision log D8 (`docs/design/audio-studio/decision-log.md`) set the project's dB floor: −60 dB is
silence. Ten places turned dB into linear gain with their own one-liner. Four floored at −60 (`project/gain.ts`,
`core/spatial.ts` `curveDbToGain`, `testScene/player.ts`, `AudioZone.ts`); six did not (`playlists/curves.ts`,
`playlists/quantizedLanes.ts`, `playlists/instance.ts`, `occlusionMaterials.ts`, `clipResolver.ts`, `sampleRender.ts`).
`instance.ts` used both. So a sequence track at the fader's −60 minimum, or a volume lane keyed at −60, played at 0.001
instead of silence. Three of those files also copied `2^(st/12)`, and the Studio's audition gate a fourth time.

A time signature `"n/d"` had the same spread: validation copied in `playlist/format.ts`, `sample/format.ts` and two Studio
edit modules (one of which accepted `"0/4"`); parsing in `sampleFacts.ts` `meterOf` (4/4 fallback), `wavSample.ts` (no
fallback) and six Studio models, each with its own fallback.

## Decision

We will keep each rule in one pure module under `src/engine/audio/`, and every caller uses it.

`decibels.ts`:

- `SILENCE_DB = -60`.
- `dbToGain(db)`: 0 at or below `SILENCE_DB`, NaN reads as 1 (unset), else `10^(db/20)`.
- `gainToDb(gain)`: `SILENCE_DB` at or below the floor's gain, else `20·log10(gain)`.
- `semitonesToRatio(st)`: `2^(st/12)`.

`project/gain.ts` keeps the fader's range (`MIN_DB = SILENCE_DB`, `MAX_DB`), `tidy` rounding and `levelDbOf` on top of
it. `AudioZone` keeps its own +24 dB cap and its "non-finite is unity" reading at the call (no other caller wants them).

`meter.ts`:

- `isMeter(text)`: one or two digits each side, neither zero.
- `parseMeter(raw, where, reader)`: a format's lenient read (missing → `"4/4"`; bad → `"4/4"` and one problem).
- `meterParts(meter)`: `{ beatsPerBar, beatUnit }` (the names of `musicGrid.ts`'s `TempoMarker`), 4/4 for a missing meter
  or one that isn't two positive whole numbers.

Meters (`dbScale.ts`'s −∞ display law, `gainLanesModel.ts`), the migration's −96 dB `migrate/units.ts`, and the per-hit
occlusion wet factor (`occlusionMath.ts` `hitWetFactor`, a factor in a product pinned at −80 dB → 1e-4 by ruling D5) are
separate concepts and keep their own maths.

## Consequences

**Positive**
- A level at −60 dB is silent on every path: faders, sequence tracks, voice gain curves (time-keyed and quantised),
  attenuation and occlusion curves, normalise gain.
- The Studio's bars, grid, ruler, tap tempo and playhead read a meter the way the runtime does.

**Negative / costs**
- A combined occlusion at its −60 dB floor is now silent rather than 0.001.
- A Studio playhead with an invalid meter now reads 4/4 instead of hiding (the runtime plays it as 4/4 too).

## Deprecates

`curveDbToGain` (`core/spatial.ts`), `dbToGain` (`occlusionMaterials.ts`), `meterOf` (`sampleFacts.ts`), `pitchRatio`
(`auditionGate.ts`), the private copies and both `METER` patterns: removed.

## As built

- `src/engine/audio/decibels.ts`, `src/engine/audio/meter.ts`, with `decibels.test.ts` and `meter.test.ts`.
- Bug tests: `sequence.test.ts` (a track at −60 dB plays at gain 0) and `instanceAutomation.test.ts` (a volume lane keyed
  at −60 dB starts the voice at 0); both read 0.001 before.
- The default rolloff law `{ 1, 100, "inverse" }` copied in `babylonBackend.ts` and `AudioZone.ts` is now
  `DEFAULT_ROLLOFF_ATTENUATION` in `core/spatial.ts`. It is a different thing from `attenuation/format.ts`
  `defaultAttenuation` (curve attenuation, 1 m to 50 m, no curves), which stays.

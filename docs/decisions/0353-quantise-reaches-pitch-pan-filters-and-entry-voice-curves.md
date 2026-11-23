# 0353. Quantise reaches pitch, pan, filters and entry voice curves

- **Status:** Accepted
- **Date:** 2026-11-22
- **Deciders:** Chris Carlson
- **Supersedes:** — (amends 0350)
- **Related:** 0350, 0346, 0343

## Context

ADR 0350 added beat-quantised automation for rhythm games, but only on gain-like lanes (volume, enabled, a gain
effect), and said entry voice curves don't take `quantize`. The owner wants quantisation where a rhythm-game designer
expects it: pitch, pan and filters move on the beat too. The audio core has a stamped, sample-exact ramp only for a
voice's gain; pitch, pan and filter cutoffs reach the core as curve bindings evaluated once per 128-frame quantum.

## Decision

We will let `Automation.quantize` apply to pitch, pan and low-/high-pass cutoff lanes, and add `VoiceCurve.quantize`
(same values: `"beat" | "bar" | { beats: n }`) to entry voice curves.

- Gain-like targets keep 0350's stamped gain ramp (sample-exact).
- Pitch, pan and filter targets use a binding on the voice's own time to a curve it holds alone: the curve holds the
  current level and steps over 20 ms at the next boundary of the instance's musical clock; it is redefined a lookahead
  before the boundary and agrees with the old curve up to it, so the change lands at the boundary however late the
  redefinition arrives. These land within one quantum (2.7 ms at 48 kHz), not to the sample.
- Curve ids are leased per voice (`PlaylistHost.leaseCurve` / `redefineCurve`) and returned when the voice is freed,
  so quantised lanes can't exhaust the core's curve table.
- Other effect parameters stay unquantisable (they aren't automated per voice yet) and keep their warning and lint.
- The parse, writer, lint and migration accept the new field; unset keeps 0350's meaning.

## Alternatives considered

- **A stamped core ramp for every voice parameter** — sample-exact, but a wire and core change across several
  parameters for a difference below 3 ms; left for a later core task if a game needs it.
- **Main-thread parameter changes timed by the frame** — jitter of a frame (16 ms+), the opposite of what quantise is
  for.

## Consequences

**Positive**
- Rhythm-game designers can lock pitch, pan and filter moves to the grid, on lanes and on entry curves.

**Negative / costs**
- Non-gain quantise is quantum-accurate, not sample-accurate.
- One leased curve per quantised voice lane.

## Deprecates

Nothing.

## Open questions

- A Studio control for `quantize` on an entry voice curve (the curve editor dialog has none yet).

## References

- Decision log D48 (`docs/design/audio-studio/decision-log.md`); `src/plugins/audio/runtime/playlists/quantizedLanes.ts`.

# 0312. The predicted plan owns one value order and compares rotations as rotations

- **Status:** Accepted
- **Date:** 2026-11-21
- **Deciders:** Chris Carlson
- **Supersedes:** —
- **Related:** 0033 (T13: client prediction), 0121 (ghost component changes), 0311 (the session answers net questions)

## Context

A ghost's predicted values (the transform, data fields listed `predicted`, behavior fields declared `predicted`) were handled by five functions in `net/replication/layout.ts`, used only by `prediction.ts`: `predictedPlan`, `pickPredicted`, `readPredicted`, `applyPredicted` and `predictionError`. `pickPredicted` took values in layout-index order, while `readPredicted` and `applyPredicted` wrote the transform first and then `plan.fields`. They agreed only because `buildLayout` happens to put the transform before every component. `predictionError` compared quaternions component by component, so `q` and `-q`, the same rotation, counted as a misprediction (a rollback and a re-simulation for nothing), and a rotation's error was reported in quaternion units.

## Decision

We will make the plan a class that owns one order of predicted values, and compare rotations by angle.

- **`PredictedPlan`** (`layout.ts`, `@internal`): built once per layout (`predictedPlan(layout)`), it holds a list of slots sorted by layout index: `position` (3 values), `rotation` (4), `scale` (3) and `field` (1, with its part, name, and how it compares). `pick(state)`, `read(binding)`, `apply(binding, values)` and `error(predicted, authoritative)` all walk the same slots, so their orders can't drift. `mask` (what `applyState` leaves to prediction), `size` and `hasTransform` are derived from the slots.
- **Rotations compare as rotations:** the error is the angle between the two quaternions, `2·acos(|q₁·q₂| / (|q₁||q₂|))`, so `q` and `-q` agree; within `ROTATION_TOLERANCE` (4 × `ROTATION_STEP`, 0.002 rad: a whole quantization step on every component) it is 0. The error is reported in radians.
- Other values compare as before: positions and scales within one quantization step per component, quantized fields within their step, unquantized f32 fields within 1e-5 relative (at least 1), integers and booleans exactly.

## Alternatives considered

- **Keep the functions, assert the transform comes first** — guards the trap without removing it; four functions would still each restate the order.
- **Compare positions by distance too** — not asked for and changes the tolerance of every position comparison; positions keep per-component steps.
- **Canonicalize received quaternions (w ≥ 0) instead** — fixes `q`/`-q` but still measures rotation error in component units.

## Consequences

**Positive**
- One order for every operation on a predicted state; a layout change can't desynchronize them.
- No rollback for a rotation sent with the other sign; rotation errors in the network panel's stats are angles.

**Negative / costs**
- Rotation tolerance is now an angle (0.002 rad), slightly looser than one step per component in the worst case.

## Deprecates

`pickPredicted`, `readPredicted`, `applyPredicted` and `predictionError` (`layout.ts`) and `PredictedPlan`'s `indices`, `tolerance`, `integer`, `relative`, `transformAt` and `fields`: replaced by the class's methods.

## Open questions

None.

## References

- `src/engine/net/replication/layout.ts`, `src/engine/net/prediction.ts`
- Tests: `engine/tests/predictedPlan.test.ts`, `engine/tests/prediction.test.ts`
- Architecture review 10 (2026-11-21), card 8

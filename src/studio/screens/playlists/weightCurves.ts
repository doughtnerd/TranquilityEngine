// ADR 0336: a Blend entry's weight curve in the shared curve editor (ADR 0332): a dialog of kind "parameter" over the
// entry's raw blend weight (0..1) with one Gain lane (0..1), and the dialog's result turned back into the entry's
// `weightCurve` (the identity, or a flat lane, clears it: the default). Pure.
import type { CurveEditorResult, CurveEditorSpec } from "../../../editor/ui/curves/curveEditorModel";
import type { Curve } from "../../../engine/core/curve";

/** The lane's id. */
export const WEIGHT_LANE = "gain";

/** The dialog for an entry's weight curve (absent: the identity, today's weights). */
export function weightCurveDialog(curve: Curve | undefined): CurveEditorSpec {
  return {
    kind: "parameter",
    parameter: { name: "Blend weight", min: 0, max: 1 },
    lanes: [{ id: WEIGHT_LANE, name: "Gain", unit: "", min: 0, max: 1, step: 0.01, base: 1, curve: curve ?? [[0, 0], [1, 1]] }],
  };
}

const isIdentity = (c: Curve): boolean => c.length === 2 && c[0]![0] === 0 && c[0]![1] === 0 && c[1]![0] === 1 && c[1]![1] === 1 && c.every((k) => k.length === 2 || k[2] === "linear");

/** The entry's new weight curve from the dialog's result: undefined (cleared) for the identity; null when nothing changed. */
export function applyWeightCurveResult(was: Curve | undefined, result: CurveEditorResult): { curve: Curve | undefined } | null {
  const lane = result.lanes.find((l) => l.id === WEIGHT_LANE);
  if (!lane) return null;
  const next = lane.curve.length === 0 || isIdentity(lane.curve) ? undefined : (lane.curve as Curve);
  if (JSON.stringify(next) === JSON.stringify(was)) return null;
  return { curve: next };
}

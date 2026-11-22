// What the inline curve field (`CurveField.tsx`) opens the shared curve editor with (ADR 0332): one lane over the
// field's x range, its value range from the field's bounds (or the keys' fitted range, widened, when the field fits
// them), linear keys only where the field has no shapes. Pure, so it is tested headless.
import type { Curve } from "../../../engine/core/curve";
import type { CurveEditorSpec } from "./curveEditorModel";
import { fitYRange } from "./keyList";

export interface CurveFieldDialogInput {
  readonly curve: Curve;
  readonly xRange: readonly [number, number];
  readonly yRange: readonly [number, number];
  readonly interpolation: boolean;
  readonly label: string;
  readonly unit?: string;
  readonly fitY?: boolean;
  /** What x is ("Lifetime", a parameter's name); default "X". */
  readonly xName?: string;
}

/** The lane id the field's curve has in the dialog (and in its result). */
export const FIELD_LANE = "curve";

const finite = (v: number) => Number.isFinite(v);

/** A step a hundredth of `span`, rounded down to a power of ten. */
const stepFor = (span: number) => (span > 0 ? Math.pow(10, Math.floor(Math.log10(span / 100))) : 0.01);

/** The dialog spec for an inline field's curve. */
export function fieldDialogSpec(input: CurveFieldDialogInput): CurveEditorSpec {
  const [y0, y1] = input.yRange;
  let min: number, max: number;
  if (!input.fitY && finite(y0) && finite(y1) && y1 > y0) [min, max] = [y0, y1];
  else {
    // Room to drag past the keys: half the fitted span again on each side a finite bound doesn't pin.
    const [lo, hi] = fitYRange(input.curve, finite(y0) ? y0 : undefined, finite(y1) ? y1 : undefined);
    const pad = (hi - lo) * 0.5;
    min = finite(y0) ? Math.max(y0, lo - pad) : lo - pad;
    max = finite(y1) ? Math.min(y1, hi + pad) : hi + pad;
  }
  const [x0, x1] = input.xRange;
  return {
    kind: "parameter",
    parameter: { name: input.xName ?? "X", min: x0, max: x1 > x0 ? x1 : x0 + 1 },
    lanes: [{ id: FIELD_LANE, name: input.label, unit: input.unit ?? "", min, max, step: stepFor(max - min), base: input.curve[0]?.[1] ?? min, curve: input.curve }],
    linearOnly: !input.interpolation,
  };
}

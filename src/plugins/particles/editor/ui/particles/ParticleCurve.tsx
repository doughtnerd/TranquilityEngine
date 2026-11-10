import type { CurveKey } from "../../../../../engine/scene/particles";
import { CurveEditor as CurveWidget, CurvePreview as CurveWidgetPreview } from "../../../../../editor/sdk";

/** The shared curve widget (`src/editor/ui/CurveEditor.tsx`) set up for a particle curve: x is `t` in 0..1, linear, and the value range fits the keys. */
export function CurveEditor(props: { keys: CurveKey[]; onChange: (keys: CurveKey[]) => void; label: string; readOnly?: boolean }) {
  return (
    <CurveWidget
      curve={props.keys}
      onChange={(c) => props.onChange(c.map((k) => [k[0], k[1]] as CurveKey))}
      xRange={[0, 1]}
      yRange={[-Infinity, Infinity]}
      interpolation={false}
      fitY
      label={props.label}
      readOnly={props.readOnly}
    />
  );
}

/** A read-only sparkline of a particle curve, for when it is collapsed. */
export function CurvePreview(props: { keys: CurveKey[] }) {
  return <CurveWidgetPreview curve={props.keys} xRange={[0, 1]} />;
}

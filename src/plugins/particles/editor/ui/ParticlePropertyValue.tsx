// A particle graph property's value field by type (ADR 0290): the Particle Graph's Blackboard and a ParticleSystem's
// exposed properties in the Inspector show the same field, as materials share `ShaderPropertyValue`. It reports
// `(value, drag)` on the SDK's rule (ADR 0282): a colour pick reports `drag` while it moves, and so does a curve or
// gradient edit made while the pointer is down in the field, whose release reports the last value again without it.
import { useRef } from "preact/hooks";
import type { GraphInputValue, GraphPropertyType } from "../../../../engine/scene/particleGraph";
import { defaultPropertyValue } from "../particleGraph/graphEdit";
import { ColorSwatch, CurveValue, GradientValue, NumberValue, VectorValue, asGradient, asKeys, asNumber, fieldOf } from "./particleGraph/valueFields";
import { AssetPicker, NO_DRAG, NO_WHEEL, type ValueReport } from "../../../../editor/sdk";

export interface ParticlePropertyValueProps {
  type: GraphPropertyType;
  /** The property's value, or an override of it; a value that doesn't read as `type` shows the type's default. */
  value: unknown;
  /** The field's accessible name (vector axes add " x", " y", " z"). */
  label: string;
  readOnly?: boolean;
  onValue: ValueReport<GraphInputValue>;
}

/** The value field for a particle property of `type`: numbers (constant or random), vectors, colour, curve, gradient, texture. */
export function ParticlePropertyValue(props: ParticlePropertyValueProps) {
  const { type, value, label, readOnly, onValue } = props;
  const gesture = usePointerGesture(onValue);
  const fallback = defaultPropertyValue(type);
  const committed = (v: GraphInputValue) => onValue(v, false);
  switch (type) {
    case "number":
      return <NumberValue label={label} value={value} fallback={asNumber(fallback)} forms={["constant", "random"]} readOnly={readOnly} onChange={committed} />;
    case "vector2":
    case "vector3":
      return <VectorValue label={label} value={value} size={type === "vector2" ? 2 : 3} readOnly={readOnly} onChange={committed} />;
    case "color":
      return <ColorSwatch label={label} value={typeof value === "string" ? value : String(fallback)} readOnly={readOnly} onChange={onValue} />;
    case "curve":
      return (
        <span class="particle-property-gesture" {...gesture.handlers}>
          <CurveValue label={label} keys={asKeys(fieldOf(value, "curve"), asKeys(fieldOf(fallback, "curve")))} readOnly={readOnly} onChange={(keys) => gesture.report({ curve: keys })} />
        </span>
      );
    case "gradient":
      return (
        <span class="particle-property-gesture" {...gesture.handlers}>
          <GradientValue label={label} gradient={asGradient(fieldOf(value, "gradient"))} readOnly={readOnly} onChange={(g) => gesture.report({ gradient: g })} />
        </span>
      );
    case "texture":
      return <AssetPicker class={`pg-select ${NO_DRAG} ${NO_WHEEL}`} label={label} value={typeof value === "string" ? value : ""} kinds={["texture"]} none="(none)" disabled={readOnly} onCommit={committed} />;
  }
}

/**
 * Reports from a control edited by pointer gestures (the curve and gradient editors): a value reported while the
 * pointer is down in the field reports `drag`; the release (or cancel) reports the last such value again, closing it.
 */
function usePointerGesture<T>(onValue: ValueReport<T>) {
  const down = useRef(false);
  const last = useRef<{ value: T } | null>(null);
  const release = () => {
    down.current = false;
    const l = last.current;
    last.current = null;
    if (l) onValue(l.value, false);
  };
  return {
    handlers: { onPointerDownCapture: () => void (down.current = true), onPointerUp: release, onPointerCancel: release },
    report(value: T) {
      if (down.current) last.current = { value };
      onValue(value, down.current);
    },
  };
}

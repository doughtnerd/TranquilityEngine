import { propertySize, type GraphPropertyType, type GraphValue } from "../../../engine/scene/shaderGraph";
import { AssetPicker, ColorField, type ValueReport } from "../../../editor/sdk";

export const numberValue = (e: Event) => Number((e.currentTarget as HTMLInputElement).value);

/** The field kinds a texture slot takes: images and render textures (both load through the same texture path). */
export const TEXTURE_SLOT = ["texture", "rendertexture"] as const;

/**
 * A shader graph property's value field (the Shader Graph panel's Blackboard, and the Material Inspector), on the SDK's
 * asset picker and colour field (ADR 0282): `onValue`'s `drag` follows their commit rule. Apart from the panel so the
 * Inspector doesn't load the graph editor.
 */
export function PropertyValue(props: { name: string; type: GraphPropertyType; value: GraphValue; disabled: boolean; onValue: ValueReport<GraphValue> }) {
  const { name, type, value } = props;
  if (type === "texture") {
    return <AssetPicker label={`${name} value`} kinds={TEXTURE_SLOT} none="White" value={typeof value === "string" ? value : ""} disabled={props.disabled} onCommit={(v) => props.onValue(v, false)} />;
  }
  if (type === "color") {
    return <ColorField label={`${name} value`} alpha value={typeof value === "string" ? value : "#ffffff"} disabled={props.disabled} onValue={props.onValue} />;
  }
  const n = propertySize(type);
  const values = n === 1 ? [typeof value === "number" ? value : 0] : Array.from({ length: n }, (_, i) => (Array.isArray(value) ? value[i] ?? 0 : 0));
  return (
    <span class="sg-fields">
      {values.map((v, i) => (
        <input key={i} type="number" step={0.1} aria-label={n > 1 ? `${name} ${"XYZW"[i]}` : `${name} value`} disabled={props.disabled} value={+v.toFixed(4)} onChange={(e) => {
          const x = numberValue(e);
          if (!Number.isFinite(x)) return;
          props.onValue(n === 1 ? x : values.map((old, j) => (j === i ? x : old)), false);
        }} />
      ))}
    </span>
  );
}

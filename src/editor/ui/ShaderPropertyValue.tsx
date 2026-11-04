import { propertySize, type GraphPropertyType, type GraphValue } from "../../engine/scene/shaderGraph";

export const numberValue = (e: Event) => Number((e.currentTarget as HTMLInputElement).value);
export const toHex2 = (v: number) => Math.round(Math.min(1, Math.max(0, v)) * 255).toString(16).padStart(2, "0");

/** A shader graph property's value field (the Shader Graph panel's Blackboard, and the Material Inspector). Apart from the panel so the Inspector doesn't load the graph editor. */
export function PropertyValue(props: { name: string; type: GraphPropertyType; value: GraphValue; images: string[]; disabled: boolean; onValue(v: GraphValue): void }) {
  const { name, type, value } = props;
  if (type === "texture") {
    const v = typeof value === "string" ? value : "";
    return (
      <select aria-label={`${name} value`} disabled={props.disabled} value={v} onChange={(e) => props.onValue((e.currentTarget as HTMLSelectElement).value)}>
        <option value="">White</option>
        {props.images.map((f) => (
          <option key={f} value={`asset:${f}`}>
            {f}
          </option>
        ))}
        {v && !props.images.includes(v.replace(/^asset:/, "")) && <option value={v}>{v} (missing)</option>}
      </select>
    );
  }
  if (type === "color") {
    const hex = typeof value === "string" ? value : "#ffffff";
    const a = hex.length === 9 ? parseInt(hex.slice(7), 16) / 255 : 1;
    const withAlpha = (rgb: string, alpha: number) => (alpha >= 1 ? rgb : `${rgb}${toHex2(alpha)}`);
    return (
      <span class="sg-property-color">
        <input type="color" aria-label={`${name} value`} disabled={props.disabled} value={hex.slice(0, 7)} onChange={(e) => props.onValue(withAlpha((e.currentTarget as HTMLInputElement).value, a))} />
        <input type="number" min={0} max={1} step={0.05} aria-label={`${name} alpha`} disabled={props.disabled} value={+a.toFixed(3)} onChange={(e) => {
          const x = numberValue(e);
          if (Number.isFinite(x)) props.onValue(withAlpha(hex.slice(0, 7), Math.min(1, Math.max(0, x))));
        }} />
      </span>
    );
  }
  const n = propertySize(type);
  const values = n === 1 ? [typeof value === "number" ? value : 0] : Array.from({ length: n }, (_, i) => (Array.isArray(value) ? value[i] ?? 0 : 0));
  return (
    <span class="sg-fields">
      {values.map((v, i) => (
        <input key={i} type="number" step={0.1} aria-label={n > 1 ? `${name} ${"XYZW"[i]}` : `${name} value`} disabled={props.disabled} value={+v.toFixed(4)} onChange={(e) => {
          const x = numberValue(e);
          if (!Number.isFinite(x)) return;
          props.onValue(n === 1 ? x : values.map((old, j) => (j === i ? x : old)));
        }} />
      ))}
    </span>
  );
}

import { Color } from "../../engine";
import { colorHex, type MaterialSettings } from "../../engine/scene/material";
import { assetKind, fileName } from "../assetBrowser";
import { readMaterial, sameMaterial, writeMaterial } from "../materialAssets";
import { errorStatus } from "../messages";
import { currentProject, docVersion, status } from "../state";
import "./assetInspector.css";

const withAlpha = (c: Color, a: number) => new Color(c.r, c.g, c.b, a);

/**
 * A material asset's settings (ADR 0043), edited in place: each change writes the file, and every
 * mesh drawing with the material shows it straight away.
 */
export function MaterialInspector(props: { path: string }) {
  docVersion.value; // rewritten by this inspector, or on disk
  const { path } = props;
  const project = currentProject.value;
  if (!project) return <p class="empty">Nothing selected</p>;
  const { settings, problems } = readMaterial(project, path);
  const readOnly = !project.canSave;
  const images = project.files.filter((f) => assetKind(f) === "image");
  const lit = settings.shader === "lit";

  const set = async (patch: Partial<MaterialSettings>) => {
    const next = { ...settings, ...patch };
    if (sameMaterial(next, settings)) return;
    try {
      await writeMaterial(project, path, next);
      docVersion.value++;
    } catch (err) {
      status.value = errorStatus(`Couldn't save ${fileName(path)}`, err);
    }
  };
  const number = (label: string, value: number, onValue: (v: number) => void, range?: [number, number]) => (
    <label class="import-row">
      <span>{label}</span>
      <span class="material-number">
        {range && (
          <input
            type="range"
            min={range[0]}
            max={range[1]}
            step={0.01}
            aria-label={`${label} slider`}
            disabled={readOnly}
            value={value}
            onChange={(e) => onValue(Number((e.currentTarget as HTMLInputElement).value))}
          />
        )}
        <input
          type="number"
          step={0.05}
          min={range?.[0]}
          max={range?.[1]}
          aria-label={label}
          disabled={readOnly}
          value={value}
          onChange={(e) => {
            const v = Number((e.currentTarget as HTMLInputElement).value);
            if (Number.isFinite(v)) onValue(range ? Math.min(range[1], Math.max(range[0], v)) : v);
          }}
        />
      </span>
    </label>
  );
  const texture = (label: string, value: string, onValue: (v: string) => void) => (
    <label class="import-row">
      <span>{label}</span>
      <select aria-label={label} disabled={readOnly} value={value.replace(/^asset:/, "")} onChange={(e) => onValue((e.currentTarget as HTMLSelectElement).value ? `asset:${(e.currentTarget as HTMLSelectElement).value}` : "")}>
        <option value="">None</option>
        {images.map((f) => (
          <option key={f} value={f}>
            {f}
          </option>
        ))}
        {value && !images.includes(value.replace(/^asset:/, "")) && <option value={value.replace(/^asset:/, "")}>{value.replace(/^asset:/, "")} (missing)</option>}
      </select>
    </label>
  );
  const color = (label: string, value: Color, onValue: (c: Color) => void, alpha: boolean) => (
    <label class="import-row">
      <span>{label}</span>
      <span class="material-color">
        <input type="color" aria-label={label} disabled={readOnly} value={value.toHex()} onChange={(e) => onValue(withAlpha(Color.from((e.currentTarget as HTMLInputElement).value), value.a))} />
        <code>{colorHex(value)}</code>
        {alpha && (
          <input
            type="number"
            min={0}
            max={1}
            step={0.05}
            aria-label={`${label} alpha`}
            title="Opacity: below 1 is see-through"
            disabled={readOnly}
            value={+value.a.toFixed(3)}
            onChange={(e) => {
              const a = Number((e.currentTarget as HTMLInputElement).value);
              if (Number.isFinite(a)) onValue(withAlpha(value, Math.min(1, Math.max(0, a))));
            }}
          />
        )}
      </span>
    </label>
  );

  return (
    <div class="inspector-body asset-inspector" aria-label="Material">
      <div class="asset-inspector-head">
        <span class="asset-inspector-kind">Material</span>
        <span class="asset-inspector-name" title={path}>
          {fileName(path)}
        </span>
      </div>
      {problems.length > 0 && (
        <ul class="asset-inspector-problems">
          {problems.map((p) => (
            <li key={p}>{p}</li>
          ))}
        </ul>
      )}
      <div class="component asset-import-card">
        <h3>Material</h3>
        <label class="import-row">
          <span>Shader</span>
          <select aria-label="Shader" disabled={readOnly} value={settings.shader} onChange={(e) => void set({ shader: (e.currentTarget as HTMLSelectElement).value as MaterialSettings["shader"] })}>
            <option value="lit">Lit (physically based)</option>
            <option value="unlit">Unlit</option>
          </select>
        </label>
        {color("Color", settings.color, (c) => void set({ color: c }), true)}
        {texture("Texture", settings.texture, (v) => void set({ texture: v }))}
        <div class="import-row">
          <span>Tiling</span>
          <span class="material-pair">
            {([0, 1] as const).map((i) => (
              <input
                key={i}
                type="number"
                step={0.5}
                aria-label={`Tiling ${i === 0 ? "X" : "Y"}`}
                disabled={readOnly}
                value={settings.tiling[i]}
                onChange={(e) => {
                  const v = Number((e.currentTarget as HTMLInputElement).value);
                  if (!Number.isFinite(v) || v === 0) return;
                  void set({ tiling: i === 0 ? [v, settings.tiling[1]] : [settings.tiling[0], v] });
                }}
              />
            ))}
          </span>
        </div>
        {lit && (
          <>
            {number("Metalness", settings.metalness, (v) => void set({ metalness: v }), [0, 1])}
            {number("Roughness", settings.roughness, (v) => void set({ roughness: v }), [0, 1])}
            {texture("Normal Map", settings.normalMap, (v) => void set({ normalMap: v }))}
            {color("Emission", settings.emission, (c) => void set({ emission: c }), false)}
          </>
        )}
        <label class="import-row">
          <span>Double Sided</span>
          <input type="checkbox" aria-label="Double Sided" disabled={readOnly} checked={settings.doubleSided} onChange={(e) => void set({ doubleSided: (e.currentTarget as HTMLInputElement).checked })} />
        </label>
      </div>
      <p class="asset-inspector-note">{readOnly ? "This project is read-only." : "Changes save to the file as you make them."}</p>
    </div>
  );
}

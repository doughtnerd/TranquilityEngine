import type { RenderTextureSettings } from "../../engine/render/renderTexture";
import { fileName } from "../assetBrowser";
import { errorStatus } from "../messages";
import { readRenderTexture, writeRenderTexture } from "../renderTextureAssets";
import { currentProject, docVersion, status } from "../state";
import "./assetInspector.css";

const clampSize = (v: number) => Math.min(4096, Math.max(1, Math.round(v)));

/** A render texture asset's settings (ADR 0109), edited in place: each change writes the file. */
export function RenderTextureInspector(props: { path: string }) {
  docVersion.value; // rewritten by this inspector, or on disk
  const { path } = props;
  const project = currentProject.value;
  if (!project) return <p class="empty">Nothing selected</p>;
  const { settings, problems } = readRenderTexture(project, path);
  const readOnly = !project.canSave;

  const set = async (patch: Partial<RenderTextureSettings>) => {
    try {
      await writeRenderTexture(project, path, { ...readRenderTexture(project, path).settings, ...patch });
      docVersion.value++;
    } catch (err) {
      status.value = errorStatus(`Couldn't save ${fileName(path)}`, err);
    }
  };
  const size = (label: string, key: "width" | "height") => (
    <label class="import-row">
      <span>{label}</span>
      <input
        type="number"
        min={1}
        max={4096}
        step={1}
        aria-label={label}
        disabled={readOnly}
        value={settings[key]}
        onChange={(e) => {
          const v = Number((e.currentTarget as HTMLInputElement).value);
          if (Number.isFinite(v)) void set({ [key]: clampSize(v) });
        }}
      />
    </label>
  );
  const choice = <K extends "format" | "filter" | "wrap">(label: string, key: K, options: [RenderTextureSettings[K], string][]) => (
    <label class="import-row">
      <span>{label}</span>
      <select aria-label={label} disabled={readOnly} value={settings[key]} onChange={(e) => void set({ [key]: (e.currentTarget as HTMLSelectElement).value } as Partial<RenderTextureSettings>)}>
        {options.map(([value, text]) => (
          <option key={value} value={value}>
            {text}
          </option>
        ))}
      </select>
    </label>
  );

  return (
    <div class="inspector-body asset-inspector" aria-label="Render Texture">
      <div class="asset-inspector-head">
        <span class="asset-inspector-kind">Render Texture</span>
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
        <h3>Render Texture</h3>
        {size("Width", "width")}
        {size("Height", "height")}
        {choice("Format", "format", [["ldr", "LDR (8-bit, tone mapped)"], ["hdr", "HDR (half float, linear)"]])}
        <label class="import-row">
          <span>Depth buffer</span>
          <input type="checkbox" aria-label="Depth buffer" disabled={readOnly} checked={settings.depth} onChange={(e) => void set({ depth: (e.currentTarget as HTMLInputElement).checked })} />
        </label>
        {choice("Filter", "filter", [["linear", "Linear"], ["point", "Point"]])}
        {choice("Wrap", "wrap", [["clamp", "Clamp"], ["repeat", "Repeat"], ["mirror", "Mirror"]])}
      </div>
    </div>
  );
}

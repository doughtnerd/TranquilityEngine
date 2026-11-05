import { useEffect, useState } from "preact/hooks";
import type { ImportSettings } from "../../engine/scene/importSettings";
import { assetKind, fileName } from "../assetBrowser";
import { AudioPreview, LargePreview } from "./AssetPreview";
import { MaterialInspector, ShaderGraphInspector } from "./MaterialInspector";
import { ParticleEffectInspector } from "./ParticleInspector";
import { NavFormationInspector } from "./NavFormationInspector";
import { importKind, inspectedAsset, openSpriteEditor, readImportSettings, sameSettings, writeImportSettings } from "../assetImport";
import { errorStatus } from "../messages";
import { PIVOT_PRESETS, pivotLabel } from "../spriteSlicing";
import { currentProject, docVersion, status } from "../state";
import "./assetInspector.css";

/** The project's pixels per unit (100 by default, ADR 0014). */
const projectPPU = (settings: { render?: { pixelsPerUnit?: number } }) => settings.render?.pixelsPerUnit ?? 100;

/** The selected asset in the Inspector: a material's settings (ADR 0043), a shader graph (ADR 0047), or a file's import settings. */
export function AssetInspector() {
  const path = inspectedAsset.value;
  const kind = path ? assetKind(path) : null;
  if (path && kind === "particles") return <ParticleEffectInspector path={path} />;
  if (path && kind === "formation") return <NavFormationInspector path={path} />;
  if (path && (kind === "environment" || kind === "prefab")) return <PreviewInspector path={path} kind={kind} />;
  return path && kind === "material" ? <MaterialInspector path={path} /> : path && (kind === "shadergraph" || kind === "shadersubgraph") ? <ShaderGraphInspector path={path} /> : <ImportInspector />;
}

const KIND_TITLES = { image: "Image", audio: "Audio", model: "Model" } as const;

/** Environments and prefabs: no settings to edit here, just a look at them (ADR 0061). */
function PreviewInspector(props: { path: string; kind: "environment" | "prefab" }) {
  return (
    <div class="asset-inspector">
      <h3>{fileName(props.path)}</h3>
      <p class="hint">
        {props.kind === "environment"
          ? "Environment map. An Environment component lights the scene with it and can show it as the sky."
          : "Prefab. Drag it into the Hierarchy or the scene view to place a copy."}
      </p>
      <LargePreview path={props.path} />
    </div>
  );
}

/**
 * The selected image, audio file or model's import settings (ADR 0040, 0044), stored in its
 * sidecar `<file>.meta.json`. Edits are a draft until Apply writes the sidecar; Revert drops them,
 * as does selecting something else. Images open the Sprite Editor to slice them.
 */
function ImportInspector() {
  docVersion.value; // the sidecar may be rewritten (Sprite Editor, moves)
  const path = inspectedAsset.value;
  const project = currentProject.value;
  const saved = project && path ? readImportSettings(project, path) : null;
  const savedKey = saved ? JSON.stringify(saved.settings) : "";
  const [draft, setDraft] = useState<ImportSettings | null>(saved?.settings ?? null);
  useEffect(() => setDraft(saved ? structuredClone(saved.settings) : null), [path, savedKey]);
  if (!project || !path || !saved || !draft) return <p class="empty">Nothing selected</p>;
  const kind = importKind(path)!;
  const dirty = !sameSettings(draft, saved.settings);
  const set = (patch: Partial<ImportSettings>) => setDraft({ ...draft, ...patch });
  const readOnly = project.canSave ? null : "This project is read-only.";

  const apply = async () => {
    try {
      await writeImportSettings(project, path, draft);
      docVersion.value++;
      status.value = { kind: "info", text: `Saved import settings for ${fileName(path)}.` };
    } catch (err) {
      status.value = errorStatus(`Couldn't save import settings for ${fileName(path)}`, err);
    }
  };

  return (
    <div class="inspector-body asset-inspector" aria-label="Import settings">
      <div class="asset-inspector-head">
        <span class="asset-inspector-kind">{KIND_TITLES[kind]}</span>
        <span class="asset-inspector-name" title={path}>
          {fileName(path)}
        </span>
      </div>
      {kind === "image" && <ImagePreview url={project.assets.get(path)} />}
      {kind === "model" && <LargePreview path={path} />}
      {kind === "audio" && <AudioPreview path={path} />}
      {saved.problems.length > 0 && (
        <ul class="asset-inspector-problems">
          {saved.problems.map((p) => (
            <li key={p}>{p}</li>
          ))}
        </ul>
      )}
      <div class="component asset-import-card">
        <h3>Import Settings</h3>
        {kind === "image" ? (
          <>
            <label class="import-row">
              <span>Pixels Per Unit</span>
              <input
                type="number"
                min={0}
                aria-label="Pixels Per Unit"
                placeholder={`Project (${projectPPU(project.settings)})`}
                value={draft.pixelsPerUnit > 0 ? draft.pixelsPerUnit : ""}
                onChange={(e) => {
                  const v = Number((e.currentTarget as HTMLInputElement).value);
                  set({ pixelsPerUnit: Number.isFinite(v) && v > 0 ? v : 0 });
                }}
              />
            </label>
            <label class="import-row">
              <span>Filter Mode</span>
              <select aria-label="Filter Mode" value={draft.filter} onChange={(e) => set({ filter: (e.currentTarget as HTMLSelectElement).value as ImportSettings["filter"] })}>
                <option value="linear">Linear (smooth)</option>
                <option value="point">Point (pixel art)</option>
              </select>
            </label>
            <label class="import-row">
              <span>Wrap Mode</span>
              <select aria-label="Wrap Mode" value={draft.wrap} onChange={(e) => set({ wrap: (e.currentTarget as HTMLSelectElement).value as ImportSettings["wrap"] })}>
                <option value="clamp">Clamp</option>
                <option value="repeat">Repeat</option>
                <option value="mirror">Mirror</option>
              </select>
            </label>
            <label class="import-row">
              <span>Generate Mipmaps</span>
              <input type="checkbox" aria-label="Generate Mipmaps" checked={draft.mipmaps} onChange={(e) => set({ mipmaps: (e.currentTarget as HTMLInputElement).checked })} />
            </label>
            <PivotRow pivot={draft.pivot} onChange={(pivot) => set({ pivot })} />
            <div class="import-row">
              <span>Sprites</span>
              <span class="import-sprites">
                <span class="import-count">{draft.sprites.length === 0 ? "Whole image" : `${draft.sprites.length} slice${draft.sprites.length === 1 ? "" : "s"}`}</span>
                <button
                  disabled={dirty}
                  title={dirty ? "Apply or revert these settings first" : "Slice the image into named sprites"}
                  onClick={() => openSpriteEditor(path)}
                >
                  Sprite Editor…
                </button>
              </span>
            </div>
          </>
        ) : kind === "model" ? (
          <>
            <label class="import-row">
              <span>Scale</span>
              <input
                type="number"
                min={0}
                step={0.01}
                aria-label="Scale"
                title="Multiplies the model's size: 0.01 turns centimetres into metres"
                value={draft.scale}
                onChange={(e) => {
                  const v = Number((e.currentTarget as HTMLInputElement).value);
                  set({ scale: Number.isFinite(v) && v > 0 ? v : 1 });
                }}
              />
            </label>
            <label class="import-row">
              <span>Up Axis</span>
              <select aria-label="Up Axis" value={draft.upAxis} onChange={(e) => set({ upAxis: (e.currentTarget as HTMLSelectElement).value as ImportSettings["upAxis"] })}>
                <option value="y">Y up</option>
                <option value="z">Z up (Blender, 3ds Max…)</option>
              </select>
            </label>
            <label class="import-row">
              <span>Normals</span>
              <select aria-label="Normals" value={draft.normals} onChange={(e) => set({ normals: (e.currentTarget as HTMLSelectElement).value as ImportSettings["normals"] })}>
                <option value="import">From the file</option>
                <option value="calculate">Calculate</option>
              </select>
            </label>
          </>
        ) : (
          <>
            <label class="import-row">
              <span>Volume</span>
              <input
                type="number"
                min={0}
                step={0.05}
                aria-label="Volume"
                value={draft.volume}
                onChange={(e) => {
                  const v = Number((e.currentTarget as HTMLInputElement).value);
                  set({ volume: Number.isFinite(v) && v >= 0 ? v : 1 });
                }}
              />
            </label>
            <label class="import-row">
              <span>Stream</span>
              <input type="checkbox" aria-label="Stream" title="Play through HTML5 audio while loading, for long music" checked={draft.stream} onChange={(e) => set({ stream: (e.currentTarget as HTMLInputElement).checked })} />
            </label>
          </>
        )}
      </div>
      <div class="asset-inspector-actions">
        <button disabled={!dirty} onClick={() => setDraft(structuredClone(saved.settings))}>
          Revert
        </button>
        <button class="primary" disabled={!dirty || !!readOnly} title={readOnly ?? (dirty ? `Write ${fileName(path)}.meta.json` : "Nothing to apply")} onClick={() => void apply()}>
          Apply
        </button>
      </div>
      <p class="asset-inspector-note">
        Saved beside the file as <code>{fileName(path)}.meta.json</code>.
      </p>
    </div>
  );
}

function PivotRow(props: { pivot: [number, number]; onChange: (pivot: [number, number]) => void }) {
  const { pivot, onChange } = props;
  const label = pivotLabel(pivot);
  const axis = (i: 0 | 1) => (
    <input
      type="number"
      step={0.05}
      aria-label={`Pivot ${i === 0 ? "X" : "Y"}`}
      value={pivot[i]}
      onChange={(e) => {
        const v = Number((e.currentTarget as HTMLInputElement).value);
        if (!Number.isFinite(v)) return;
        onChange(i === 0 ? [v, pivot[1]] : [pivot[0], v]);
      }}
    />
  );
  return (
    <div class="import-row">
      <span>Pivot</span>
      <span class="import-pivot">
        <select
          aria-label="Pivot"
          value={label}
          onChange={(e) => {
            const preset = PIVOT_PRESETS.find((p) => p.label === (e.currentTarget as HTMLSelectElement).value);
            if (preset) onChange([...preset.pivot]);
          }}
        >
          {PIVOT_PRESETS.map((p) => (
            <option key={p.label} value={p.label}>
              {p.label}
            </option>
          ))}
          {label === "Custom" && <option value="Custom">Custom</option>}
        </select>
        {axis(0)}
        {axis(1)}
      </span>
    </div>
  );
}

export { PivotRow };

function ImagePreview(props: { url: unknown }) {
  const [size, setSize] = useState<[number, number] | null>(null);
  if (typeof props.url !== "string") return null;
  return (
    <div class="asset-inspector-preview">
      <img src={props.url} alt="" draggable={false} onLoad={(e) => setSize([(e.currentTarget as HTMLImageElement).naturalWidth, (e.currentTarget as HTMLImageElement).naturalHeight])} />
      {size && (
        <span class="asset-inspector-size">
          {size[0]} × {size[1]} px
        </span>
      )}
    </div>
  );
}

// A model's import settings (ADR 0044, 0089, 0118) in the Inspector: the Meshes plugin's `model`
// kind's `importSettings` (ADR 0143), loaded the first time a model is inspected. The shell's import
// Inspector owns the sidecar, Apply and Revert.
import { useEffect, useState } from "preact/hooks";
import { DEFAULT_SLOT, loadMeshes, materialSlots } from "../../../engine/scene/models";
import { assetKind, fileName } from "../../../editor/assetBrowser";
import { extractModelMaterials } from "../../../editor/materialExtract";
import { errorStatus } from "../../../editor/messages";
import type { ImportSettingsViewProps } from "../../../editor/sdk";
import { currentProject, docVersion, status } from "../../../editor/state";
import type { ImportSettings } from "../../../engine/scene/importSettings";

/** The Import Settings card's rows for a model. */
export function ModelImportSettings(props: ImportSettingsViewProps) {
  const { path, draft, set, dirty, readOnly } = props;
  return (
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
        <label class="import-row" title="Where a dropped model's parts turn: about the model's origin, or about their own node in the file (ADR 0118)">
          <span>Pivots</span>
          <select aria-label="Pivots" value={draft.pivots} onChange={(e) => set({ pivots: (e.currentTarget as HTMLSelectElement).value as ImportSettings["pivots"] })}>
            <option value="model">Model origin</option>
            <option value="node">Node</option>
          </select>
        </label>
        <ModelMaterialRows path={path} materials={draft.materials} dirty={dirty} readOnly={readOnly} onChange={(materials) => set({ materials })} />
    </>
  );
}

/**
 * A model's material slots (ADR 0089): a material asset to draw in place of each of the model's own
 * materials (empty: its own), and Extract Materials, which writes them out as material assets.
 */
function ModelMaterialRows(props: { path: string; materials: Record<string, string>; dirty: boolean; readOnly: string | null; onChange: (materials: Record<string, string>) => void }) {
  const { path, materials } = props;
  const [slots, setSlots] = useState<string[] | null>(null);
  const [busy, setBusy] = useState(false);
  const project = currentProject.value;
  useEffect(() => {
    let live = true;
    setSlots(null);
    loadMeshes(`asset:${path}`)
      .then((meshes) => live && setSlots(materialSlots(meshes).filter((s) => s.surface !== DEFAULT_SLOT).map((s) => s.name)))
      .catch(() => live && setSlots([]));
    return () => {
      live = false;
    };
  }, [path, docVersion.value]);
  const extract = async () => {
    if (!project) return;
    setBusy(true);
    try {
      const result = await extractModelMaterials(project, path);
      docVersion.value++;
      const count = Object.keys(result.materials).length;
      const lost = result.lost.length ? ` Not kept: ${result.lost.join("; ")}.` : "";
      status.value = { kind: "info", text: `Extracted ${count} material${count === 1 ? "" : "s"} from ${fileName(path)}.${lost}` };
    } catch (err) {
      status.value = errorStatus(`Couldn't extract the materials of ${fileName(path)}`, err);
    } finally {
      setBusy(false);
    }
  };
  const files = (project?.files ?? []).filter((f) => assetKind(f) === "material" || assetKind(f) === "shadergraph");
  return (
    <>
      <div class="import-row">
        <span>Materials</span>
        <span class="import-sprites">
          <span class="import-count">{slots === null ? "Loading…" : slots.length === 0 ? "None" : `${slots.length} slot${slots.length === 1 ? "" : "s"}`}</span>
          <button
            disabled={busy || props.dirty || !!props.readOnly || !slots?.length}
            title={props.readOnly ?? (props.dirty ? "Apply or revert these settings first" : "Write each material out as a material asset and use them")}
            onClick={() => void extract()}
          >
            Extract Materials
          </button>
        </span>
      </div>
      <datalist id="model-material-list">
        {files.map((f) => (
          <option key={f} value={`asset:${f}`} />
        ))}
      </datalist>
      {(slots ?? []).map((name) => (
        <label class="import-row import-slot" key={name}>
          <span title={name}>{name}</span>
          <input
            type="text"
            list="model-material-list"
            aria-label={`Material ${name}`}
            placeholder="The model's own"
            value={materials[name] ?? ""}
            onChange={(e) => {
              const v = (e.currentTarget as HTMLInputElement).value.trim();
              const next = { ...materials };
              if (v) next[name] = v;
              else delete next[name];
              props.onChange(next);
            }}
          />
        </label>
      ))}
    </>
  );
}


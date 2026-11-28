// A model's import settings (ADR 0044, 0089, 0118) in the Inspector: the Meshes plugin's `model`
// kind's `importSettings` (ADR 0143), loaded the first time a model is inspected. The shell's import
// Inspector owns the sidecar, Apply and Revert.
import { useEffect, useState } from "preact/hooks";
import { DEFAULT_SLOT, loadMeshes, materialSlots } from "../../../engine/scene/models";
import { extractModelMaterials } from "../../../editor/materialExtract";
import { editor, type ImportSettingsViewProps } from "../../../editor/sdk";
import type { ImportSettings } from "../../../engine/scene/importSettings";
import type { LodSettings, OccluderSetting } from "../../../engine/scene/lod/types";
import type { ModelMesh } from "../../../engine/scene/models";
import "./modelImportSettings.css";
import { addLevel, canAddLevel, editLevel, levelReports, modelTriangles, removeLevel, setGenerate, setPixelError, shortWarning, suggestsLods, MAX_LOD_LEVELS } from "./modelImportSettingsLogic";

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
        <label class="import-row" title="Which way the file's front (+Z, glTF's) faces in the engine; Back keeps how models looked before ADR 0164">
          <span>Facing</span>
          <select aria-label="Facing" value={draft.facing} onChange={(e) => set({ facing: (e.currentTarget as HTMLSelectElement).value as ImportSettings["facing"] })}>
            <option value="forward">Forward (+Z)</option>
            <option value="back">Back (-Z)</option>
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
        <ModelLodRows path={path} lod={draft.lod} occluder={draft.occluder} dirty={dirty} readOnly={readOnly} onLod={(lod) => set({ lod })} onOccluder={(occluder) => set({ occluder })} />
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
  const project = editor.project.current;
  useEffect(() => {
    let live = true;
    setSlots(null);
    loadMeshes(`asset:${path}`)
      .then((meshes) => live && setSlots(materialSlots(meshes).filter((s) => s.surface !== DEFAULT_SLOT).map((s) => s.name)))
      .catch(() => live && setSlots([]));
    return () => {
      live = false;
    };
  }, [path, editor.project.version]);
  const extract = async () => {
    if (!project) return;
    setBusy(true);
    try {
      const result = await extractModelMaterials(project, path);
      editor.project.changed();
      const count = Object.keys(result.materials).length;
      const lost = result.lost.length ? ` Not kept: ${result.lost.join("; ")}.` : "";
      editor.messages.info(`Extracted ${count} material${count === 1 ? "" : "s"} from ${editor.assets.fileName(path)}.${lost}`);
    } catch (err) {
      editor.messages.failed(`Couldn't extract the materials of ${editor.assets.fileName(path)}`, err);
    } finally {
      setBusy(false);
    }
  };
  const files = (project?.files ?? []).filter((f) => editor.assets.kindOf(f) === "material" || editor.assets.kindOf(f) === "shadergraph");
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


const OCCLUDER_CHOICES: readonly { value: OccluderSetting; label: string; title: string }[] = [
  { value: "auto", label: "Automatic", title: "A simplified stand-in where the mesh is a good occluder" },
  { value: "lod", label: "Coarsest LOD", title: "Occlusion culling uses the coarsest generated level" },
  { value: "none", label: "None", title: "This model never hides other things" },
];

const percent = (n: number) => `${Math.round(n * 1000) / 10}%`;

/**
 * Generated LOD levels (ADR 0446 §1, §7): the "Generate LODs" switch, the level rows and options, the occluder choice,
 * and, once the model has loaded, what each level reached.
 */
function ModelLodRows(props: { path: string; lod: LodSettings | null; occluder: OccluderSetting; dirty: boolean; readOnly: string | null; onLod: (lod: LodSettings | null) => void; onOccluder: (o: OccluderSetting) => void }) {
  const { path, lod } = props;
  const [meshes, setMeshes] = useState<readonly ModelMesh[] | null>(null);
  useEffect(() => {
    let live = true;
    setMeshes(null);
    loadMeshes(`asset:${path}`)
      .then((m) => live && setMeshes(m))
      .catch(() => live && setMeshes([]));
    return () => {
      live = false;
    };
  }, [path, editor.project.version]);
  const locked = !!props.readOnly;
  const triangles = meshes ? modelTriangles(meshes) : 0;
  const reports = meshes && lod ? levelReports(meshes, lod) : null;
  const warning = lod ? shortWarning(reports, lod) : null;
  const num = (e: Event) => Number((e.currentTarget as HTMLInputElement).value);
  const flag = (key: "attributes" | "permissive" | "lockBorders", label: string, title: string) => (
    <label class="import-row" title={title}>
      <span>{label}</span>
      <input type="checkbox" aria-label={label} checked={lod![key]} disabled={locked} onChange={(e) => props.onLod({ ...lod!, [key]: (e.currentTarget as HTMLInputElement).checked })} />
    </label>
  );
  return (
    <>
      <label class="import-row" title="Generate simpler copies of each mesh when the model is imported, for an LODGroup to draw from far away (ADR 0446)">
        <span>Generate LODs</span>
        <input type="checkbox" aria-label="Generate LODs" checked={lod !== null} disabled={locked} onChange={(e) => props.onLod(setGenerate(lod, (e.currentTarget as HTMLInputElement).checked))} />
      </label>
      {suggestsLods(lod, triangles) && (
        <p class="lod-import-note" role="note">
          This model has {triangles.toLocaleString()} triangles: Generate LODs would let it draw fewer of them from far away.
        </p>
      )}
      {lod && (
        <>
          <div class="lod-import-levels" role="group" aria-label="LOD levels">
            <div class="lod-import-head" aria-hidden="true">
              <span>Level</span>
              <span>Triangles</span>
              <span>Error</span>
              <span />
            </div>
            {lod.levels.map((l, i) => {
              const r = reports?.find((x) => x.level === i + 1);
              return (
                <div class="lod-import-level" key={i}>
                  <span class="lod-import-name" style={{ color: `var(--lod${Math.min(i + 1, 7)})` }}>
                    LOD{i + 1}
                  </span>
                  <input type="number" min={0.01} max={0.99} step={0.05} aria-label={`LOD${i + 1} ratio`} title="Triangle target, relative to LOD0" value={l.ratio} disabled={locked} onChange={(e) => props.onLod(editLevel(lod, i, { ratio: num(e) }))} />
                  <input type="number" min={0} step={0.005} aria-label={`LOD${i + 1} error`} title="Error limit, as a fraction of the model's size" value={l.error} disabled={locked} onChange={(e) => props.onLod(editLevel(lod, i, { error: num(e) }))} />
                  <button class="icon" aria-label={`Remove LOD${i + 1}`} title="Remove this level" disabled={locked || lod.levels.length <= 1} onClick={() => props.onLod(removeLevel(lod, i))}>
                    ×
                  </button>
                  {r && (
                    <span class={`lod-import-reached${r.short ? " short" : ""}`} aria-label={`LOD${i + 1} reached`}>
                      reached {r.triangles.toLocaleString()} triangles ({percent(r.reached)}), error {percent(r.error)}
                    </span>
                  )}
                </div>
              );
            })}
            <button disabled={locked || !canAddLevel(lod)} title={lod.levels.length >= MAX_LOD_LEVELS ? `At most ${MAX_LOD_LEVELS} levels` : "Add a coarser level"} onClick={() => props.onLod(addLevel(lod))}>
              Add Level
            </button>
          </div>
          {reports === null && meshes && meshes.length > 0 && !props.dirty && <p class="lod-import-note">The levels appear here once the model has generated them.</p>}
          {reports && props.dirty && <p class="lod-import-note">Reached values are from the applied settings; Apply to generate the new ones.</p>}
          {warning && (
            <p class="lod-import-warning" role="alert">
              {warning}
            </p>
          )}
          {flag("attributes", "Attributes", "Weigh normals, UVs and vertex colours while simplifying (off: positions only)")}
          {flag("permissive", "Permissive", "Let hard edges and seams collapse: needed for boxy, flat-shaded meshes")}
          {flag("lockBorders", "Lock borders", "Keep open borders exactly, for terrain tiles that must meet their neighbours")}
          <label class="import-row" title="The screen error, in pixels at 1080p, that sets the automatic transition heights">
            <span>Pixel error</span>
            <input type="number" min={0.1} step={0.1} aria-label="Pixel error" value={lod.pixelError} disabled={locked} onChange={(e) => props.onLod(setPixelError(lod, num(e)))} />
          </label>
        </>
      )}
      <label class="import-row" title="The stand-in occlusion culling rasterises for this model (ADR 0447)">
        <span>Occluder</span>
        <select aria-label="Occluder" value={props.occluder} disabled={locked} onChange={(e) => props.onOccluder((e.currentTarget as HTMLSelectElement).value as OccluderSetting)}>
          {OCCLUDER_CHOICES.map((c) => (
            <option key={c.value} value={c.value} title={c.title}>
              {c.label}
            </option>
          ))}
        </select>
      </label>
    </>
  );
}

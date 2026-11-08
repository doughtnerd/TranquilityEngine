// A NavGroup's formation preview in the Inspector (ADR 0065; Foxfire's NavFormationEditor): under a NavGroup's fields,
// a picture of its formation asset's mask with Edit (selects the asset), or Create formation asset. The formation
// asset's own Inspector view (painting the mask and so on) is the Navigation plugin's (`src/plugins/navigation/editor/`).
import { useLayoutEffect, useRef } from "preact/hooks";
import { defaultFormation, formationSlotCount, formationFillOrder, type NavFormationAsset } from "../../../engine/nav/formation";
import { fileName } from "../../../editor/assetBrowser";
import { showAsset } from "../../../editor/assetImport";
import { SetField } from "../../../editor/document";
import { createFormation, readFormation } from "./formationAssets";
import { currentProject, docVersion, type OpenScene } from "../../../editor/state";
import { theme } from "../../../editor/theme";
import "../../../editor/ui/assetInspector.css";
import "./navFormation.css";
import { sectionField, type InspectorSectionProps } from "../../../editor/ui/inspectorSections";

const MAX_NUMBERED = 64;

/** A theme token's value on an element (canvas drawing can't use `var()`). */
const token = (el: Element, name: string, fallback: string) => getComputedStyle(el).getPropertyValue(name).trim() || fallback;

/** Draws a formation's grid on a canvas: painted cells in the accent colour, grid lines, optional fill order numbers. */
export function drawFormation(canvas: HTMLCanvasElement, f: NavFormationAsset, cell: number, showOrder: boolean): void {
  const ratio = window.devicePixelRatio || 1;
  const w = f.width * cell, h = f.height * cell;
  canvas.style.width = `${w}px`;
  canvas.style.height = `${h}px`;
  canvas.width = Math.max(1, Math.round(w * ratio));
  canvas.height = Math.max(1, Math.round(h * ratio));
  const g = canvas.getContext("2d");
  if (!g) return;
  g.setTransform(ratio, 0, 0, ratio, 0, 0);
  g.fillStyle = token(canvas, "--input-bg", "#06090a");
  g.fillRect(0, 0, w, h);
  g.fillStyle = token(canvas, "--accent", "#2ad4d4");
  for (let row = 0; row < f.height; row++) for (let x = 0; x < f.width; x++) if (f.cells[row * f.width + x]) g.fillRect(x * cell, row * cell, cell, cell);
  if (cell >= 6) {
    g.fillStyle = token(canvas, "--border", "#283435");
    for (let x = 0; x <= f.width; x++) g.fillRect(x * cell - 0.5, 0, 1, h);
    for (let row = 0; row <= f.height; row++) g.fillRect(0, row * cell - 0.5, w, 1);
  }
  if (!showOrder || cell < 14) return;
  const order = formationFillOrder(f);
  g.fillStyle = token(canvas, "--accent-text", "#040607");
  g.font = `${Math.min(11, cell - 4)}px sans-serif`;
  g.textAlign = "center";
  g.textBaseline = "middle";
  for (let i = 0; i < Math.min(order.length, MAX_NUMBERED); i++) {
    const row = Math.floor(order[i] / f.width), x = order[i] - row * f.width;
    g.fillText(String(i), x * cell + cell / 2, row * cell + cell / 2);
  }
}

// ------------------------------------------------------------------------------------------- NavGroup

/** A small, read-only picture of a formation's mask. */
function FormationThumb(props: { formation: NavFormationAsset }) {
  const canvas = useRef<HTMLCanvasElement>(null);
  theme.value;
  const f = props.formation;
  const cell = Math.max(1, Math.min(6, Math.floor(120 / Math.max(f.width, f.height))));
  useLayoutEffect(() => {
    if (canvas.current) drawFormation(canvas.current, f, cell, false);
  });
  return <canvas ref={canvas} class="nav-formation-thumb" aria-label="Formation preview" />;
}

/**
 * Under a NavGroup's fields: when its formation is "mask" or it has a formation asset, a preview of the asset's mask
 * and Edit, or Create formation asset (which assigns the new asset to the group).
 */
export function NavGroupFormation(props: { scene: OpenScene; nodeId: string; index: number; formation: string; formationAsset: string }) {
  docVersion.value;
  const project = currentProject.value;
  if (!project) return null;
  const ref = props.formationAsset.replace(/^asset:/, "");
  if (!ref && props.formation !== "mask") return null;
  const exists = ref !== "" && project.files.includes(ref);
  const asset = exists ? readFormation(project, ref).formation : null;
  const create = async () => {
    const name = props.scene.doc.has(props.nodeId) ? props.scene.doc.node(props.nodeId).name : "";
    const made = await createFormation("", { ...defaultFormation(), shape: "mask" }, name ? `${name} Formation` : "New Formation");
    if (!made) return;
    props.scene.stack.execute(new SetField(props.nodeId, "engine.NavGroup", "formationAsset", `asset:${made}`, { index: props.index }));
    showAsset(made);
  };
  return (
    <div class="nav-group-formation" aria-label="Group formation">
      {asset ? (
        <>
          <div class="nav-group-formation-head">
            <span title={ref}>{fileName(ref)}</span>
            <span class="nav-group-formation-meta">
              {asset.shape === "mask" ? `${asset.width} × ${asset.height}, ${formationSlotCount(asset)} slots` : `preset: ${asset.shape}`}
            </span>
          </div>
          {asset.shape === "mask" && <FormationThumb formation={asset} />}
          <button onClick={() => showAsset(ref)} title="Select the formation asset to paint it">
            Edit
          </button>
        </>
      ) : (
        <>
          <p class="hint">
            {ref ? `The formation asset ${ref} is missing.` : "Mask formation: paint it in a formation asset (or set it from a script with setMask)."}
          </p>
          <button disabled={!project.canSave} onClick={() => void create()}>
            Create formation asset
          </button>
        </>
      )}
    </div>
  );
}

/** The Inspector section under a top-level NavGroup: the formation preview (ADR 0065, 0131). */
export function NavGroupSection({ scene, paths, info }: InspectorSectionProps) {
  return (
    <NavGroupFormation
      scene={scene}
      nodeId={paths[0][0]}
      index={info.index}
      formation={String(sectionField(info, "formation") ?? "")}
      formationAsset={String(sectionField(info, "formationAsset") ?? "")}
    />
  );
}

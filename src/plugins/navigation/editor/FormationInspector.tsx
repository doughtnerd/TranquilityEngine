// Formation assets in the Inspector (ADR 0065; Foxfire's NavFormationEditor; the Navigation plugin's editor half): a
// `*.formation.json` selected in the Assets panel shows its shape, layers and layer spacing, and for a Mask a grid to
// paint (left drag paints, right drag or Shift+left erases), its size (Resize keeps the painted cells), Clear / Fill
// all / Invert / Mirror, Import from an image and "Show fill order", which numbers the cells in the order members take
// them. Every edit writes the file through the formation's asset document and can be undone (Ctrl+Z / Ctrl+Shift+Z
// over the inspector, or the Undo / Redo buttons).
import { useEffect, useLayoutEffect, useRef, useState } from "preact/hooks";
import {
  FORMATION_SHAPES,
  MAX_FORMATION_LAYERS,
  MAX_FORMATION_SIZE,
  clearFormation,
  fillFormation,
  formationCell,
  formationFromPixels,
  formationImportSize,
  formationSlotCount,
  invertFormation,
  mirrorFormation,
  resizeFormation,
  setFormationCell,
  type FormationShape,
  type NavFormationAsset,
} from "../../../engine/nav/formation";
import { assetKind, fileName } from "../../../editor/assetBrowser";
import { openAssetDocument } from "../../../editor/assetDocuments";
import { errorStatus } from "../../../editor/messages";
import type { EditorProject } from "../../../editor/projects";
import { currentProject, docVersion, status } from "../../../editor/state";
import { theme } from "../../../editor/theme";
import { drawFormation } from "./NavGroupSection";
import "../../../editor/ui/assetInspector.css";
import "./navFormation.css";

const SHAPE_LABELS: Record<FormationShape, string> = { box: "Box", line: "Line", column: "Column", wedge: "Wedge", circle: "Circle", mask: "Mask (painted)" };
const MAX_CELL = 24;

/** The selected formation asset (see the file comment). Edits go through the formation's asset document: one undo step each, one per paint stroke. */
export function NavFormationInspector(props: { path: string }) {
  docVersion.value; // the project's files (the import's image list)
  theme.value; // the grid's colours
  const { path } = props;
  const project = currentProject.value;
  const [showOrder, setShowOrder] = useState(false);
  if (!project) return <p class="empty">Nothing selected</p>;
  const doc = openAssetDocument<NavFormationAsset>(project, path, "formation");
  const formation = doc.value.value;
  const problems = doc.problems.value.map((p) => p.message);
  const readOnly = doc.readOnly;
  useEffect(() => () => void doc.flush(), [doc]); // write a pending paint stroke when the inspector closes

  /** Replace the formation: one undo step, or (`coalesce`, the cells of a paint stroke) merged with the stroke's other cells. */
  const apply = (next: NavFormationAsset, coalesce = false) => {
    if (next === doc.value.peek() || readOnly) return;
    doc.edit(next, coalesce ? { coalesce: true } : undefined);
  };
  const set = (patch: Partial<NavFormationAsset>) => apply({ ...formation, ...patch });
  const undo = () => (doc.canUndo.peek() ? doc.undo() : (status.value = { kind: "info", text: "Nothing to undo in this formation." }));
  const redo = () => (doc.canRedo.peek() ? doc.redo() : (status.value = { kind: "info", text: "Nothing to redo in this formation." }));

  const onKeyDown = (e: KeyboardEvent) => {
    const t = e.target as HTMLElement;
    if (!(e.ctrlKey || e.metaKey) || t.closest("input, select, textarea")) return;
    const key = e.key.toLowerCase();
    if (key !== "z" && key !== "y") return;
    e.preventDefault();
    e.stopPropagation(); // the formation's history, not the scene's
    if (key === "y" || e.shiftKey) redo();
    else undo();
  };

  return (
    <div class="inspector-body asset-inspector nav-formation" aria-label="Formation" data-asset-document={doc.path} tabIndex={-1} onKeyDown={onKeyDown}>
      <div class="asset-inspector-head">
        <span class="asset-inspector-kind">Formation</span>
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
        <h3>Formation</h3>
        <label class="import-row">
          <span>Shape</span>
          <select aria-label="Shape" disabled={readOnly} value={formation.shape} onChange={(e) => set({ shape: (e.currentTarget as HTMLSelectElement).value as FormationShape })}>
            {FORMATION_SHAPES.map((s) => (
              <option key={s} value={s}>
                {SHAPE_LABELS[s]}
              </option>
            ))}
          </select>
        </label>
        <label class="import-row" title="Flyer groups: how many layers deep the formation is stacked vertically. Groups that walk ignore it.">
          <span>Layers</span>
          <input type="number" min={1} max={MAX_FORMATION_LAYERS} step={1} aria-label="Layers" disabled={readOnly} value={formation.layers} onChange={(e) => {
            const v = Math.round(Number((e.currentTarget as HTMLInputElement).value));
            if (Number.isFinite(v)) set({ layers: Math.min(MAX_FORMATION_LAYERS, Math.max(1, v)) });
          }} />
        </label>
        <label class="import-row" title="Flyer groups: height between layers. 0: the group's Spacing.">
          <span>Layer Spacing</span>
          <input type="number" min={0} step={0.1} aria-label="Layer Spacing" disabled={readOnly} value={formation.layerSpacing} onChange={(e) => {
            const v = Number((e.currentTarget as HTMLInputElement).value);
            if (Number.isFinite(v)) set({ layerSpacing: Math.max(0, v) });
          }} />
        </label>
        <div class="nav-formation-history">
          <button disabled={readOnly || !doc.canUndo.value} onClick={undo} title="Undo the last edit to this formation (Ctrl+Z)">
            Undo
          </button>
          <button disabled={readOnly || !doc.canRedo.value} onClick={redo} title="Redo (Ctrl+Shift+Z)">
            Redo
          </button>
        </div>
        {formation.shape !== "mask" ? (
          <p class="hint">This preset is laid out by count at runtime: the group's size decides how many slots it has. Choose Mask to paint the cells yourself.</p>
        ) : (
          <>
            <FormationSize formation={formation} readOnly={readOnly} onResize={(w, h) => apply(resizeFormation(formation, w, h))} />
            <FormationGrid formation={formation} readOnly={readOnly} showOrder={showOrder} apply={apply} />
            <div class="nav-formation-row">
              <span aria-label="Slot count">{formationSlotCount(formation)} slots</span>
              <label class="nav-formation-check">
                <input type="checkbox" aria-label="Show fill order" checked={showOrder} onChange={(e) => setShowOrder((e.currentTarget as HTMLInputElement).checked)} />
                Show fill order
              </label>
            </div>
            <div class="nav-formation-tools">
              <button disabled={readOnly} onClick={() => apply(clearFormation(formation))}>Clear</button>
              <button disabled={readOnly} onClick={() => apply(fillFormation(formation))}>Fill all</button>
              <button disabled={readOnly} onClick={() => apply(invertFormation(formation))}>Invert</button>
              <button disabled={readOnly} title="Copy the left half onto the right, mirrored" onClick={() => apply(mirrorFormation(formation))}>
                Mirror
              </button>
            </div>
            <FormationImport project={project} formation={formation} readOnly={readOnly} apply={apply} />
          </>
        )}
      </div>
    </div>
  );
}

/** Width and height, applied on change (Enter or leaving the field) through Resize, which keeps the painted cells. */
function FormationSize(props: { formation: NavFormationAsset; readOnly: boolean; onResize: (w: number, h: number) => void }) {
  const { formation: f } = props;
  const field = (label: string, value: number, apply: (v: number) => void) => (
    <label class="import-row">
      <span>{label}</span>
      <input type="number" min={1} max={MAX_FORMATION_SIZE} step={1} aria-label={label} disabled={props.readOnly} value={value} onChange={(e) => {
        const v = Math.round(Number((e.currentTarget as HTMLInputElement).value));
        if (Number.isFinite(v)) apply(Math.min(MAX_FORMATION_SIZE, Math.max(1, v)));
      }} />
    </label>
  );
  return (
    <>
      {field("Width", f.width, (w) => w !== f.width && props.onResize(w, f.height))}
      {field("Height", f.height, (h) => h !== f.height && props.onResize(f.width, h))}
    </>
  );
}

/** The paintable grid (row 0, the front, on top). */
function FormationGrid(props: { formation: NavFormationAsset; readOnly: boolean; showOrder: boolean; apply: (next: NavFormationAsset, coalesce?: boolean) => void }) {
  const { formation: f } = props;
  const wrap = useRef<HTMLDivElement>(null);
  const canvas = useRef<HTMLCanvasElement>(null);
  const [available, setAvailable] = useState(280);
  const paint = useRef<{ on: boolean; current: NavFormationAsset } | null>(null);
  const cell = Math.floor(Math.min(MAX_CELL, Math.max(2, available / Math.max(f.width, f.height))));

  useLayoutEffect(() => {
    const el = wrap.current;
    if (!el) return;
    const measure = () => setAvailable(Math.max(20, el.clientWidth - 2));
    measure();
    if (typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  useLayoutEffect(() => {
    if (canvas.current) drawFormation(canvas.current, f, cell, props.showOrder);
  });

  const cellAt = (e: PointerEvent): [number, number] => {
    const r = canvas.current!.getBoundingClientRect();
    return [Math.floor((e.clientX - r.left) / cell), Math.floor((e.clientY - r.top) / cell)];
  };
  const paintAt = (e: PointerEvent) => {
    const p = paint.current;
    if (!p) return;
    const [x, row] = cellAt(e);
    if (x < 0 || row < 0 || x >= p.current.width || row >= p.current.height || formationCell(p.current, x, row) === p.on) return;
    const next = setFormationCell(p.current, x, row, p.on);
    props.apply(next, true); // the stroke's cells merge into one undo step and one write
    p.current = next;
  };

  return (
    <div class="nav-formation-grid" ref={wrap}>
      <div class="nav-formation-front">Front</div>
      <canvas
        ref={canvas}
        aria-label="Formation grid"
        data-width={f.width}
        data-height={f.height}
        data-cell={cell}
        class={props.readOnly ? "read-only" : ""}
        onContextMenu={(e) => e.preventDefault()}
        onPointerDown={(e) => {
          if (props.readOnly || (e.button !== 0 && e.button !== 2)) return;
          e.preventDefault();
          (e.currentTarget as HTMLCanvasElement).setPointerCapture?.(e.pointerId);
          paint.current = { on: e.button === 0 && !e.shiftKey, current: f };
          paintAt(e);
        }}
        onPointerMove={(e) => paint.current && paintAt(e)}
        onPointerUp={() => (paint.current = null)}
        onPointerCancel={() => (paint.current = null)}
      />
    </div>
  );
}

/** Loads an image asset scaled to `w` × `h` and returns its RGBA pixels (rows top to bottom). */
async function imagePixels(url: string, w: number, h: number): Promise<{ pixels: Uint8ClampedArray; natural: [number, number] }> {
  const img = new Image();
  img.crossOrigin = "anonymous";
  img.src = url;
  await img.decode();
  const c = document.createElement("canvas");
  c.width = w;
  c.height = h;
  const g = c.getContext("2d", { willReadFrequently: true })!;
  g.drawImage(img, 0, 0, w, h);
  return { pixels: g.getImageData(0, 0, w, h).data, natural: [img.naturalWidth, img.naturalHeight] };
}

async function imageSize(url: string): Promise<[number, number]> {
  const img = new Image();
  img.src = url;
  await img.decode();
  return [img.naturalWidth, img.naturalHeight];
}

/** Import from an image asset: threshold, alpha or luminance, and optionally the image's size (at most 128). */
function FormationImport(props: { project: EditorProject; formation: NavFormationAsset; readOnly: boolean; apply: (next: NavFormationAsset) => void }) {
  const { project } = props;
  const [image, setImage] = useState("");
  const [threshold, setThreshold] = useState(0.5);
  const [useAlpha, setUseAlpha] = useState(true);
  const [sizeToImage, setSizeToImage] = useState(false);
  const images = project.files.filter((f) => assetKind(f) === "image");
  const run = async () => {
    const url = project.assets.get(image);
    if (typeof url !== "string") return;
    const before = props.formation;
    try {
      const [iw, ih] = sizeToImage ? await imageSize(url) : [before.width, before.height];
      const [w, h] = formationImportSize(before, iw, ih, sizeToImage);
      const { pixels } = await imagePixels(url, w, h);
      props.apply(formationFromPixels(before, pixels, w, h, threshold, useAlpha));
    } catch (err) {
      status.value = errorStatus(`Couldn't import ${fileName(image)}`, err);
    }
  };
  return (
    <details class="nav-formation-import">
      <summary>Import from image</summary>
      <label class="import-row">
        <span>Image</span>
        <select aria-label="Import image" value={image} onChange={(e) => setImage((e.currentTarget as HTMLSelectElement).value)}>
          <option value="">None</option>
          {images.map((f) => (
            <option key={f} value={f}>
              {f}
            </option>
          ))}
        </select>
      </label>
      <label class="import-row">
        <span>Threshold</span>
        <span class="nav-formation-threshold">
          <input type="range" min={0} max={1} step={0.01} aria-label="Threshold" value={threshold} onInput={(e) => setThreshold(Number((e.currentTarget as HTMLInputElement).value))} />
          <code>{threshold.toFixed(2)}</code>
        </span>
      </label>
      <label class="import-row">
        <span>Use alpha</span>
        <input type="checkbox" aria-label="Use alpha" checked={useAlpha} onChange={(e) => setUseAlpha((e.currentTarget as HTMLInputElement).checked)} />
      </label>
      <label class="import-row">
        <span>Size to image (max 128)</span>
        <input type="checkbox" aria-label="Size to image" checked={sizeToImage} onChange={(e) => setSizeToImage((e.currentTarget as HTMLInputElement).checked)} />
      </label>
      <button disabled={props.readOnly || !image} onClick={() => void run()}>
        Import
      </button>
    </details>
  );
}

// Formation assets in the Inspector (ADR 0065; Foxfire's NavFormationEditor): a `*.formation.json` selected in the
// Assets panel shows its shape, layers and layer spacing, and for a Mask a grid to paint (left drag paints, right
// drag or Shift+left erases), its size (Resize keeps the painted cells), Clear / Fill all / Invert / Mirror,
// Import from an image and "Show fill order", which numbers the cells in the order members take them. Every edit
// writes the file and can be undone (Ctrl+Z / Ctrl+Shift+Z in the editor, or the Undo / Redo buttons).
//
// Also `NavGroupFormation`, under a NavGroup's fields: a preview of its formation asset's mask with Edit (selects
// the asset), or Create formation asset.
import { useEffect, useLayoutEffect, useRef, useState } from "preact/hooks";
import {
  FORMATION_SHAPES,
  MAX_FORMATION_LAYERS,
  MAX_FORMATION_SIZE,
  clearFormation,
  defaultFormation,
  fillFormation,
  formationCell,
  formationFillOrder,
  formationFromPixels,
  formationImportSize,
  formationSlotCount,
  invertFormation,
  mirrorFormation,
  resizeFormation,
  setFormationCell,
  type FormationShape,
  type NavFormationAsset,
} from "../../engine/nav/formation";
import { assetKind, fileName } from "../assetBrowser";
import { showAsset } from "../assetImport";
import { SetField } from "../document";
import { createFormation, editFormation, formationHistory, readFormation, redoFormation, undoFormation } from "../formationAssets";
import { errorStatus } from "../messages";
import type { EditorProject } from "../projects";
import { currentProject, docVersion, status, type OpenScene } from "../state";
import { theme } from "../theme";
import "./assetInspector.css";
import "./navFormation.css";
import { sectionField, type InspectorSectionProps } from "./inspectorSections";

const SHAPE_LABELS: Record<FormationShape, string> = { box: "Box", line: "Line", column: "Column", wedge: "Wedge", circle: "Circle", mask: "Mask (painted)" };
const MAX_CELL = 24;
const MAX_NUMBERED = 64;

/** A theme token's value on an element (canvas drawing can't use `var()`). */
const token = (el: Element, name: string, fallback: string) => getComputedStyle(el).getPropertyValue(name).trim() || fallback;

/** Draws a formation's grid on a canvas: painted cells in the accent colour, grid lines, optional fill order numbers. */
function drawFormation(canvas: HTMLCanvasElement, f: NavFormationAsset, cell: number, showOrder: boolean): void {
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

/** The selected formation asset (see the file comment). */
export function NavFormationInspector(props: { path: string }) {
  docVersion.value; // rewritten by this inspector, or on disk
  theme.value; // the grid's colours
  const { path } = props;
  const project = currentProject.value;
  const [draft, setDraft] = useState<NavFormationAsset | null>(null);
  const [showOrder, setShowOrder] = useState(false);
  const writes = useRef(0);
  useEffect(() => setDraft(null), [path]);
  if (!project) return <p class="empty">Nothing selected</p>;
  const read = readFormation(project, path);
  const formation = draft ?? read.formation;
  const readOnly = !project.canSave;
  const history = formationHistory(path);

  /** Write `next` (shown at once); `record` makes it an undo step from `before`. */
  const apply = (before: NavFormationAsset, next: NavFormationAsset, record = true) => {
    if (next === before || readOnly) return;
    setDraft(next);
    const n = ++writes.current;
    void editFormation(project, path, before, next, record).finally(() => {
      if (writes.current === n) setDraft(null);
    });
  };
  const set = (patch: Partial<NavFormationAsset>) => apply(formation, { ...formation, ...patch });
  const undo = () => void undoFormation(project, path).then((done) => done || (status.value = { kind: "info", text: "Nothing to undo in this formation." }));
  const redo = () => void redoFormation(project, path).then((done) => done || (status.value = { kind: "info", text: "Nothing to redo in this formation." }));

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
    <div class="inspector-body asset-inspector nav-formation" aria-label="Formation" tabIndex={-1} onKeyDown={onKeyDown}>
      <div class="asset-inspector-head">
        <span class="asset-inspector-kind">Formation</span>
        <span class="asset-inspector-name" title={path}>
          {fileName(path)}
        </span>
      </div>
      {read.problems.length > 0 && (
        <ul class="asset-inspector-problems">
          {read.problems.map((p) => (
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
          <button disabled={readOnly || history.undo.length === 0} onClick={undo} title="Undo the last edit to this formation (Ctrl+Z)">
            Undo
          </button>
          <button disabled={readOnly || history.redo.length === 0} onClick={redo} title="Redo (Ctrl+Shift+Z)">
            Redo
          </button>
        </div>
        {formation.shape !== "mask" ? (
          <p class="hint">This preset is laid out by count at runtime: the group's size decides how many slots it has. Choose Mask to paint the cells yourself.</p>
        ) : (
          <>
            <FormationSize formation={formation} readOnly={readOnly} onResize={(w, h) => apply(formation, resizeFormation(formation, w, h))} />
            <FormationGrid formation={formation} readOnly={readOnly} showOrder={showOrder} apply={apply} />
            <div class="nav-formation-row">
              <span aria-label="Slot count">{formationSlotCount(formation)} slots</span>
              <label class="nav-formation-check">
                <input type="checkbox" aria-label="Show fill order" checked={showOrder} onChange={(e) => setShowOrder((e.currentTarget as HTMLInputElement).checked)} />
                Show fill order
              </label>
            </div>
            <div class="nav-formation-tools">
              <button disabled={readOnly} onClick={() => apply(formation, clearFormation(formation))}>Clear</button>
              <button disabled={readOnly} onClick={() => apply(formation, fillFormation(formation))}>Fill all</button>
              <button disabled={readOnly} onClick={() => apply(formation, invertFormation(formation))}>Invert</button>
              <button disabled={readOnly} title="Copy the left half onto the right, mirrored" onClick={() => apply(formation, mirrorFormation(formation))}>
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
function FormationGrid(props: { formation: NavFormationAsset; readOnly: boolean; showOrder: boolean; apply: (before: NavFormationAsset, next: NavFormationAsset, record?: boolean) => void }) {
  const { formation: f } = props;
  const wrap = useRef<HTMLDivElement>(null);
  const canvas = useRef<HTMLCanvasElement>(null);
  const [available, setAvailable] = useState(280);
  const paint = useRef<{ on: boolean; current: NavFormationAsset; recorded: boolean } | null>(null);
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
    props.apply(p.current, next, !p.recorded); // one undo step per stroke
    p.recorded = true;
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
          paint.current = { on: e.button === 0 && !e.shiftKey, current: f, recorded: false };
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
function FormationImport(props: { project: EditorProject; formation: NavFormationAsset; readOnly: boolean; apply: (before: NavFormationAsset, next: NavFormationAsset) => void }) {
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
      props.apply(before, formationFromPixels(before, pixels, w, h, threshold, useAlpha));
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

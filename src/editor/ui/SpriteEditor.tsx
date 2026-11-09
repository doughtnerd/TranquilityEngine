import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "preact/hooks";
import { usePanelHistory, type UndoHistory } from "../activeHistory";
import { whyNotSliceName, type SpriteFill, type SpriteSlice } from "../../engine/scene/importSettings";
import { fileName } from "../assetBrowser";
import { readImportSettings, spriteEditorImage, writeImportSettings } from "../assetImport";
import { renameSliceReferences } from "../assetOps";
import { errorStatus } from "../messages";
import type { EditorProject } from "../projects";
import { canRedo, canUndo, createHistory, pushHistory, redo, undo, type History } from "../spriteHistory";
import {
  BORDER_SIDES,
  HANDLES,
  autoSlice,
  dragBorderSide,
  fitBorder,
  setBorderSide,
  gridByCellSize,
  gridByCount,
  isEmptyRect,
  moveRect,
  rectBetween,
  resizeRect,
  sliceBase,
  sliceNames,
  sliceRenames,
  type Handle,
  type Pixels,
  type Rect,
} from "../spriteSlicing";
import { currentProject, docVersion, status } from "../state";
import { PivotRow } from "./ImageImportSettings";
import { confirmInEditor } from "./ConfirmDialog";
import "./spriteEditor.css";

/** A slice being edited: `key` tells slices apart while names change; `original` is its name when editing began. */
interface EditSlice {
  key: number;
  name: string;
  rect: Rect;
  pivot: [number, number];
  border?: [number, number, number, number];
  fill?: SpriteFill;
  original: string | null;
}

type SliceMode = "count" | "size" | "auto";

let nextKey = 1;
const fromSaved = (s: SpriteSlice): EditSlice => ({ key: nextKey++, name: s.name, rect: [...s.rect], pivot: [...s.pivot], border: s.border ? [...s.border] : undefined, fill: s.fill, original: s.name });
const asSaved = (slices: readonly EditSlice[]): SpriteSlice[] =>
  slices.map((s) => ({ name: s.name, rect: [...s.rect], pivot: [...s.pivot], ...(s.border && s.border.some((b) => b !== 0) ? { border: [...s.border] } : {}), ...(s.fill === "tile" ? { fill: "tile" as const } : {}) }));
const sliceKey = (slices: readonly EditSlice[]) => JSON.stringify(asSaved(slices));

/** The image's pixels (for automatic slicing and skipping empty cells). */
async function loadPixels(url: string): Promise<Pixels> {
  const img = new Image();
  img.src = url;
  await img.decode();
  const canvas = document.createElement("canvas");
  canvas.width = img.naturalWidth;
  canvas.height = img.naturalHeight;
  const ctx = canvas.getContext("2d", { willReadFrequently: true })!;
  ctx.drawImage(img, 0, 0);
  return ctx.getImageData(0, 0, canvas.width, canvas.height);
}

/** The Sprite Editor (ADR 0040), over the editor while an image is open in it. */
export function SpriteEditorDialog() {
  const image = spriteEditorImage.value;
  const project = currentProject.value;
  if (!image || !project) return null;
  return <SpriteEditor key={image} project={project} image={image} />;
}

/**
 * Slice an image into named sprites: drag on the image to draw a rectangle, drag one to move it,
 * drag its handles to resize it; or slice by a grid (cell count or size) or automatically by
 * transparent gaps. The selected slice's name, rectangle, pivot and 9-slice border are edited at
 * the side. Apply writes the slices into the image's sidecar and updates references to renamed
 * slices; Revert goes back to what's saved.
 */
function SpriteEditor(props: { project: EditorProject; image: string }) {
  const { project, image } = props;
  const url = project.assets.get(image);
  const [history, setHistory] = useState<History<EditSlice[]>>(() => createHistory(readImportSettings(project, image).settings.sprites.map(fromSaved)));
  const slices = history.present;
  const [baseline, setBaseline] = useState(() => sliceKey(slices));
  /** Edit the slices as one undo step; edits sharing a `key` in a row (one drag, one field) are one step. */
  const setSlices = (next: EditSlice[] | ((all: EditSlice[]) => EditSlice[]), key?: string) =>
    setHistory((h) => pushHistory(h, typeof next === "function" ? next(h.present) : next, { key, equal: (a, b) => sliceKey(a) === sliceKey(b) }));
  const gesture = useRef(0);
  const newGesture = () => `gesture:${++gesture.current}`;
  const [selected, setSelected] = useState<number | null>(null);
  const [size, setSize] = useState<[number, number] | null>(null);
  const [zoom, setZoom] = useState(1);
  const [drawing, setDrawing] = useState<Rect | null>(null);
  const [mode, setMode] = useState<SliceMode>("count");
  const [grid, setGrid] = useState({ columns: 2, rows: 2, width: 16, height: 16, offsetX: 0, offsetY: 0, paddingX: 0, paddingY: 0, minSize: 2, skipEmpty: true });
  const [nameDraft, setNameDraft] = useState<{ key: number; text: string; problem: string | null } | null>(null);
  const [busy, setBusy] = useState(false);
  const stage = useRef<HTMLDivElement>(null);
  const viewport = useRef<HTMLDivElement>(null);
  const dialog = useRef<HTMLDivElement>(null);
  const pixels = useRef<Promise<Pixels> | null>(null);
  const dirty = sliceKey(slices) !== baseline;
  const readOnly = project.canSave ? null : "This project is read-only.";
  const current = slices.find((s) => s.key === selected) ?? null;
  const [W, H] = size ?? [0, 0];

  useEffect(() => dialog.current?.focus(), []);

  // Fit the image in view once its size is known.
  useLayoutEffect(() => {
    if (!size || !viewport.current) return;
    const r = viewport.current.getBoundingClientRect();
    const fit = Math.min((r.width - 24) / size[0], (r.height - 24) / size[1]);
    setZoom(Math.max(0.05, Math.min(16, fit > 1 ? Math.floor(fit) : fit)));
  }, [size]);

  if (typeof url !== "string") return null;
  const getPixels = () => (pixels.current ??= loadPixels(url));

  const update = (key: number, patch: Partial<EditSlice>, gestureKey?: string) => setSlices((all) => all.map((s) => (s.key === key ? { ...s, ...patch } : s)), gestureKey);
  /** The selection after the slices changed under it (undo, redo): dropped when its slice is gone. */
  const keepSelection = (h: History<EditSlice[]>) => setSelected((k) => (k !== null && h.present.some((s) => s.key === k) ? k : null));
  const stepBack = () => {
    const h = undo(history);
    setHistory(h);
    keepSelection(h);
  };
  const stepForward = () => {
    const h = redo(history);
    setHistory(h);
    keepSelection(h);
  };
  // The editor's snapshots are the active history while it's open and focused (ADR 0145): Ctrl+Z reaches
  // the editor's shortcuts, which undo them. Made anew for each history, so the Edit menu follows.
  const panelHistory = useMemo<UndoHistory>(() => ({ name: "Sprite Editor", canUndo: canUndo(history), canRedo: canRedo(history), undo: stepBack, redo: stepForward }), [history]);
  usePanelHistory(dialog, panelHistory);
  const remove = (key: number) => {
    setSlices((all) => all.filter((s) => s.key !== key));
    if (selected === key) setSelected(null);
  };
  const addRects = (rects: Rect[], replace: boolean) => {
    const base = sliceBase(image);
    const keep = replace ? [] : slices;
    const savedNames = slices.map((s) => s.original).filter((n): n is string => !!n);
    const names = sliceNames(base, rects.length, keep.map((s) => s.name));
    const made = rects.map((rect, i) => ({ key: nextKey++, name: names[i], rect, pivot: [0.5, 0.5] as [number, number], original: savedNames.includes(names[i]) ? names[i] : null }));
    setSlices([...keep, ...made]);
    setSelected(made.length === 1 ? made[0].key : null);
    return made.length;
  };

  const close = async () => {
    if (dirty) {
      const answer = await confirmInEditor({ title: "Discard slice changes?", message: `${fileName(image)} has slice changes that haven't been applied.`, confirmLabel: "Discard" });
      if (!answer.ok) return;
    }
    spriteEditorImage.value = null;
  };

  const runSlice = async () => {
    if (!size) return;
    setBusy(true);
    try {
      let rects: Rect[];
      if (mode === "auto") rects = autoSlice(await getPixels(), { minSize: grid.minSize });
      else {
        rects = mode === "count" ? gridByCount(W, H, grid.columns, grid.rows) : gridByCellSize(W, H, grid.width, grid.height, [grid.offsetX, grid.offsetY], [grid.paddingX, grid.paddingY]);
        if (grid.skipEmpty) {
          const p = await getPixels();
          rects = rects.filter((r) => !isEmptyRect(p, r));
        }
      }
      const n = addRects(rects, true);
      status.value = { kind: "info", text: n === 0 ? `No slices found in ${fileName(image)}.` : `Sliced ${fileName(image)} into ${n} sprite${n === 1 ? "" : "s"}.` };
    } catch (err) {
      status.value = errorStatus(`Couldn't slice ${fileName(image)}`, err);
    } finally {
      setBusy(false);
    }
  };

  const apply = async () => {
    for (const s of slices) {
      const why = whyNotSliceName(s.name, slices.filter((o) => o !== s).map((o) => o.name));
      if (why) {
        setSelected(s.key);
        status.value = { kind: "info", text: `Can't apply: slice "${s.name}": ${why}.` };
        return;
      }
    }
    setBusy(true);
    try {
      const settings = { ...readImportSettings(project, image).settings, sprites: asSaved(slices) };
      await writeImportSettings(project, image, settings);
      const cleaned = await renameSliceReferences(project, image, sliceRenames(slices));
      const next = slices.map((s) => ({ ...s, original: s.name }));
      // Renames were applied to references, so earlier steps (with their old `original` names) can't be replayed.
      setHistory(createHistory(next));
      setBaseline(sliceKey(next));
      docVersion.value++;
      status.value = {
        kind: "info",
        text: `Saved ${slices.length} slice${slices.length === 1 ? "" : "s"} of ${fileName(image)}.${cleaned.length > 0 ? ` Updated references in ${cleaned.join(", ")}.` : ""}`,
      };
    } catch (err) {
      status.value = errorStatus(`Couldn't save the slices of ${fileName(image)}`, err);
    } finally {
      setBusy(false);
    }
  };

  const revert = () => {
    const saved = readImportSettings(project, image).settings.sprites.map(fromSaved);
    setSlices(saved); // an undoable step
    setBaseline(sliceKey(saved));
    setSelected(null);
  };

  /** A pointer position in image pixels (corners between pixels), inside the image. */
  const toPixel = (e: { clientX: number; clientY: number }): [number, number] => {
    const r = stage.current!.getBoundingClientRect();
    return [Math.max(0, Math.min(W, Math.round((e.clientX - r.left) / zoom))), Math.max(0, Math.min(H, Math.round((e.clientY - r.top) / zoom)))];
  };

  /** Press on the image: a handle resizes, a slice moves (and selects), empty space draws a new slice. */
  const onPointerDown = (e: PointerEvent) => {
    if (e.button !== 0 || !size) return;
    e.preventDefault();
    dialog.current?.focus();
    const target = e.target as HTMLElement;
    const handle = target.closest<HTMLElement>("[data-handle]")?.dataset.handle as Handle | undefined;
    const sliceEl = target.closest<HTMLElement>("[data-key]");
    const start = toPixel(e);
    const x0 = e.clientX, y0 = e.clientY;
    let onMove: (m: PointerEvent) => void;
    let onUp: () => void = () => {};
    if (sliceEl) {
      const key = Number(sliceEl.dataset.key);
      const s = slices.find((x) => x.key === key);
      if (!s) return;
      setSelected(key);
      const from = s.rect;
      const guide = target.closest<HTMLElement>("[data-guide]")?.dataset.guide;
      const gestureKey = newGesture();
      const border0 = s.border;
      onMove = (m) => {
        const dx = Math.round((m.clientX - x0) / zoom), dy = Math.round((m.clientY - y0) / zoom);
        if (guide) {
          // A border guide: left/top grow as the pointer moves right/down, bottom/right as it moves left/up.
          const index = BORDER_SIDES.indexOf(guide as (typeof BORDER_SIDES)[number]);
          const delta = index === 0 ? dx : index === 2 ? -dx : index === 3 ? dy : -dy;
          update(key, { border: dragBorderSide(border0, index, border0?.[index] ?? 0, delta, from) }, gestureKey);
          return;
        }
        const rect = handle ? resizeRect(from, handle, dx, dy, W, H) : moveRect(from, dx, dy, W, H);
        update(key, { rect, border: fitBorder(border0, rect) }, gestureKey);
      };
    } else {
      setSelected(null);
      let rect: Rect | null = null;
      onMove = (m) => {
        rect = rectBetween(start, toPixel(m), W, H);
        setDrawing(rect);
      };
      onUp = () => {
        setDrawing(null);
        if (rect) addRects([rect], false);
      };
    }
    const move = (m: PointerEvent) => onMove(m);
    const up = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      onUp();
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  };

  const onKeyDown = (e: KeyboardEvent) => {
    const inField = !!(e.target as HTMLElement).closest("input, select, textarea");
    if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      if (inField) (e.target as HTMLElement).blur();
      else void close();
      return;
    }
    const mod = e.ctrlKey || e.metaKey;
    const key = (e.key ?? "").toLowerCase();
    // Undo and redo go on to the editor's shortcuts: the active history is this editor's (above), and a
    // text field keeps its own.
    if (mod && (key === "z" || key === "y")) return;
    e.stopPropagation(); // keep the editor's other shortcuts (Delete, Ctrl+D…) away from the scene
    if (inField) return;
    if ((e.key === "Delete" || e.key === "Backspace") && current) {
      e.preventDefault();
      remove(current.key);
    }
  };

  const num = (label: string, value: number, onChange: (v: number) => void, min?: number) => (
    <label class="sprite-field">
      <span>{label}</span>
      <input
        type="number"
        aria-label={label}
        value={value}
        min={min}
        onChange={(e) => {
          const v = Number((e.currentTarget as HTMLInputElement).value);
          if (Number.isFinite(v)) onChange(v);
        }}
      />
    </label>
  );

  const commitName = () => {
    if (!nameDraft || !current || nameDraft.key !== current.key) return;
    if (nameDraft.problem) return;
    update(current.key, { name: nameDraft.text });
    setNameDraft(null);
  };

  return (
    <div class="dialog-backdrop sprite-editor-backdrop">
      <div ref={dialog} class="sprite-editor" role="dialog" aria-modal="true" aria-label={`Sprite Editor: ${fileName(image)}`} tabIndex={-1} onKeyDown={onKeyDown}>
        <header class="sprite-editor-head">
          <h2>Sprite Editor</h2>
          <span class="sprite-editor-file" title={image}>
            {fileName(image)}
            {size && ` · ${W} × ${H} px`}
          </span>
          <span class="sprite-editor-spacer" />
          <div class="sprite-zoom" role="group" aria-label="History">
            <button aria-label="Undo" title="Undo (Ctrl+Z)" disabled={!canUndo(history)} onClick={stepBack}>
              ↶
            </button>
            <button aria-label="Redo" title="Redo (Ctrl+Shift+Z)" disabled={!canRedo(history)} onClick={stepForward}>
              ↷
            </button>
          </div>
          <div class="sprite-zoom" role="group" aria-label="Zoom">
            <button aria-label="Zoom out" onClick={() => setZoom((z) => Math.max(0.05, z / 1.5))}>
              −
            </button>
            <span class="sprite-zoom-value">{Math.round(zoom * 100)}%</span>
            <button aria-label="Zoom in" onClick={() => setZoom((z) => Math.min(32, z * 1.5))}>
              +
            </button>
          </div>
        </header>
        <div class="sprite-editor-body">
          <div ref={viewport} class="sprite-editor-view">
            <div ref={stage} class="sprite-stage" style={{ width: `${W * zoom}px`, height: `${H * zoom}px` }} onPointerDown={onPointerDown}>
              <img
                src={url}
                alt=""
                draggable={false}
                onLoad={(e) => setSize([(e.currentTarget as HTMLImageElement).naturalWidth, (e.currentTarget as HTMLImageElement).naturalHeight])}
              />
              {slices.map((s) => (
                <div
                  key={s.key}
                  class={`sprite-slice${s.key === selected ? " selected" : ""}`}
                  data-key={s.key}
                  data-name={s.name}
                  aria-label={`Slice ${s.name}`}
                  style={{ left: `${s.rect[0] * zoom}px`, top: `${s.rect[1] * zoom}px`, width: `${s.rect[2] * zoom}px`, height: `${s.rect[3] * zoom}px` }}
                >
                  <span class="sprite-slice-name">{s.name}</span>
                  {s.key === selected && (
                    <>
                      <span class="sprite-pivot" style={{ left: `${s.pivot[0] * 100}%`, top: `${(1 - s.pivot[1]) * 100}%` }} />
                      {BORDER_SIDES.map((side, i) => {
                        const b = s.border?.[i] ?? 0;
                        const style = side === "L" ? { left: `${b * zoom}px` } : side === "R" ? { right: `${b * zoom}px` } : side === "T" ? { top: `${b * zoom}px` } : { bottom: `${b * zoom}px` };
                        return <span key={side} class={`sprite-guide guide-${side}${b > 0 ? " set" : ""}`} data-guide={side} aria-label={`Border ${side} guide`} style={style} />;
                      })}
                      {HANDLES.map((h) => (
                        <span key={h} class={`sprite-handle handle-${h}`} data-handle={h} aria-label={`Resize ${h}`} />
                      ))}
                    </>
                  )}
                </div>
              ))}
              {drawing && <div class="sprite-drawing" style={{ left: `${drawing[0] * zoom}px`, top: `${drawing[1] * zoom}px`, width: `${drawing[2] * zoom}px`, height: `${drawing[3] * zoom}px` }} />}
            </div>
          </div>
          <aside class="sprite-editor-side">
            <section aria-label="Slice">
              <h3>Slice</h3>
              <label class="sprite-field">
                <span>Type</span>
                <select aria-label="Slice type" value={mode} onChange={(e) => setMode((e.currentTarget as HTMLSelectElement).value as SliceMode)}>
                  <option value="count">Grid by cell count</option>
                  <option value="size">Grid by cell size</option>
                  <option value="auto">Automatic</option>
                </select>
              </label>
              {mode === "count" && (
                <div class="sprite-pair">
                  {num("Columns", grid.columns, (v) => setGrid({ ...grid, columns: v }), 1)}
                  {num("Rows", grid.rows, (v) => setGrid({ ...grid, rows: v }), 1)}
                </div>
              )}
              {mode === "size" && (
                <>
                  <div class="sprite-pair">
                    {num("Cell width", grid.width, (v) => setGrid({ ...grid, width: v }), 1)}
                    {num("Cell height", grid.height, (v) => setGrid({ ...grid, height: v }), 1)}
                  </div>
                  <div class="sprite-pair">
                    {num("Offset X", grid.offsetX, (v) => setGrid({ ...grid, offsetX: v }), 0)}
                    {num("Offset Y", grid.offsetY, (v) => setGrid({ ...grid, offsetY: v }), 0)}
                  </div>
                  <div class="sprite-pair">
                    {num("Padding X", grid.paddingX, (v) => setGrid({ ...grid, paddingX: v }), 0)}
                    {num("Padding Y", grid.paddingY, (v) => setGrid({ ...grid, paddingY: v }), 0)}
                  </div>
                </>
              )}
              {mode === "auto" ? (
                num("Minimum size", grid.minSize, (v) => setGrid({ ...grid, minSize: v }), 1)
              ) : (
                <label class="sprite-check">
                  <input type="checkbox" checked={grid.skipEmpty} onChange={(e) => setGrid({ ...grid, skipEmpty: (e.currentTarget as HTMLInputElement).checked })} />
                  Skip empty cells
                </label>
              )}
              <div class="sprite-buttons">
                <button disabled={!size || busy} title="Replace the slices" onClick={() => void runSlice()}>
                  Slice
                </button>
                <button disabled={slices.length === 0} onClick={() => (setSlices([]), setSelected(null))}>
                  Clear
                </button>
              </div>
            </section>
            {current ? (
              <section aria-label="Selected slice">
                <h3>Selected slice</h3>
                <label class="sprite-field">
                  <span>Name</span>
                  <input
                    type="text"
                    aria-label="Slice name"
                    value={nameDraft?.key === current.key ? nameDraft.text : current.name}
                    onInput={(e) => {
                      const text = (e.currentTarget as HTMLInputElement).value;
                      setNameDraft({ key: current.key, text, problem: whyNotSliceName(text, slices.filter((s) => s !== current).map((s) => s.name)) });
                    }}
                    onBlur={commitName}
                    onKeyDown={(e) => e.key === "Enter" && commitName()}
                  />
                </label>
                {nameDraft?.key === current.key && nameDraft.problem && <p class="sprite-problem">{nameDraft.problem}</p>}
                <div class="sprite-pair">
                  {num("X", current.rect[0], (v) => update(current.key, { rect: moveRect(current.rect, v - current.rect[0], 0, W, H) }), 0)}
                  {num("Y", current.rect[1], (v) => update(current.key, { rect: moveRect(current.rect, 0, v - current.rect[1], W, H) }), 0)}
                </div>
                <div class="sprite-pair">
                  {num("W", current.rect[2], (v) => update(current.key, { rect: resizeRect(current.rect, "e", v - current.rect[2], 0, W, H) }), 1)}
                  {num("H", current.rect[3], (v) => update(current.key, { rect: resizeRect(current.rect, "s", 0, v - current.rect[3], W, H) }), 1)}
                </div>
                <div class="sprite-pivot-row">
                  <PivotRow pivot={current.pivot} onChange={(pivot) => update(current.key, { pivot })} />
                </div>
                <div class="sprite-border" aria-label="Border">
                  <span class="sprite-border-label">Border (9-slice)</span>
                  {BORDER_SIDES.map((side, i) =>
                    num(`Border ${side}`, current.border?.[i] ?? 0, (v) => update(current.key, { border: setBorderSide(current.border, i, v, current.rect) }), 0),
                  )}
                </div>
                <label class="sprite-field">
                  <span>Fill</span>
                  <select aria-label="Slice fill" title="How the edges and centre fill the sprite: stretched, or repeated at the slice's pixel size" value={current.fill ?? "stretch"} onChange={(e) => update(current.key, { fill: (e.currentTarget as HTMLSelectElement).value === "tile" ? "tile" : undefined })}>
                    <option value="stretch">Stretch</option>
                    <option value="tile">Tile</option>
                  </select>
                </label>
                <div class="sprite-buttons">
                  <button class="danger" onClick={() => remove(current.key)}>
                    Delete Slice
                  </button>
                </div>
              </section>
            ) : (
              <p class="sprite-hint">Drag on the image to draw a slice. Click a slice to edit it; drag it to move it, or its handles to resize it.</p>
            )}
            <section aria-label="Slices" class="sprite-list-section">
              <h3>Slices ({slices.length})</h3>
              <ul class="sprite-list">
                {slices.map((s) => (
                  <li key={s.key}>
                    <button class={s.key === selected ? "active" : ""} onClick={() => setSelected(s.key)}>
                      {s.name}
                    </button>
                  </li>
                ))}
              </ul>
            </section>
          </aside>
        </div>
        <footer class="sprite-editor-foot">
          <span class="sprite-editor-state">{dirty ? "Unapplied changes" : "Saved"}</span>
          <button disabled={!dirty || busy} onClick={revert}>
            Revert
          </button>
          <button class="primary" disabled={!dirty || busy || !!readOnly} title={readOnly ?? `Write the slices into ${fileName(image)}.meta.json`} onClick={() => void apply()}>
            Apply
          </button>
          <button onClick={() => void close()}>Close</button>
        </footer>
      </div>
    </div>
  );
}

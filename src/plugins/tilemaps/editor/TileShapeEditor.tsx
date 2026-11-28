// The tile collision and shadow shape editor (ADR 0439): a canvas in the tileset inspector showing the tile's sprite
// (nearest filtering, zoomable), its cell box and, for a tileset with a preview grid, the cell's diamond or hexagon,
// with the tile's shapes over it: collision in the theme's accent (one-way shapes dashed with an arrow up), shadow
// shapes in its second accent. Tools: presets, Add rectangle (drag), Add polygon (click points; Enter or a click on
// the first point closes it), Delete shape, the shared point gestures (drag, press mid-edge to add, Ctrl/⌘+click to
// remove; the editor SDK's `polygonEdit`), snapped to the sprite's pixels unless Shift is held, Generate from sprite
// (`traceOutline`), Copy / Paste and Apply to selected tiles. Each finished gesture is one edit of the tileset's asset
// document, so one undo step. The model is `tileShapeEditorLogic.ts`.
import { signal } from "@preact/signals";
import { useEffect, useLayoutEffect, useRef, useState } from "preact/hooks";
import { traceOutline } from "../../../engine/render/sprites/outlineTrace";
import { editor, SegmentedControl, theme, writeClipboard, type EditorProject } from "../../../editor/sdk";
import { tileAnchor, type TileDef, type TilePolygon, type TilesetData } from "../runtime/tileset";
import { parsePolygon, polygonText } from "./polygonText";
import { tileSpriteSource } from "./TileThumb";
import {
  addDraftPoint,
  addShape,
  cellOutline,
  collisionPresetPatch,
  copyClip,
  editableShapes,
  finishDraft,
  hitShapes,
  movePoint,
  pastePatch,
  presetOf,
  pressShape,
  rectangle,
  removeShape,
  setOneWay,
  shadowPresetPatch,
  shapeAt,
  shapesPatch,
  snapPoint,
  spriteFrame,
  tracedShapes,
  viewExtent,
  type CollisionClip,
  type CollisionPreset,
  type ShadowPreset,
  type ShapeMode,
  type V2,
} from "./tileShapeEditorLogic";

type Tool = "edit" | "rectangle" | "polygon";

/** The last copied collision, in this editor's memory (it is also put on the system clipboard as text). */
const copied = signal<CollisionClip | null>(null);

const HIT = 7; // screen pixels
const ZOOMS = [1, 2, 3, 4, 6, 8, 12, 16, 24, 32];

/** An image once it has loaded (null until then). */
function useImage(url: string | null): HTMLImageElement | null {
  const [img, setImg] = useState<HTMLImageElement | null>(null);
  useEffect(() => {
    setImg(null);
    if (!url) return;
    let live = true;
    const el = new Image();
    el.onload = () => live && setImg(el);
    el.src = url;
    return () => void (live = false);
  }, [url]);
  return img;
}

export interface TileShapeEditorProps {
  project: EditorProject;
  data: TilesetData;
  tile: TileDef;
  readOnly: boolean;
  /** How many tiles are selected in the grid besides this one. */
  others: number;
  /** Write a patch to this tile: one undo step. */
  onPatch(patch: Partial<TileDef>, label: string): void;
  /** Write a patch to every other selected tile: one undo step. */
  onApplyToSelected(patch: Partial<TileDef>, label: string): void;
}

export function TileShapeEditor(props: TileShapeEditorProps) {
  const { project, data, tile, readOnly } = props;
  const [mode, setMode] = useState<ShapeMode>("collision");
  const [tool, setTool] = useState<Tool>("edit");
  const [selected, setSelected] = useState<number | null>(null);
  const [draft, setDraft] = useState<V2[]>([]);
  const [hover, setHover] = useState<V2 | null>(null);
  const [drag, setDrag] = useState<{ shapes: TilePolygon[]; shape: number; point: number; label: string; moved: boolean } | null>(null);
  const [rect, setRect] = useState<{ from: V2; to: V2 } | null>(null);
  const [zoomPick, setZoomPick] = useState<number | null>(null);
  const canvas = useRef<HTMLCanvasElement>(null);
  const colors = theme.value;

  const source = tileSpriteSource(project, tile);
  const img = useImage(source?.url ?? null);
  const spriteRect: [number, number, number, number] | null = source?.rect ?? (img ? [0, 0, img.naturalWidth, img.naturalHeight] : null);
  const frame = spriteFrame(data.tileSize, spriteRect ? [spriteRect[2], spriteRect[3]] : null, tileAnchor(data, tile));
  const [x0, y0, x1, y1] = viewExtent(frame);
  const fitZoom = ZOOMS.filter((z) => z * Math.max(x1 - x0, y1 - y0) <= 256).pop() ?? 1;
  const zoom = zoomPick ?? fitZoom;
  const cssW = Math.round((x1 - x0) * zoom), cssH = Math.round((y1 - y0) * zoom);
  /** Box units to screen pixels per unit, for hit reach. */
  const scale: V2 = [frame.cell[0] * zoom, frame.cell[1] * zoom];

  const stored = editableShapes(tile, mode, data.previewGrid);
  const shapes = drag?.shapes ?? stored;
  const preset = presetOf(tile, mode);
  useEffect(() => setSelected((s) => (s !== null && s < stored.length ? s : null)), [stored.length]);
  useEffect(() => {
    setDraft([]);
    setRect(null);
    setSelected(null);
  }, [mode, tile.id]);

  const toScreen = (p: V2): V2 => [(p[0] * frame.cell[0] - x0) * zoom, (y1 - p[1] * frame.cell[1]) * zoom];
  const fromEvent = (e: PointerEvent | MouseEvent): V2 => {
    const r = canvas.current!.getBoundingClientRect();
    const sx = ((e.clientX - r.left) / Math.max(1, r.width)) * cssW, sy = ((e.clientY - r.top) / Math.max(1, r.height)) * cssH;
    return [(sx / zoom + x0) / frame.cell[0], (y1 - sy / zoom) / frame.cell[1]];
  };
  const snapped = (e: PointerEvent | MouseEvent) => snapPoint(fromEvent(e), frame, e.shiftKey);

  const commit = (next: readonly TilePolygon[], label: string) => props.onPatch(shapesPatch(mode, next), label);
  const what = mode === "collision" ? "collision" : "shadow";

  // Drawing.
  useLayoutEffect(() => {
    const c = canvas.current;
    const ctx = c?.getContext("2d");
    if (!c || !ctx) return;
    const dpr = globalThis.devicePixelRatio || 1;
    c.width = Math.max(1, Math.round(cssW * dpr));
    c.height = Math.max(1, Math.round(cssH * dpr));
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.imageSmoothingEnabled = false;
    ctx.fillStyle = colors.bgSunken;
    ctx.fillRect(0, 0, cssW, cssH);
    if (img && spriteRect) {
      const [sx, sy, sw, sh] = spriteRect;
      ctx.drawImage(img, sx, sy, sw, sh, (frame.origin[0] - x0) * zoom, (y1 - frame.origin[1] - sh) * zoom, sw * zoom, sh * zoom);
    }
    const path = (pts: readonly V2[], closed: boolean) => {
      ctx.beginPath();
      pts.forEach((p, i) => {
        const [x, y] = toScreen(p);
        if (i === 0) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
      });
      if (closed) ctx.closePath();
    };
    // The cell box, and the preview grid's cell outline inside it.
    ctx.lineWidth = 1;
    ctx.setLineDash([3, 3]);
    ctx.strokeStyle = colors.muted;
    path(cellOutline(undefined), true);
    ctx.stroke();
    if (data.previewGrid && data.previewGrid !== "square") {
      ctx.setLineDash([]);
      ctx.strokeStyle = colors.faint;
      path(cellOutline(data.previewGrid), true);
      ctx.stroke();
    }
    // In Shadow, the collision's shapes faintly for reference.
    if (mode === "shadow") {
      ctx.setLineDash([2, 2]);
      ctx.strokeStyle = colors.faint;
      for (const s of editableShapes(tile, "collision", data.previewGrid)) {
        path(s.polygon, true);
        ctx.stroke();
      }
    }
    const stroke = mode === "collision" ? colors.accent : colors.accent2;
    const fill = mode === "collision" ? colors.accentSoft : colors.accent2Soft;
    shapes.forEach((s, i) => {
      ctx.setLineDash(s.oneWay ? [5, 4] : []);
      ctx.lineWidth = i === selected ? 2 : 1.25;
      ctx.fillStyle = fill;
      ctx.strokeStyle = stroke;
      path(s.polygon, true);
      ctx.fill();
      ctx.stroke();
      if (s.oneWay) arrowUp(ctx, s.polygon.map(toScreen), stroke);
    });
    ctx.setLineDash([]);
    if (tool === "edit" && !readOnly) {
      shapes.forEach((s, i) => {
        s.polygon.forEach((p, k) => {
          const q = s.polygon[(k + 1) % s.polygon.length]!;
          const [mx, my] = toScreen([(p[0] + q[0]) / 2, (p[1] + q[1]) / 2]);
          ctx.beginPath();
          ctx.arc(mx, my, 2.5, 0, Math.PI * 2);
          ctx.fillStyle = colors.panel;
          ctx.fill();
          ctx.strokeStyle = stroke;
          ctx.lineWidth = 1;
          ctx.stroke();
        });
        for (const p of s.polygon) {
          const [x, y] = toScreen(p);
          const r = i === selected ? 4 : 3;
          ctx.fillStyle = i === selected ? stroke : colors.panel;
          ctx.strokeStyle = stroke;
          ctx.fillRect(x - r, y - r, r * 2, r * 2);
          ctx.strokeRect(x - r, y - r, r * 2, r * 2);
        }
      });
    }
    // The shape being drawn.
    ctx.strokeStyle = colors.text;
    ctx.lineWidth = 1;
    if (rect) {
      const r = rectangle(rect.from, rect.to);
      if (r) {
        path(r, true);
        ctx.stroke();
      }
    }
    if (draft.length) {
      path(hover ? [...draft, hover] : draft, false);
      ctx.stroke();
      const [fx, fy] = toScreen(draft[0]!);
      ctx.beginPath();
      ctx.arc(fx, fy, 5, 0, Math.PI * 2);
      ctx.stroke();
    }
  });

  // Pointer gestures.
  const down = (e: PointerEvent) => {
    if (readOnly || e.button !== 0) return;
    (e.currentTarget as HTMLElement).focus();
    if (tool === "rectangle") {
      const p = snapped(e);
      setRect({ from: p, to: p });
      capture(e);
      return;
    }
    if (tool === "polygon") {
      const r = addDraftPoint(draft, snapped(e), HIT, scale);
      if ("closed" in r) {
        commit(addShape(stored, r.closed), "Add polygon");
        setSelected(stored.length);
        setDraft([]);
        setTool("edit");
      } else setDraft(r.draft);
      return;
    }
    const hit = hitShapes(stored, fromEvent(e), HIT, selected, scale);
    if (!hit) return void setSelected(shapeAt(stored, fromEvent(e)));
    const action = pressShape(stored, hit.shape, hit.handle, e.ctrlKey || e.metaKey);
    if (!action) return;
    setSelected(hit.shape);
    if ("refused" in action) return void editor.messages.info(action.refused);
    if ("removed" in action) return void commit(action.removed, "Remove point");
    const inserted = hit.handle.startsWith("insert:");
    setDrag({ shapes: action.shapes, ...action.drag, label: inserted ? "Add point" : "Move point", moved: inserted });
    capture(e);
  };
  const move = (e: PointerEvent) => {
    if (drag) {
      const p = snapped(e);
      const at = drag.shapes[drag.shape]?.polygon[drag.point];
      if (!at || (at[0] === p[0] && at[1] === p[1])) return;
      setDrag({ ...drag, shapes: movePoint(drag.shapes, drag.shape, drag.point, p), moved: true });
    } else if (rect) setRect({ ...rect, to: snapped(e) });
    else if (tool === "polygon" && draft.length) setHover(snapped(e));
  };
  const up = () => {
    if (drag) {
      if (drag.moved) commit(drag.shapes, drag.label);
      setDrag(null);
    }
    if (rect) {
      const r = rectangle(rect.from, rect.to);
      setRect(null);
      if (r) {
        commit(addShape(stored, r), "Add rectangle");
        setSelected(stored.length);
        setTool("edit");
      }
    }
  };
  const deleteSelected = () => {
    if (selected === null || !stored[selected]) return;
    commit(removeShape(stored, selected), "Delete shape");
    setSelected(null);
  };
  const key = (e: KeyboardEvent) => {
    if (readOnly) return;
    if (e.key === "Enter" && draft.length) {
      e.preventDefault();
      const done = finishDraft(draft);
      if (done) {
        commit(addShape(stored, done), "Add polygon");
        setSelected(stored.length);
        setTool("edit");
      }
      setDraft([]);
    } else if (e.key === "Escape" && (draft.length || rect || tool !== "edit")) {
      e.preventDefault();
      setDraft([]);
      setRect(null);
      setTool("edit");
    } else if ((e.key === "Delete" || e.key === "Backspace") && selected !== null && tool === "edit") {
      e.preventDefault();
      deleteSelected();
    }
  };
  const wheel = (e: WheelEvent) => {
    if (!e.ctrlKey && !e.metaKey) return;
    e.preventDefault();
    stepZoom(e.deltaY < 0 ? 1 : -1);
  };
  const stepZoom = (by: number) => {
    const i = ZOOMS.indexOf(zoom);
    setZoomPick(ZOOMS[Math.max(0, Math.min(ZOOMS.length - 1, (i < 0 ? ZOOMS.indexOf(fitZoom) : i) + by))]!);
  };

  const generate = async () => {
    if (!img || !spriteRect) return;
    const c = document.createElement("canvas");
    c.width = img.naturalWidth;
    c.height = img.naturalHeight;
    const ctx = c.getContext("2d", { willReadFrequently: true })!;
    ctx.drawImage(img, 0, 0);
    const px = ctx.getImageData(0, 0, c.width, c.height);
    const alpha = new Uint8Array(px.width * px.height);
    for (let i = 0; i < alpha.length; i++) alpha[i] = px.data[i * 4 + 3]!;
    const traced = tracedShapes(traceOutline({ width: px.width, height: px.height, alpha }, spriteRect, { threshold: 16, tolerance: 1 }), frame);
    if (!traced.length) return void editor.messages.info("The sprite has no opaque pixels to trace.");
    commit(traced, "Generate from sprite");
    setSelected(null);
  };
  const copy = () => {
    const clip = copyClip(tile);
    copied.value = clip;
    writeClipboard(clip);
  };

  const presets: { value: CollisionPreset | ShadowPreset; label: string }[] =
    mode === "collision"
      ? [
          { value: "none", label: "None" },
          { value: "full", label: "Full cell" },
          { value: "oneWay", label: "One-way cell" },
        ]
      : [
          { value: "collision", label: "Same as collision" },
          { value: "none", label: "None" },
          { value: "full", label: "Full cell" },
        ];
  const choosePreset = (p: CollisionPreset | ShadowPreset) => props.onPatch(mode === "collision" ? collisionPresetPatch(p as CollisionPreset) : shadowPresetPatch(p as ShadowPreset), "Set " + what);

  return (
    <div class="tile-shapes" data-mode={mode}>
      <SegmentedControl<ShapeMode>
        label="Shape set"
        size="small"
        value={mode}
        options={[
          { value: "collision", label: "Collision", title: "What bodies collide with" },
          { value: "shadow", label: "Shadow", title: "What casts 2D shadows (ADR 0413)" },
        ]}
        onChange={setMode}
      />
      <div class="tile-shapes-row" role="group" aria-label={`${mode === "collision" ? "Collision" : "Shadow"} presets`}>
        {presets.map((p) => (
          <button key={p.value} class="toggle" aria-pressed={preset === p.value} disabled={readOnly} onClick={() => choosePreset(p.value)}>
            {p.label}
          </button>
        ))}
      </div>
      <div class="tile-shapes-row" role="group" aria-label="Shape tools">
        <button class="toggle" aria-pressed={tool === "edit"} disabled={readOnly} title="Select a shape; drag its points, press an edge's middle to add one, Ctrl/⌘+click a point to remove it" onClick={() => setTool("edit")}>
          Edit
        </button>
        <button class="toggle" aria-pressed={tool === "rectangle"} disabled={readOnly} title="Drag a rectangle" onClick={() => setTool("rectangle")}>
          Add rectangle
        </button>
        <button class="toggle" aria-pressed={tool === "polygon"} disabled={readOnly} title="Click points; Enter or a click on the first point closes it, Escape cancels" onClick={() => setTool("polygon")}>
          Add polygon
        </button>
        <button disabled={readOnly || selected === null} title="Delete the selected shape (Delete)" onClick={deleteSelected}>
          Delete shape
        </button>
      </div>
      <div class="tile-shapes-stage">
        <canvas
          ref={canvas}
          class={`tile-shapes-canvas tool-${tool}`}
          tabIndex={0}
          role="img"
          aria-label={`Tile ${what} shapes`}
          style={{ width: `${cssW}px`, height: `${cssH}px` }}
          onPointerDown={down}
          onPointerMove={move}
          onPointerUp={up}
          onPointerCancel={() => (setDrag(null), setRect(null))}
          onPointerLeave={() => setHover(null)}
          onKeyDown={key}
          onWheel={wheel}
        />
      </div>
      <div class="tile-shapes-row tile-shapes-zoom">
        <button aria-label="Zoom out" title="Zoom out (Ctrl+wheel)" onClick={() => stepZoom(-1)}>
          −
        </button>
        <span class="hint">{zoom}×</span>
        <button aria-label="Zoom in" title="Zoom in (Ctrl+wheel)" onClick={() => stepZoom(1)}>
          +
        </button>
        <span class="hint">Snaps to the sprite's pixels; hold Shift for free points.</span>
      </div>
      {stored.length > 0 && (
        <ul class="tile-shapes-list" aria-label={`${mode === "collision" ? "Collision" : "Shadow"} shapes`}>
          {stored.map((s, i) => (
            <li key={i} class={i === selected ? "selected" : ""} onClick={() => setSelected(i)}>
              <span>
                Shape {i + 1} <span class="hint">({s.polygon.length} points)</span>
              </span>
              {mode === "collision" && (
                <label onClick={(e) => e.stopPropagation()}>
                  <input type="checkbox" aria-label={`Shape ${i + 1} one way`} disabled={readOnly} checked={s.oneWay === true} onChange={(e) => commit(setOneWay(stored, i, (e.currentTarget as HTMLInputElement).checked), "Set one way")} />
                  One way
                </label>
              )}
            </li>
          ))}
        </ul>
      )}
      <div class="tile-shapes-row">
        <button disabled={readOnly || !img} title="Trace the sprite's opaque pixels: one shape per island" onClick={() => void generate()}>
          Generate from sprite
        </button>
        <button title="Copy this tile's collision and shadow shapes" onClick={copy}>
          Copy
        </button>
        <button disabled={readOnly || !copied.value} title={`Paste the copied tile's ${what} here`} onClick={() => copied.value && props.onPatch(pastePatch(copied.value, mode), `Paste ${what}`)}>
          Paste
        </button>
        {props.others > 0 && (
          <button disabled={readOnly} title={`Give the other selected tiles this tile's ${what}`} onClick={() => props.onApplyToSelected(pastePatch(copyClip(tile), mode), `Apply ${what} to tiles`)}>
            Apply to {props.others} selected
          </button>
        )}
      </div>
      <ShapePoints shapes={stored} selected={selected} readOnly={readOnly} onCommit={(next) => commit(next, "Edit points")} />
    </div>
  );
}

/** The selected shape's points as text, under a disclosure, for exact values (`polygonText.ts`). */
function ShapePoints(props: { shapes: TilePolygon[]; selected: number | null; readOnly: boolean; onCommit(shapes: TilePolygon[]): void }) {
  const i = props.selected ?? 0;
  const shape = props.shapes[i] ?? null;
  const shown = shape ? polygonText(shape.polygon) : "";
  const [text, setText] = useState(shown);
  const [error, setError] = useState(false);
  useEffect(() => {
    setText(shown);
    setError(false);
  }, [shown]);
  if (!shape) return null;
  return (
    <details class="tile-shapes-points">
      <summary>Points of shape {i + 1}</summary>
      <input
        type="text"
        aria-label="Polygon points"
        title="Points in cell units: 0,0 is the cell's bottom-left corner, 1,1 its top-right"
        class={error ? "invalid" : ""}
        disabled={props.readOnly}
        value={text}
        onInput={(e) => setText((e.currentTarget as HTMLInputElement).value)}
        onChange={(e) => {
          const pts = parsePolygon((e.currentTarget as HTMLInputElement).value);
          setError(!pts);
          if (pts) props.onCommit(props.shapes.map((s, k) => (k === i ? { ...s, polygon: pts } : s)));
        }}
      />
      {error && <p class="tileset-error">Needs three or more points like 0,0 1,0 1,1.</p>}
    </details>
  );
}

/** Keep the pointer's moves on the canvas during a drag (a pointer the browser doesn't know can't be captured: ignored). */
function capture(e: PointerEvent) {
  try {
    (e.currentTarget as Element).setPointerCapture?.(e.pointerId);
  } catch {
    // not an active pointer
  }
}

/** An arrow pointing up from a shape's centre: it collides only from above. */
function arrowUp(ctx: CanvasRenderingContext2D, screen: readonly V2[], color: string) {
  if (!screen.length) return;
  let cx = 0, top = Infinity, bottom = -Infinity;
  for (const [x, y] of screen) {
    cx += x;
    top = Math.min(top, y);
    bottom = Math.max(bottom, y);
  }
  cx /= screen.length;
  const len = Math.min(18, Math.max(6, (bottom - top) * 0.6)), cy = (top + bottom) / 2 + len / 2;
  ctx.setLineDash([]);
  ctx.strokeStyle = color;
  ctx.lineWidth = 1.5;
  ctx.beginPath();
  ctx.moveTo(cx, cy);
  ctx.lineTo(cx, cy - len);
  ctx.moveTo(cx - 4, cy - len + 4);
  ctx.lineTo(cx, cy - len);
  ctx.lineTo(cx + 4, cy - len + 4);
  ctx.stroke();
}

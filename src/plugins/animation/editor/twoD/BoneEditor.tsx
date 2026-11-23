// The 2D bone editor, the Sprite Editor's Bones tab (ADR 0371 "2D bones", 0373 "2D tools"; T56): on one slice, create bones by
// dragging, move them (a bone's start, its tip), parent them, generate the mesh from the slice's outline and move its
// vertices, make weights automatically (by distance or envelope, see `skinLogic.ts`) and paint them with a brush. The
// stage draws the slice at a whole zoom with the bones, the mesh and the selected bone's weights over it. Every edit is one
// refused-or-next result of `skinLogic.ts` applied as one step of the Sprite Editor's history (a drag is one step: its
// moves share a key); Apply there writes the skin into the sidecar, in the format the runtime reads (`skin.bones`, `mesh`,
// `weights`).
import { useRef, useState } from "preact/hooks";
import { applyEdit, NumberField, SegmentedControl, TextField, type EditResult, type SpriteEditorToolProps } from "../../../../editor/sdk";
import type { SliceSkin } from "../../../../engine/animation/sprites/sidecar";
import { BRUSH_MODES, boneRows, defaultZoom, gestureFor, meshEdges, sliceToStage, stageToSlice, weightOnBone, type BoneTool } from "./boneViewLogic";
import { useImageSize } from "./imageSize";
import {
  addBone,
  autoWeight,
  bonePoses,
  descendantsOf,
  EMPTY_SKIN,
  makeMesh,
  moveBone,
  moveVertex,
  newBoneName,
  paintWeights,
  removeBone,
  renameBone,
  reparentBone,
  setBoneTip,
  setMesh,
  skinProblem,
  type AutoWeightMode,
  type BrushMode,
  type SliceRect,
} from "./skinLogic";
import "./twoD.css";

const TOOLS = [
  { value: "create", label: "Create Bones", title: "Drag on the slice from a bone's start to its end" },
  { value: "move", label: "Move", title: "Drag a bone's start or tip" },
  { value: "mesh", label: "Mesh", title: "Drag mesh vertices" },
  { value: "paint", label: "Paint Weights", title: "Paint the selected bone's weights with a brush" },
] as const;

/** A drag in progress: how its pointer moves and ends. */
interface Gesture {
  move(x: number, y: number): void;
  end(x: number, y: number): void;
}

/** The Sprite Editor's Bones tab (see the file comment). */
export function BoneEditor(props: SpriteEditorToolProps) {
  const { slices, readOnly } = props;
  const slice = slices.find((s) => s.name === props.selected) ?? slices[0] ?? null;
  const image = useImageSize(props.url);
  const [tool, setTool] = useState<BoneTool>("create");
  const [bone, setBone] = useState<string | null>(null);
  const [attach, setAttach] = useState(true);
  const [brush, setBrush] = useState<{ mode: BrushMode; radius: number; strength: number }>({ mode: "add", radius: 12, strength: 0.4 });
  const [weightMode, setWeightMode] = useState<AutoWeightMode>("distance");
  const [spacing, setSpacing] = useState<number | undefined>(undefined);
  const [zoomPick, setZoomPick] = useState<{ slice: string; zoom: number } | null>(null);
  const [drawing, setDrawing] = useState<{ head: readonly [number, number]; tip: readonly [number, number] } | null>(null);
  const [pointer, setPointer] = useState<readonly [number, number] | null>(null);
  const [busy, setBusy] = useState(false);
  const stage = useRef<HTMLDivElement>(null);
  const gesture = useRef<Gesture | null>(null);
  const keys = useRef(0);
  const skinRef = useRef<SliceSkin>(EMPTY_SKIN);
  const skin = slice?.skin ?? EMPTY_SKIN;
  skinRef.current = skin;
  const disabled = readOnly !== null;

  if (!slice) return <p class="bone-note">This image has no slices. Slice it first, then add bones to a slice.</p>;
  const rect = slice.rect as SliceRect;
  const zoom = zoomPick?.slice === slice.name ? zoomPick.zoom : defaultZoom(rect);
  const poses = bonePoses(skin);
  const selectedBone = bone !== null && skin.bones.some((b) => b.name === bone) ? bone : null;
  const boneIndex = selectedBone === null ? -1 : skin.bones.findIndex((b) => b.name === selectedBone);
  const problem = skinProblem(skin);
  const showMesh = (tool === "mesh" || tool === "paint") && skin.mesh !== null;

  /** Apply an edit of this slice's skin as one step; `key` joins the steps of a drag, `quiet` leaves a refusal unreported. */
  const commit = (result: EditResult<SliceSkin>, label: string, key?: string, quiet = false): boolean => {
    if (quiet && "refused" in result) return false;
    return applyEdit(result, label, (next) => {
      skinRef.current = next;
      props.edit({ skins: { [slice.name]: next } }, key);
    });
  };
  const gestureKey = () => `bones:${++keys.current}`;

  const point = (e: { clientX: number; clientY: number }): [number, number] => {
    const r = stage.current!.getBoundingClientRect();
    return stageToSlice(rect, zoom, e.clientX - r.left, e.clientY - r.top);
  };

  const onPointerDown = (e: PointerEvent) => {
    if (e.button !== 0 || readOnly) return;
    e.preventDefault();
    const target = e.target as Element;
    const boneEl = target.closest<SVGElement>("[data-bone]");
    const end = target.closest<SVGElement>("[data-end]")?.dataset.end as "head" | "tip" | "body" | undefined;
    const vertexEl = target.closest<SVGElement>("[data-vertex]");
    const g = gestureFor(tool, { bone: boneEl?.dataset.bone ?? null, end: end ?? null, vertex: vertexEl ? Number(vertexEl.dataset.vertex) : null });
    const start = point(e);
    const key = gestureKey();
    if (g.kind === "create") {
      const parent = attach ? selectedBone : null;
      const name = newBoneName(skinRef.current);
      setDrawing({ head: start, tip: start });
      gesture.current = {
        move: (x, y) => setDrawing({ head: start, tip: [x, y] }),
        end: (x, y) => {
          setDrawing(null);
          if (Math.hypot(x - start[0], y - start[1]) < 1) return; // a click, not a drag
          if (commit(addBone(skinRef.current, { name, parent, head: start, tip: [x, y] }), "add a bone")) setBone(name);
        },
      };
    } else if (g.kind === "move-bone") {
      setBone(g.bone);
      const pose = bonePoses(skinRef.current).find((p) => p.name === g.bone)!;
      const grab: [number, number] = [start[0] - pose.head[0], start[1] - pose.head[1]];
      gesture.current = {
        move: (x, y) => void commit(g.end === "tip" ? setBoneTip(skinRef.current, g.bone, [x, y]) : moveBone(skinRef.current, g.bone, [x - grab[0], y - grab[1]]), `move bone ${g.bone}`, key, true),
        end: () => {},
      };
    } else if (g.kind === "move-vertex") {
      gesture.current = { move: (x, y) => void commit(moveVertex(skinRef.current, g.vertex, [x, y]), "move a vertex", key, true), end: () => {} };
    } else if (g.kind === "paint") {
      const stroke = (x: number, y: number, quiet: boolean) =>
        commit(paintWeights(skinRef.current, { center: [x, y], radius: brush.radius, strength: brush.strength, bone: selectedBone ?? "", mode: brush.mode }), "paint weights", key, quiet);
      // The first dab says why it can't paint (no mesh, no bone selected); the rest of the drag stays quiet.
      if (!stroke(start[0], start[1], false)) return;
      gesture.current = { move: (x, y) => void stroke(x, y, true), end: () => {} };
    } else return;
    try {
      stage.current?.setPointerCapture(e.pointerId);
    } catch {
      // A synthetic pointer has nothing to capture; the stage still gets its moves.
    }
  };
  const onPointerMove = (e: PointerEvent) => {
    const p = point(e);
    if (tool === "paint") setPointer(p);
    gesture.current?.move(p[0], p[1]);
  };
  const onPointerUp = (e: PointerEvent) => {
    const g = gesture.current;
    gesture.current = null;
    const p = point(e);
    g?.end(p[0], p[1]);
  };

  const generateMesh = async () => {
    setBusy(true);
    try {
      commit(setMesh(skin, makeMesh({ rect }, await props.pixels(), spacing)), "generate the mesh");
    } catch (err) {
      commit({ refused: `the image couldn't be read: ${(err as Error).message}` }, "generate the mesh");
    } finally {
      setBusy(false);
    }
  };

  const makeWeights = async () => {
    setBusy(true);
    try {
      let base = skin;
      if (!base.mesh) {
        const meshed = setMesh(base, makeMesh({ rect }, await props.pixels(), spacing));
        if ("refused" in meshed) return void commit(meshed, "generate the mesh");
        base = meshed.next;
      }
      commit(autoWeight(base, weightMode), "make automatic weights");
    } catch (err) {
      commit({ refused: `the image couldn't be read: ${(err as Error).message}` }, "make automatic weights");
    } finally {
      setBusy(false);
    }
  };

  const selected = selectedBone === null ? null : skin.bones[boneIndex]!;
  const parents = selected ? skin.bones.filter((b) => b.name !== selected.name && !descendantsOf(skin, selected.name).includes(b.name)).map((b) => b.name) : [];
  const stagePoint = (x: number, y: number) => sliceToStage(rect, zoom, x, y);
  const [W, H] = [rect[2] * zoom, rect[3] * zoom];

  return (
    <div class="bone-editor">
      <div class="bone-stage-wrap">
        <div class="bone-stage-bar">
          <label>
            Slice{" "}
            <select aria-label="Slice" value={slice.name} onChange={(e) => (props.select((e.currentTarget as HTMLSelectElement).value), setBone(null))}>
              {slices.map((s) => (
                <option key={s.name} value={s.name}>
                  {s.name}
                </option>
              ))}
            </select>
          </label>
          <button aria-label="Zoom out" onClick={() => setZoomPick({ slice: slice.name, zoom: Math.max(1, zoom - 1) })}>
            −
          </button>
          <span class="bone-zoom">{zoom}×</span>
          <button aria-label="Zoom in" onClick={() => setZoomPick({ slice: slice.name, zoom: Math.min(32, zoom + 1) })}>
            +
          </button>
        </div>
        <div class="bone-stage-view">
          <div
            ref={stage}
            class={`bone-stage tool-${tool}`}
            role="application"
            aria-label={`Bone stage: ${slice.name}`}
            style={{
              width: `${W}px`,
              height: `${H}px`,
              backgroundImage: image ? `url("${props.url}")` : undefined,
              backgroundSize: image ? `${image[0] * zoom}px ${image[1] * zoom}px` : undefined,
              backgroundPosition: `${-rect[0] * zoom}px ${-rect[1] * zoom}px`,
            }}
            onPointerDown={onPointerDown}
            onPointerMove={onPointerMove}
            onPointerUp={onPointerUp}
            onPointerLeave={() => setPointer(null)}
          >
            <svg class="bone-overlay" width={W} height={H} viewBox={`0 0 ${W} ${H}`}>
              {showMesh &&
                meshEdges(skin.mesh!.triangles).map(([a, b]) => {
                  const [x1, y1] = stagePoint(skin.mesh!.vertices[a * 2]!, skin.mesh!.vertices[a * 2 + 1]!);
                  const [x2, y2] = stagePoint(skin.mesh!.vertices[b * 2]!, skin.mesh!.vertices[b * 2 + 1]!);
                  return <line key={`${a}-${b}`} class="bone-edge" x1={x1} y1={y1} x2={x2} y2={y2} />;
                })}
              {showMesh &&
                Array.from({ length: skin.mesh!.vertices.length / 2 }, (_, v) => {
                  const [x, y] = stagePoint(skin.mesh!.vertices[v * 2]!, skin.mesh!.vertices[v * 2 + 1]!);
                  const w = boneIndex >= 0 ? weightOnBone(skin.weights ?? null, v, boneIndex) : 0;
                  return <circle key={v} class="bone-vertex" data-vertex={v} cx={x} cy={y} r={Math.max(3, zoom * 0.7)} style={{ fillOpacity: 0.15 + 0.85 * w }} />;
                })}
              {poses.map((p) => {
                const [x1, y1] = stagePoint(p.head[0], p.head[1]);
                const [x2, y2] = stagePoint(p.tip[0], p.tip[1]);
                return (
                  <g key={p.name} class={`bone${p.name === selectedBone ? " selected" : ""}`} data-bone={p.name} aria-label={`Bone ${p.name}`}>
                    <line class="bone-line" data-end="body" x1={x1} y1={y1} x2={x2} y2={y2} />
                    <circle class="bone-head" data-end="head" cx={x1} cy={y1} r={5} />
                    <circle class="bone-tip" data-end="tip" cx={x2} cy={y2} r={4} />
                  </g>
                );
              })}
              {drawing && (
                <line class="bone-draft" x1={stagePoint(drawing.head[0], drawing.head[1])[0]} y1={stagePoint(drawing.head[0], drawing.head[1])[1]} x2={stagePoint(drawing.tip[0], drawing.tip[1])[0]} y2={stagePoint(drawing.tip[0], drawing.tip[1])[1]} />
              )}
              {tool === "paint" && pointer && <circle class="bone-brush" cx={stagePoint(pointer[0], pointer[1])[0]} cy={stagePoint(pointer[0], pointer[1])[1]} r={brush.radius * zoom} />}
            </svg>
          </div>
        </div>
      </div>

      <aside class="bone-side">
        <section aria-label="Tool">
          <h4>Tool</h4>
          <SegmentedControl label="Bone tool" value={tool} options={TOOLS} onChange={setTool} size="small" />
          {tool === "create" && (
            <label class="flip-check">
              <input type="checkbox" aria-label="Child of the selected bone" checked={attach} onChange={(e) => setAttach((e.currentTarget as HTMLInputElement).checked)} />
              Child of the selected bone
            </label>
          )}
          {tool === "paint" && (
            <div class="flip-grid">
              <span>Brush</span>
              <SegmentedControl label="Brush mode" value={brush.mode} options={BRUSH_MODES} onChange={(mode) => setBrush({ ...brush, mode })} size="small" />
              <span>Radius</span>
              <NumberField id="bone-brush-radius" label="Brush radius" placeholder="12" suffix="px" value={brush.radius} onCommit={(v) => v !== undefined && setBrush({ ...brush, radius: v })} />
              <span>Strength</span>
              <NumberField id="bone-brush-strength" label="Brush strength" placeholder="0.4" value={brush.strength} onCommit={(v) => v !== undefined && setBrush({ ...brush, strength: v })} />
            </div>
          )}
        </section>

        <section aria-label="Bones">
          <h4>Bones ({skin.bones.length})</h4>
          {skin.bones.length === 0 ? (
            <p class="bone-note">No bones yet. With Create Bones, drag on the slice from where a bone starts to where it ends.</p>
          ) : (
            <ul class="bone-list" aria-label="Bone list">
              {boneRows(skin).map((row) => (
                <li key={row.name} style={{ paddingLeft: `${row.depth * 12}px` }}>
                  <button class={row.name === selectedBone ? "active" : ""} aria-pressed={row.name === selectedBone} onClick={() => setBone(row.name)}>
                    {row.name}
                  </button>
                </li>
              ))}
            </ul>
          )}
          {selected && (
            <div class="flip-grid">
              <span>Name</span>
              <TextField label="Bone name" value={selected.name} onCommit={(to) => {
                  if (commit(renameBone(skin, selected.name, to), `rename bone ${selected.name}`)) setBone(to);
                }}
              />
              <span>Parent</span>
              <select
                aria-label="Bone parent"
                value={selected.parent ?? ""}
                disabled={disabled}
                onChange={(e) => commit(reparentBone(skin, selected.name, (e.currentTarget as HTMLSelectElement).value || null), `parent bone ${selected.name}`)}
              >
                <option value="">(none: a root)</option>
                {parents.map((n) => (
                  <option key={n} value={n}>
                    {n}
                  </option>
                ))}
              </select>
              <span>Length</span>
              <span class="bone-readout">{selected.length.toFixed(1)} px</span>
              <span />
              <button
                class="danger"
                disabled={disabled}
                onClick={() => {
                  if (commit(removeBone(skin, selected.name), `remove bone ${selected.name}`)) setBone(null);
                }}
              >
                Remove Bone
              </button>
            </div>
          )}
        </section>

        <section aria-label="Mesh">
          <h4>Mesh</h4>
          <p class="bone-note">{skin.mesh ? `${skin.mesh.vertices.length / 2} vertices, ${skin.mesh.triangles.length / 3} triangles.` : "No mesh: the runtime draws the slice as a grid."}</p>
          <div class="flip-grid">
            <span>Spacing</span>
            <NumberField id="bone-mesh-spacing" label="Mesh spacing" placeholder="automatic" suffix="px" value={spacing} onCommit={setSpacing} />
          </div>
          <button disabled={disabled || busy} title={readOnly ?? "Mesh the slice's opaque outline; the weights are made anew"} onClick={() => void generateMesh()}>
            {skin.mesh ? "Regenerate Mesh" : "Generate Mesh"}
          </button>
        </section>

        <section aria-label="Weights">
          <h4>Weights</h4>
          <div class="flip-grid">
            <span>Method</span>
            <select aria-label="Auto weight method" value={weightMode} onChange={(e) => setWeightMode((e.currentTarget as HTMLSelectElement).value as AutoWeightMode)}>
              <option value="distance">By distance</option>
              <option value="envelope">By envelope</option>
            </select>
          </div>
          <button disabled={disabled || busy} title={readOnly ?? (weightMode === "distance" ? "Each vertex blends the bones by inverse square distance" : "Each bone reaches 0.6 × its length; vertices blend the bones that reach them")} onClick={() => void makeWeights()}>
            Auto Weights
          </button>
          <p class="bone-note">{skin.weights ? "Weights are stored; paint to change them." : "No stored weights: the runtime computes them by distance."}</p>
        </section>

        {problem && <p class="bone-problem" role="alert">{problem}</p>}
      </aside>
    </div>
  );
}

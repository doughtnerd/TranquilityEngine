// The Lights 2D plugin's Sprite Editor tools and Import Settings card (ADR 0414):
// - Secondary Textures: an image's normal map and mask map (images the same size, laid out like it), any number of
//   custom named textures for Sprite Custom Lit shader graphs (ADR 0415), the normal map's green channel, and a preview
//   of the image, either map, or the image lit by a draggable test light;
// - Outline: each slice's outline for 2D shadow casters (ADR 0413): Generate traces the slice's opaque pixels
//   (`traceOutline`), then points drag, a press mid-edge adds one and Ctrl+click removes one;
// - the Import Settings card: the two map pickers, so a normal map can be set without opening the Sprite Editor.
// Tool edits are steps of the Sprite Editor's one history and are written by its Apply; the card edits the draft.
import { useEffect, useMemo, useRef, useState } from "preact/hooks";
import type { SpriteSlice } from "../../../engine/scene/importSettings";
import { traceOutline } from "../../../engine/render/sprites/outlineTrace";
import { AssetPicker, editor, pressPoints, type ImportSettingsViewProps, type SpriteEditorToolProps, type V2 } from "../../../editor/sdk";
import { litPreview, type PreviewPixels } from "./litPreview";
import { customRows, newTextureName, removeTexture, renameProblem, renameTexture } from "./secondaryTexturesModel";
import "./spriteTools.css";

const MAPS = [
  { name: "normalMap", label: "Normal Map" },
  { name: "maskMap", label: "Mask Map" },
] as const;

const bare = (ref: string) => ref.replace(/^asset:/, "");

/** An image's pixels from its URL (null when it can't be read). */
async function imagePixels(url: string): Promise<PreviewPixels | null> {
  try {
    const img = new Image();
    img.src = url;
    await img.decode();
    const canvas = document.createElement("canvas");
    canvas.width = img.naturalWidth;
    canvas.height = img.naturalHeight;
    const ctx = canvas.getContext("2d", { willReadFrequently: true })!;
    ctx.drawImage(img, 0, 0);
    return ctx.getImageData(0, 0, canvas.width, canvas.height);
  } catch {
    return null;
  }
}

const urlOf = (ref: string): string | null => {
  const path = bare(ref);
  const url = path ? editor.project.peek()?.assets.get(path) : null;
  return typeof url === "string" ? url : null;
};

/** A map's size, checked against the image's: "" when it fits, else why not. */
function useSizeProblem(imageUrl: string, mapRef: string): string {
  const [problem, setProblem] = useState("");
  useEffect(() => {
    let live = true;
    const url = urlOf(mapRef);
    if (!url) return void setProblem("");
    Promise.all([imagePixels(imageUrl), imagePixels(url)]).then(([a, b]) => {
      if (!live) return;
      if (!a || !b) setProblem("It can't be read.");
      else setProblem(a.width === b.width && a.height === b.height ? "" : `It's ${b.width}×${b.height}; the image is ${a.width}×${a.height}. It isn't used until the sizes match.`);
    });
    return () => void (live = false);
  }, [imageUrl, mapRef]);
  return problem;
}

function MapRow(props: { image: string; imageUrl: string; name: string; label: string; value: string; readOnly: string | null; onCommit(v: string): void }) {
  const problem = useSizeProblem(props.imageUrl, props.value);
  return (
    <div class="lights2d-map-row">
      <label>{props.label}</label>
      <AssetPicker value={props.value} kinds={["texture"]} label={props.label} accepts={(p) => p !== props.image} disabled={!!props.readOnly} onCommit={props.onCommit} />
      {problem && <p class="lights2d-tool-warning" role="status">{problem}</p>}
    </div>
  );
}

/** A custom secondary texture's row (ADR 0415): its name (renamed on commit), its texture, and Remove. */
function CustomRow(props: { image: string; imageUrl: string; name: string; value: string; readOnly: string | null; problem(to: string): string; onRename(to: string): void; onCommit(v: string): void; onRemove(): void }) {
  const [draft, setDraft] = useState(props.name);
  useEffect(() => setDraft(props.name), [props.name]);
  const nameProblem = props.problem(draft);
  const sizeProblem = useSizeProblem(props.imageUrl, props.value);
  return (
    <div class="lights2d-map-row lights2d-custom-row">
      <div class="lights2d-custom-name">
        <input
          type="text"
          aria-label={`Name of ${props.name}`}
          value={draft}
          disabled={!!props.readOnly}
          onInput={(e) => setDraft((e.currentTarget as HTMLInputElement).value)}
          onBlur={() => (nameProblem ? setDraft(props.name) : props.onRename(draft))}
          onKeyDown={(e) => e.key === "Enter" && (e.currentTarget as HTMLInputElement).blur()}
        />
        <button aria-label={`Remove ${props.name}`} title="Remove this texture" disabled={!!props.readOnly} onClick={props.onRemove}>
          ✕
        </button>
      </div>
      {nameProblem && <p class="lights2d-tool-warning" role="status">{nameProblem}</p>}
      <AssetPicker value={props.value} kinds={["texture"]} label={props.name} accepts={(p) => p !== props.image} disabled={!!props.readOnly} onCommit={props.onCommit} />
      {sizeProblem && <p class="lights2d-tool-warning" role="status">{sizeProblem}</p>}
    </div>
  );
}

/** The Sprite Editor's Secondary Textures tab. */
export function SecondaryTexturesTool(props: SpriteEditorToolProps) {
  const [view, setView] = useState<"main" | "normalMap" | "maskMap" | "lit">("main");
  const [light, setLight] = useState({ x: 0.3, y: 0.3, height: 32 });
  const canvas = useRef<HTMLCanvasElement>(null);
  const textures = props.secondaryTextures;
  // Custom rows not given a texture yet: the sidecar keeps only textures, so their names live here until then.
  const [pending, setPending] = useState<string[]>([]);
  const set = (name: string, value: string) => {
    props.edit({ secondaryTextures: { ...textures, [name]: value } });
    if (value) setPending((p) => p.filter((n) => n !== name));
  };
  const rename = (from: string, to: string) => {
    if (renameProblem(textures, pending, from, to)) return;
    if (from in textures) props.edit({ secondaryTextures: renameTexture(textures, pending, from, to) });
    setPending((p) => p.map((n) => (n === from ? to : n)));
  };
  const remove = (name: string) => {
    if (name in textures) props.edit({ secondaryTextures: removeTexture(textures, name) });
    setPending((p) => p.filter((n) => n !== name));
  };
  useEffect(() => {
    if (view !== "lit" || !canvas.current) return;
    let live = true;
    const normalUrl = urlOf(textures.normalMap ?? "");
    Promise.all([props.pixels(), normalUrl ? imagePixels(normalUrl) : Promise.resolve(null)]).then(([albedo, normal]) => {
      const c = canvas.current;
      if (!live || !c) return;
      c.width = albedo.width;
      c.height = albedo.height;
      const data = litPreview(albedo, normal, { x: light.x * albedo.width, y: light.y * albedo.height, height: light.height }, props.normalMapGreen === "down");
      c.getContext("2d")!.putImageData(new ImageData(data, albedo.width, albedo.height), 0, 0);
    });
    return () => void (live = false);
  }, [view, light, textures.normalMap, props.normalMapGreen]);
  const shown = view === "main" ? props.url : view === "lit" ? null : urlOf(textures[view] ?? "");
  const moveLight = (e: PointerEvent) => {
    const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
    setLight((l) => ({ ...l, x: (e.clientX - r.left) / Math.max(1, r.width), y: (e.clientY - r.top) / Math.max(1, r.height) }));
  };
  return (
    <div class="lights2d-tool" aria-label="Secondary textures">
      <div class="lights2d-tool-side">
        <p class="lights2d-tool-hint">Textures laid out like this image, read by lit sprites (ADR 0414): every slice samples them at its own UVs.</p>
        {MAPS.map((m) => (
          <MapRow key={m.name} image={props.image} imageUrl={props.url} name={m.name} label={m.label} value={textures[m.name] ?? ""} readOnly={props.readOnly} onCommit={(v) => set(m.name, v)} />
        ))}
        <p class="lights2d-tool-hint">Custom textures: read by name by a Sprite Custom Lit shader graph's Secondary Texture node.</p>
        {customRows(textures, pending).map((name) => (
          <CustomRow
            key={name}
            image={props.image}
            imageUrl={props.url}
            name={name}
            value={textures[name] ?? ""}
            readOnly={props.readOnly}
            problem={(to) => renameProblem(textures, pending, name, to)}
            onRename={(to) => rename(name, to)}
            onCommit={(v) => set(name, v)}
            onRemove={() => remove(name)}
          />
        ))}
        <div class="lights2d-buttons">
          <button disabled={!!props.readOnly} onClick={() => setPending((p) => [...p, newTextureName(textures, p)])}>
            Add Texture
          </button>
        </div>
        <div class="lights2d-map-row">
          <label>Normal map green</label>
          <select aria-label="Normal map green" value={props.normalMapGreen} disabled={!!props.readOnly} onChange={(e) => props.edit({ normalMapGreen: (e.currentTarget as HTMLSelectElement).value as "up" | "down" })}>
            <option value="up">Up (OpenGL, Unity)</option>
            <option value="down">Down (DirectX)</option>
          </select>
        </div>
        <div class="lights2d-map-row">
          <label>Preview</label>
          <select aria-label="Preview" value={view} onChange={(e) => setView((e.currentTarget as HTMLSelectElement).value as typeof view)}>
            <option value="main">Image</option>
            <option value="normalMap">Normal map</option>
            <option value="maskMap">Mask map</option>
            <option value="lit">Lit</option>
          </select>
        </div>
        {view === "lit" && (
          <div class="lights2d-map-row">
            <label>Light height</label>
            <input type="range" aria-label="Light height" min={2} max={256} value={light.height} onInput={(e) => setLight((l) => ({ ...l, height: Number((e.currentTarget as HTMLInputElement).value) }))} />
          </div>
        )}
      </div>
      <div class="lights2d-tool-stage">
        {view === "lit" ? (
          <canvas ref={canvas} class="lights2d-preview" aria-label="Lit preview (drag to move the light)" onPointerDown={moveLight} onPointerMove={(e) => e.buttons & 1 && moveLight(e)} />
        ) : shown ? (
          <img class="lights2d-preview" src={shown} alt={view} />
        ) : (
          <p class="lights2d-tool-hint">No {view === "normalMap" ? "normal" : "mask"} map set.</p>
        )}
      </div>
    </div>
  );
}

type Outline = V2[][];

/** The Sprite Editor's Outline tab. */
export function OutlineTool(props: SpriteEditorToolProps) {
  const [threshold, setThreshold] = useState(16);
  const [tolerance, setTolerance] = useState(1.5);
  const [drag, setDrag] = useState<{ poly: number; point: number; points: Outline; key: string } | null>(null);
  const svg = useRef<SVGSVGElement>(null);
  const slice = props.slices.find((s) => s.name === props.selected) ?? props.slices[0] ?? null;
  const outline: Outline = useMemo(() => (slice?.outline ?? []).map((poly) => poly.map((p): V2 => [p[0], p[1]])), [slice]);
  const [w, h] = slice ? [slice.rect[2], slice.rect[3]] : [1, 1];
  const scale = Math.max(1, Math.floor(320 / Math.max(w, h)));

  const generate = async (targets: readonly SpriteSlice[]) => {
    const px = await props.pixels();
    const alpha = new Uint8Array(px.width * px.height);
    for (let i = 0; i < alpha.length; i++) alpha[i] = px.data[i * 4 + 3]!;
    const outlines: Record<string, V2[][] | null> = {};
    for (const s of targets) {
      const traced = traceOutline({ width: px.width, height: px.height, alpha }, s.rect, { threshold, tolerance });
      outlines[s.name] = traced.length ? traced : null;
    }
    props.edit({ outlines });
  };
  const write = (points: Outline, key?: string) => slice && props.edit({ outlines: { [slice.name]: points.length ? points : null } }, key);

  const local = (e: PointerEvent): V2 | null => {
    const r = svg.current?.getBoundingClientRect();
    if (!r) return null;
    return [Math.round(((e.clientX - r.left) / r.width) * w * 10) / 10, Math.round((h - ((e.clientY - r.top) / r.height) * h) * 10) / 10];
  };
  const press = (poly: number, handle: string) => (e: PointerEvent) => {
    if (props.readOnly) return;
    e.stopPropagation();
    const action = pressPoints(outline[poly] ?? [], handle, e.ctrlKey || e.metaKey);
    if (!action) return;
    if ("refused" in action) return void editor.messages.info(action.refused);
    if ("removed" in action) return void write(outline.map((p, i) => (i === poly ? action.removed : p)));
    const points = outline.map((p, i) => (i === poly ? action.points : p));
    const key = `outline-drag:${Date.now()}`;
    if (handle.startsWith("insert:")) write(points, key);
    (e.currentTarget as Element).setPointerCapture?.(e.pointerId);
    setDrag({ poly, point: action.drag, points, key });
  };
  const move = (e: PointerEvent) => {
    if (!drag) return;
    const p = local(e);
    if (!p) return;
    const points = drag.points.map((poly, i) => (i === drag.poly ? poly.map((q, k): V2 => (k === drag.point ? p : q)) : poly));
    setDrag({ ...drag, points });
    write(points, drag.key);
  };
  const toSvg = (p: V2) => `${p[0]},${h - p[1]}`;

  return (
    <div class="lights2d-tool" aria-label="Slice outlines">
      <div class="lights2d-tool-side">
        <p class="lights2d-tool-hint">Each slice's outline: what a ShadowCaster2D with shape Sprite (or Auto) casts from (ADR 0413). Without one, the slice's rectangle casts.</p>
        <ul class="lights2d-slices" role="listbox" aria-label="Slices">
          {props.slices.map((s) => (
            <li key={s.name} role="option" aria-selected={s.name === slice?.name} class={s.name === slice?.name ? "selected" : ""} onClick={() => props.select(s.name)}>
              {s.name} {s.outline?.length ? "●" : ""}
            </li>
          ))}
        </ul>
        <div class="lights2d-map-row">
          <label>Alpha threshold</label>
          <input type="range" aria-label="Alpha threshold" min={0} max={254} value={threshold} onInput={(e) => setThreshold(Number((e.currentTarget as HTMLInputElement).value))} />
        </div>
        <div class="lights2d-map-row">
          <label>Tolerance</label>
          <input type="range" aria-label="Tolerance" min={0} max={8} step={0.5} value={tolerance} onInput={(e) => setTolerance(Number((e.currentTarget as HTMLInputElement).value))} />
        </div>
        <div class="lights2d-buttons">
          <button disabled={!slice || !!props.readOnly} onClick={() => slice && void generate([slice])}>
            Generate
          </button>
          <button disabled={!props.slices.length || !!props.readOnly} onClick={() => void generate(props.slices)}>
            Generate All
          </button>
          <button disabled={!outline.length || !!props.readOnly} onClick={() => write([])}>
            Clear
          </button>
        </div>
        <p class="lights2d-tool-hint">Drag a point; press an edge's middle to add one; Ctrl+click a point to remove it.</p>
      </div>
      <div class="lights2d-tool-stage">
        {slice ? (
          <div class="lights2d-slice" style={{ width: `${w * scale}px`, height: `${h * scale}px` }}>
            <div
              class="lights2d-slice-image"
              style={{ backgroundImage: `url("${props.url}")`, backgroundPosition: `-${slice.rect[0] * scale}px -${slice.rect[1] * scale}px`, backgroundSize: `auto`, width: `${w}px`, height: `${h}px`, transform: `scale(${scale})` }}
            />
            <svg ref={svg} viewBox={`0 0 ${w} ${h}`} class="lights2d-outline" onPointerMove={move} onPointerUp={() => setDrag(null)} aria-label="Outline">
              {(drag?.points ?? outline).map((poly, pi) => (
                <g key={pi}>
                  <polygon points={poly.map(toSvg).join(" ")} />
                  {poly.map((p, i) => {
                    const q = poly[(i + 1) % poly.length]!;
                    return <circle key={`m${i}`} class="insert" cx={(p[0] + q[0]) / 2} cy={h - (p[1] + q[1]) / 2} r={Math.max(0.4, 3 / scale)} onPointerDown={press(pi, `insert:${i}`)} />;
                  })}
                  {poly.map((p, i) => (
                    <circle key={`p${i}`} class="point" cx={p[0]} cy={h - p[1]} r={Math.max(0.6, 4 / scale)} onPointerDown={press(pi, `p:${i}`)} />
                  ))}
                </g>
              ))}
            </svg>
          </div>
        ) : (
          <p class="lights2d-tool-hint">This image has no slices: draw some in the Slices tab first.</p>
        )}
      </div>
    </div>
  );
}

/** The Secondary Textures card of an image's Import Settings. */
export function SecondaryTexturesCard(props: ImportSettingsViewProps) {
  const url = props.project.assets.get(props.path);
  const imageUrl = typeof url === "string" ? url : "";
  const textures = props.draft.secondaryTextures ?? {};
  return (
    <div class="lights2d-card">
      {MAPS.map((m) => (
        <MapRow key={m.name} image={props.path} imageUrl={imageUrl} name={m.name} label={m.label} value={textures[m.name] ?? ""} readOnly={props.readOnly} onCommit={(v) => props.set({ secondaryTextures: Object.fromEntries(Object.entries({ ...textures, [m.name]: v }).filter(([, x]) => x)) })} />
      ))}
      <div class="lights2d-map-row">
        <label>Normal map green</label>
        <select aria-label="Normal map green" value={props.draft.normalMapGreen ?? "up"} disabled={!!props.readOnly} onChange={(e) => props.set({ normalMapGreen: (e.currentTarget as HTMLSelectElement).value as "up" | "down" })}>
          <option value="up">Up (OpenGL, Unity)</option>
          <option value="down">Down (DirectX)</option>
        </select>
      </div>
    </div>
  );
}

// Tileset assets in the Inspector (ADR 0103): a `*.tileset.json` selected in the Assets panel shows its tile size,
// terrains and a grid of its tiles; the selected tile's name, collision (a polygon is typed as points in cell units),
// terrain, neighbour pattern (a 3 × 3 grid of buttons), weight and custom data (JSON) are edited below. Every edit
// writes the file through the tileset's asset document and can be undone (Ctrl+Z / Ctrl+Shift+Z over the inspector,
// or the Undo / Redo buttons).
import { useEffect, useState } from "preact/hooks";
import { missingBlobMasks } from "../runtime/autotile";
import { ANY_PATTERN, type TileCollision, type TileDef, type TilesetData } from "../runtime/tileset";
import { assetKind, fileName } from "../../../editor/assetBrowser";
import { openAssetDocument } from "../../../editor/assetDocuments";
import { readImportSettings } from "../../../editor/assetImport";
import { currentProject, docVersion, status } from "../../../editor/state";
import { tilesForSlices } from "../../../editor/tilesetAssets";
import { TileThumb } from "../../../editor/ui/TileThumb";
import "../../../editor/ui/assetInspector.css";
import "./tilesetInspector.css";

type CollisionKind = "none" | "full" | "oneWay" | "polygon";

const collisionKind = (c: TileCollision): CollisionKind => (typeof c === "string" ? c : "polygon");

/** `x,y x,y …` in cell units, or null if it isn't three or more points. */
export function parsePolygon(text: string): [number, number][] | null {
  const pts: [number, number][] = [];
  for (const part of text.trim().split(/\s+/)) {
    if (!part) continue;
    const m = /^(-?\d*\.?\d+),(-?\d*\.?\d+)$/.exec(part);
    if (!m) return null;
    pts.push([Number(m[1]), Number(m[2])]);
  }
  return pts.length >= 3 ? pts : null;
}

const polygonText = (pts: readonly (readonly number[])[]) => pts.map((p) => `${p[0]},${p[1]}`).join(" ");

/** Grid position (row by row from the top-left) to its index in the pattern string N NE E SE S SW W NW; -1 is the centre. */
const PATTERN_AT = [7, 0, 1, 6, -1, 2, 5, 4, 3];
const NEXT: Record<string, string> = { "*": "1", "1": "0", "0": "*" };
const GLYPH: Record<string, string> = { "*": "·", "1": "■", "0": "□" };
const GLYPH_TITLE: Record<string, string> = { "*": "either", "1": "same terrain", "0": "other" };

/** The selected tileset asset (see the file comment). */
export function TilesetInspector(props: { path: string }) {
  docVersion.value; // rewritten by this inspector, or on disk
  const { path } = props;
  const project = currentProject.value;
  const [selected, setSelected] = useState<number | null>(null);
  useEffect(() => setSelected(null), [path]);
  if (!project) return <p class="empty">Nothing selected</p>;
  const doc = openAssetDocument<TilesetData>(project, path, "tileset");
  const data = doc.value.value;
  const problems = doc.problems.value.map((p) => p.message);
  const readOnly = doc.readOnly;
  useEffect(() => () => void doc.flush(), [doc]); // write a pending slider change when the inspector closes
  const tile = data.tiles.find((t) => t.id === selected) ?? null;

  // Every edit is one undo step through the tileset's asset document.
  const set = (patch: Partial<TilesetData>) => {
    if (!readOnly) doc.edit({ ...doc.value.peek(), ...patch });
  };
  const setTile = (id: number, patch: Partial<TileDef>) => {
    const tiles = doc.value.peek().tiles.map((t) => {
      if (t.id !== id) return t;
      const next = { ...t, ...patch };
      for (const k of Object.keys(patch) as (keyof TileDef)[]) if (next[k] === undefined) delete next[k];
      return next;
    });
    set({ tiles });
  };
  const undo = () => (doc.canUndo.peek() ? doc.undo() : (status.value = { kind: "info", text: "Nothing to undo in this tileset." }));
  const redo = () => (doc.canRedo.peek() ? doc.redo() : (status.value = { kind: "info", text: "Nothing to redo in this tileset." }));
  const onKeyDown = (e: KeyboardEvent) => {
    const t = e.target as HTMLElement;
    if (!(e.ctrlKey || e.metaKey) || t.closest("input, select, textarea")) return;
    const key = e.key.toLowerCase();
    if (key !== "z" && key !== "y") return;
    e.preventDefault();
    e.stopPropagation(); // the tileset's history, not the scene's
    if (key === "y" || e.shiftKey) redo();
    else undo();
  };

  const usedSprites = new Set(data.tiles.map((t) => t.sprite));
  const images = project.files.filter((f) => assetKind(f) === "image" && readImportSettings(project, f).settings.sprites.length > 0);
  const addFrom = (image: string) => {
    const nextId = data.tiles.reduce((m, t) => Math.max(m, t.id), 0) + 1;
    const added = tilesForSlices(readImportSettings(project, image).settings, image, nextId, usedSprites);
    if (added.length === 0) {
      status.value = { kind: "info", text: `Every slice of ${fileName(image)} already has a tile.` };
      return;
    }
    set({ tiles: [...data.tiles, ...added] });
  };

  return (
    <div class="inspector-body asset-inspector tileset-inspector" aria-label="Tileset" tabIndex={-1} onKeyDown={onKeyDown}>
      <div class="asset-inspector-head">
        <span class="asset-inspector-kind">Tileset</span>
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
        <h3>Tileset</h3>
        <div class="import-row">
          <span>Tile Size</span>
          <span class="import-pivot tileset-size">
            {([0, 1] as const).map((i) => (
              <input
                key={i}
                type="number"
                min={1}
                step={1}
                aria-label={i === 0 ? "Tile Width" : "Tile Height"}
                disabled={readOnly}
                value={data.tileSize[i]}
                onChange={(e) => {
                  const v = Math.round(Number((e.currentTarget as HTMLInputElement).value));
                  if (Number.isFinite(v) && v > 0) set({ tileSize: i === 0 ? [v, data.tileSize[1]] : [data.tileSize[0], v] });
                }}
              />
            ))}
          </span>
        </div>
        <AnchorRow label="Default Anchor" title="Where tile sprites sit in their cells: the sprite's point lands on the same point of the cell. 0, 0 overhangs up and right; 0.5, 0 centres a tall tile on its cell." value={data.anchor ?? [0, 0]} readOnly={readOnly} onChange={(a) => set({ anchor: a[0] === 0 && a[1] === 0 ? undefined : a })} />
        <div class="tileset-history">
          <button disabled={readOnly || !doc.canUndo.value} onClick={undo} title="Undo the last edit to this tileset (Ctrl+Z)">
            Undo
          </button>
          <button disabled={readOnly || !doc.canRedo.value} onClick={redo} title="Redo (Ctrl+Shift+Z)">
            Redo
          </button>
        </div>
      </div>

      <div class="component asset-import-card">
        <h3>Terrains</h3>
        {data.terrains.length === 0 && <p class="hint">Terrains group tiles for auto-tiling: give tiles a terrain and a neighbour pattern, then paint the terrain.</p>}
        {data.terrains.map((t) => {
          const missing = missingBlobMasks(data.tiles.filter((x) => x.terrain === t.name)).length;
          return (
            <div class="tileset-terrain" key={t.name}>
              <div class="tileset-terrain-row">
                <input type="color" aria-label={`${t.name} colour`} disabled={readOnly} value={/^#[0-9a-f]{6}$/i.test(t.color ?? "") ? t.color : "#7cb342"} onChange={(e) => set({ terrains: data.terrains.map((o) => (o === t ? { ...o, color: (e.currentTarget as HTMLInputElement).value } : o)) })} />
                <input
                  type="text"
                  aria-label={`${t.name} name`}
                  disabled={readOnly}
                  defaultValue={t.name}
                  onChange={(e) => {
                    const name = (e.currentTarget as HTMLInputElement).value.trim();
                    if (!name || name === t.name || data.terrains.some((o) => o.name === name)) {
                      (e.currentTarget as HTMLInputElement).value = t.name;
                      return;
                    }
                    set({ terrains: data.terrains.map((o) => (o === t ? { ...o, name } : o)), tiles: data.tiles.map((x) => (x.terrain === t.name ? { ...x, terrain: name } : x)) });
                  }}
                />
                <button
                  aria-label={`Remove ${t.name}`}
                  title="Remove the terrain (its tiles keep their patterns but leave it)"
                  disabled={readOnly}
                  onClick={() => set({ terrains: data.terrains.filter((o) => o !== t), tiles: data.tiles.map((x) => { if (x.terrain !== t.name) return x; const { terrain: _t, ...rest } = x; return rest; }) })}
                >
                  ✕
                </button>
              </div>
              <span class="hint">{missing} of 47 blob shapes have no exact tile</span>
            </div>
          );
        })}
        <button
          disabled={readOnly}
          onClick={() => {
            let n = data.terrains.length + 1;
            while (data.terrains.some((t) => t.name === `Terrain ${n}`)) n++;
            set({ terrains: [...data.terrains, { name: `Terrain ${n}`, color: "#7cb342" }] });
          }}
        >
          Add Terrain
        </button>
      </div>

      <div class="component asset-import-card">
        <h3>Tiles</h3>
        {data.tiles.length === 0 ? (
          <p class="hint">No tiles yet. Slice an image in the Sprite Editor, then add its slices here.</p>
        ) : (
          <div class="tileset-grid" role="listbox" aria-label="Tiles">
            {data.tiles.map((t) => (
              <button key={t.id} class={`tileset-cell${t.id === selected ? " selected" : ""}`} role="option" aria-selected={t.id === selected} title={`${t.name ?? "Tile"} (${t.id})`} onClick={() => setSelected(t.id === selected ? null : t.id)}>
                <TileThumb project={project} tile={t} size={40} />
              </button>
            ))}
          </div>
        )}
        <AddFromSlices images={images} defaultImage={images.find((i) => data.tiles.some((t) => t.sprite.includes(`${i}#`))) ?? images[0]} disabled={readOnly} onAdd={addFrom} />
      </div>

      {tile && <TileEditor key={tile.id} data={data} tile={tile} readOnly={readOnly} setTile={(patch) => setTile(tile.id, patch)} onDelete={() => { set({ tiles: data.tiles.filter((t) => t.id !== tile.id) }); setSelected(null); }} project={project} />}
    </div>
  );
}

function AddFromSlices(props: { images: string[]; defaultImage: string | undefined; disabled: boolean; onAdd: (image: string) => void }) {
  const [image, setImage] = useState(props.defaultImage ?? "");
  const chosen = props.images.includes(image) ? image : props.defaultImage ?? "";
  if (props.images.length === 0) return <p class="hint">No image in the project has slices yet.</p>;
  return (
    <div class="tileset-add">
      <select aria-label="Image" value={chosen} onChange={(e) => setImage((e.currentTarget as HTMLSelectElement).value)}>
        {props.images.map((i) => (
          <option key={i} value={i}>
            {i}
          </option>
        ))}
      </select>
      <button disabled={props.disabled || !chosen} onClick={() => props.onAdd(chosen)}>
        Add tiles from slices
      </button>
    </div>
  );
}

function TileEditor(props: { data: TilesetData; tile: TileDef; readOnly: boolean; project: NonNullable<typeof currentProject.value>; setTile: (patch: Partial<TileDef>) => void; onDelete: () => void }) {
  const { data, tile, readOnly, setTile } = props;
  const kind = collisionKind(tile.collision);
  const poly = typeof tile.collision === "object" ? tile.collision : null;
  const [polyText, setPolyText] = useState(poly ? polygonText(poly.polygon) : "0,0 1,0 1,1 0,1");
  const [polyError, setPolyError] = useState(false);
  const [json, setJson] = useState(tile.data ? JSON.stringify(tile.data, null, 2) : "");
  const [jsonError, setJsonError] = useState<string | null>(null);
  const pattern = tile.pattern ?? ANY_PATTERN;

  const setKind = (k: CollisionKind) => {
    if (k === "polygon") {
      const pts = parsePolygon(polyText) ?? [[0, 0], [1, 0], [1, 1], [0, 1]];
      setTile({ collision: { polygon: pts } });
    } else setTile({ collision: k });
  };
  const commitPolygon = (text: string) => {
    const pts = parsePolygon(text);
    setPolyError(!pts);
    if (pts) setTile({ collision: poly?.oneWay ? { polygon: pts, oneWay: true } : { polygon: pts } });
  };
  const commitJson = (text: string) => {
    if (text.trim() === "") {
      setJsonError(null);
      return setTile({ data: undefined });
    }
    try {
      const v = JSON.parse(text) as unknown;
      if (typeof v !== "object" || v === null || Array.isArray(v)) throw new Error("expected a JSON object");
      setJsonError(null);
      setTile({ data: v as Record<string, unknown> });
    } catch (err) {
      setJsonError((err as Error).message);
    }
  };

  return (
    <div class="component asset-import-card tileset-tile">
      <h3>
        Tile {tile.id}
        <button class="tileset-delete" disabled={readOnly} title="Delete the tile (its id is never reused for another tile by this editor)" onClick={props.onDelete}>
          Delete
        </button>
      </h3>
      <div class="tileset-tile-preview">
        <TileThumb project={props.project} tile={tile} size={64} />
        <code>{tile.sprite || "no sprite"}</code>
      </div>
      <label class="import-row">
        <span>Name</span>
        <input type="text" aria-label="Name" disabled={readOnly} value={tile.name ?? ""} onChange={(e) => setTile({ name: (e.currentTarget as HTMLInputElement).value || undefined })} />
      </label>
      <label class="import-row">
        <span>Collision</span>
        <select aria-label="Collision" disabled={readOnly} value={kind} onChange={(e) => setKind((e.currentTarget as HTMLSelectElement).value as CollisionKind)}>
          <option value="none">None</option>
          <option value="full">Full</option>
          <option value="oneWay">One way</option>
          <option value="polygon">Polygon</option>
        </select>
      </label>
      {poly && (
        <>
          <label class="import-row" title="Points in cell units: 0,0 is the bottom-left corner, 1,1 the top-right">
            <span>Points</span>
            <input
              type="text"
              aria-label="Polygon points"
              class={polyError ? "invalid" : ""}
              disabled={readOnly}
              value={polyText}
              onInput={(e) => setPolyText((e.currentTarget as HTMLInputElement).value)}
              onChange={(e) => commitPolygon((e.currentTarget as HTMLInputElement).value)}
            />
          </label>
          {polyError && <p class="tileset-error">Needs three or more points like 0,0 1,0 1,1.</p>}
          <label class="import-row">
            <span>One way</span>
            <input type="checkbox" aria-label="Polygon one way" disabled={readOnly} checked={poly.oneWay === true} onChange={(e) => setTile({ collision: (e.currentTarget as HTMLInputElement).checked ? { polygon: poly.polygon, oneWay: true } : { polygon: poly.polygon } })} />
          </label>
        </>
      )}
      <label class="import-row">
        <span>Terrain</span>
        <select aria-label="Terrain" disabled={readOnly} value={tile.terrain ?? ""} onChange={(e) => setTile({ terrain: (e.currentTarget as HTMLSelectElement).value || undefined })}>
          <option value="">None</option>
          {data.terrains.map((t) => (
            <option key={t.name} value={t.name}>
              {t.name}
            </option>
          ))}
        </select>
      </label>
      <div class="import-row">
        <span title="Neighbours that must be the same terrain (■), a different one (□) or don't matter (·). Click to cycle.">Pattern</span>
        <div class="tileset-pattern" role="group" aria-label="Neighbour pattern">
          {PATTERN_AT.map((at, i) =>
            at < 0 ? (
              <span key={i} class="tileset-pattern-centre">
                tile
              </span>
            ) : (
              <button
                key={i}
                aria-label={`Neighbour ${["N", "NE", "E", "SE", "S", "SW", "W", "NW"][at]}: ${GLYPH_TITLE[pattern[at]]}`}
                title={GLYPH_TITLE[pattern[at]]}
                disabled={readOnly}
                onClick={() => {
                  const chars = pattern.split("");
                  chars[at] = NEXT[chars[at]];
                  const next = chars.join("");
                  setTile({ pattern: next === ANY_PATTERN ? undefined : next });
                }}
              >
                {GLYPH[pattern[at]]}
              </button>
            ),
          )}
        </div>
      </div>
      <label class="import-row" title="Relative chance for random brushes and auto-tiling ties">
        <span>Weight</span>
        <input
          type="number"
          min={0}
          step={0.1}
          aria-label="Weight"
          disabled={readOnly}
          value={tile.weight ?? 1}
          onChange={(e) => {
            const v = Number((e.currentTarget as HTMLInputElement).value);
            if (Number.isFinite(v) && v >= 0) setTile({ weight: v === 1 ? undefined : v });
          }}
        />
      </label>
      <AnchorRow label="Anchor" title="Where this tile's sprite sits in its cell (blank = the tileset's default anchor)" value={tile.anchor ?? data.anchor ?? [0, 0]} readOnly={readOnly} onChange={(a) => setTile({ anchor: a[0] === (data.anchor?.[0] ?? 0) && a[1] === (data.anchor?.[1] ?? 0) ? undefined : a })} />
      <div class="tileset-data">
        <span class="hint">Custom data (JSON object, read with getTileData)</span>
        <textarea
          aria-label="Custom data"
          class={jsonError ? "invalid" : ""}
          disabled={readOnly}
          rows={4}
          spellcheck={false}
          value={json}
          onInput={(e) => setJson((e.currentTarget as HTMLTextAreaElement).value)}
          onChange={(e) => commitJson((e.currentTarget as HTMLTextAreaElement).value)}
        />
        {jsonError && <p class="tileset-error">{jsonError}</p>}
      </div>
    </div>
  );
}

/** Two 0..1 number fields for a tile anchor (ADR 0119). */
function AnchorRow({ label, title, value, readOnly, onChange }: { label: string; title: string; value: [number, number]; readOnly: boolean; onChange: (anchor: [number, number]) => void }) {
  return (
    <div class="import-row" title={title}>
      <span>{label}</span>
      <span class="import-pivot tileset-size">
        {([0, 1] as const).map((i) => (
          <input
            key={i}
            type="number"
            min={0}
            max={1}
            step={0.5}
            aria-label={`${label} ${i === 0 ? "X" : "Y"}`}
            disabled={readOnly}
            value={value[i]}
            onChange={(e) => {
              const v = Number((e.currentTarget as HTMLInputElement).value);
              if (Number.isFinite(v) && v >= 0 && v <= 1) onChange(i === 0 ? [v, value[1]] : [value[0], v]);
            }}
          />
        ))}
      </span>
    </div>
  );
}

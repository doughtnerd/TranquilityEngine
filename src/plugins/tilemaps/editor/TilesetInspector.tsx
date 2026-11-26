// Tileset assets in the Inspector (ADR 0103): a `*.tileset.json` selected in the Assets panel shows its tile size,
// terrains and a grid of its tiles (Ctrl/⌘+click selects several); the selected tile's name, collision and shadow
// shapes (drawn over the tile, `TileShapeEditor.tsx`, ADR 0423), terrain, neighbour pattern (a 3 × 3 grid of buttons), weight, anchor, sort
// offset (ADR 0424), frame animation (`TileAnimationEditor.tsx`, ADR 0421) and custom data (JSON) are edited below. Every edit
// writes the file through the tileset's asset document and can be undone (Ctrl+Z / Ctrl+Shift+Z over the inspector,
// or the Undo / Redo buttons of the asset document frame, ADR 0265).
import { useEffect, useState } from "preact/hooks";
import { missingBlobMasks } from "../runtime/autotile";
import { ANY_PATTERN, type TileDef, type TilesetData, type TilesetPreviewGrid } from "../runtime/tileset";
import { tilesForSlices } from "./tilesetAssets";
import { TileThumb } from "./TileThumb";
import { AssetDocumentFrame, AssetPicker, ColorField, editor, openAssetDocument, EmptyState } from "../../../editor/sdk";
import { TileShapeEditor } from "./TileShapeEditor";
import { TileAnimationEditor } from "./TileAnimationEditor";
import { patchTiles } from "./tileShapeEditorLogic";
import "./tilesetInspector.css";

/** Grid position (row by row from the top-left) to its index in the pattern string N NE E SE S SW W NW; -1 is the centre. */
const PATTERN_AT = [7, 0, 1, 6, -1, 2, 5, 4, 3];
const NEXT: Record<string, string> = { "*": "1", "1": "0", "0": "*" };
const GLYPH: Record<string, string> = { "*": "·", "1": "■", "0": "□" };
const GLYPH_TITLE: Record<string, string> = { "*": "either", "1": "same terrain", "0": "other" };

/** The selected tileset asset (see the file comment). */
export function TilesetInspector(props: { path: string }) {
  editor.project.version; // rewritten by this inspector, or on disk
  const { path } = props;
  const project = editor.project.current;
  const [selected, setSelected] = useState<number | null>(null);
  // Other tiles selected with Ctrl/⌘+click, for Apply to selected tiles (ADR 0423).
  const [others, setOthers] = useState<ReadonlySet<number>>(new Set());
  useEffect(() => {
    setSelected(null);
    setOthers(new Set());
  }, [path]);
  if (!project) return <EmptyState compact title="Nothing selected" />;
  const doc = openAssetDocument<TilesetData>(project, path, "tileset");
  const data = doc.value.value;
  const readOnly = doc.readOnly;
  const tile = data.tiles.find((t) => t.id === selected) ?? null;

  // Every edit is one undo step through the tileset's asset document; a colour drag is one (`drag`, ADR 0282).
  const set = (patch: Partial<TilesetData>, drag = false, label?: string) => {
    if (readOnly) return;
    const next = { ...doc.value.peek(), ...patch };
    for (const k of Object.keys(patch) as (keyof TilesetData)[]) if (next[k] === undefined) delete next[k];
    doc.edit(next, drag || label ? { ...(drag ? { coalesce: true } : {}), ...(label ? { label } : {}) } : undefined);
  };
  const setTiles = (ids: ReadonlySet<number>, patch: Partial<TileDef>, label?: string) => set({ tiles: patchTiles(doc.value.peek().tiles, ids, patch) }, false, label);
  const setTile = (id: number, patch: Partial<TileDef>, label?: string) => setTiles(new Set([id]), patch, label);
  const otherIds = new Set([...others].filter((id) => id !== selected && data.tiles.some((t) => t.id === id)));
  const pick = (id: number, add: boolean) => {
    if (!add) {
      setOthers(new Set());
      return setSelected(id === selected ? null : id);
    }
    // Ctrl/⌘+click: the clicked tile joins the selection and becomes the edited one; clicking a selected one drops it.
    const all = new Set(otherIds);
    if (selected !== null) all.add(selected);
    if (all.has(id)) {
      all.delete(id);
      const next = id === selected ? ([...all].pop() ?? null) : selected;
      if (next !== null) all.delete(next);
      setSelected(next);
      setOthers(all);
      return;
    }
    setOthers(all);
    setSelected(id);
  };

  const usedSprites = new Set(data.tiles.map((t) => t.sprite));
  const hasSlices = (image: string) => editor.assets.importSettings(project, image).settings.sprites.length > 0;
  const images = project.files.filter((f) => editor.assets.kindOf(f) === "image" && hasSlices(f));
  const addFrom = (image: string) => {
    const nextId = data.tiles.reduce((m, t) => Math.max(m, t.id), 0) + 1;
    const added = tilesForSlices(editor.assets.importSettings(project, image).settings, image, nextId, usedSprites);
    if (added.length === 0) {
      editor.messages.info(`Every slice of ${editor.assets.fileName(image)} already has a tile.`);
      return;
    }
    set({ tiles: [...data.tiles, ...added] });
  };

  return (
    <AssetDocumentFrame doc={doc} kind="Tileset" class="inspector-body asset-inspector tileset-inspector">
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
        <label class="import-row" title="The cell outline the collision editor draws over tiles. Editor-only: maps use their own grid.">
          <span>Preview Grid</span>
          <select aria-label="Preview Grid" disabled={readOnly} value={data.previewGrid ?? "square"} onChange={(e) => {
            const v = (e.currentTarget as HTMLSelectElement).value as TilesetPreviewGrid;
            set({ previewGrid: v === "square" ? undefined : v });
          }}>
            <option value="square">Square</option>
            <option value="isometric">Isometric</option>
            <option value="hexagonal">Hexagonal</option>
          </select>
        </label>
        <AnchorRow label="Default Anchor" title="Where tile sprites sit in their cells: the sprite's point lands on the same point of the cell. 0, 0 overhangs up and right; 0.5, 0 centres a tall tile on its cell." value={data.anchor ?? [0, 0]} readOnly={readOnly} onChange={(a) => set({ anchor: a[0] === 0 && a[1] === 0 ? undefined : a })} />
      </div>

      <div class="component asset-import-card">
        <h3>Terrains</h3>
        {data.terrains.length === 0 && <p class="hint">Terrains group tiles for auto-tiling: give tiles a terrain and a neighbour pattern, then paint the terrain.</p>}
        {data.terrains.map((t) => {
          const missing = missingBlobMasks(data.tiles.filter((x) => x.terrain === t.name)).length;
          return (
            <div class="tileset-terrain" key={t.name}>
              <div class="tileset-terrain-row">
                <ColorField label={`${t.name} colour`} disabled={readOnly} value={/^#[0-9a-f]{6}$/i.test(t.color ?? "") ? t.color! : "#7cb342"} onValue={(color, drag) => set({ terrains: doc.value.peek().terrains.map((o) => (o.name === t.name ? { ...o, color } : o)) }, drag)} />
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
              <button key={t.id} class={`tileset-cell${t.id === selected ? " selected" : otherIds.has(t.id) ? " also-selected" : ""}`} role="option" aria-selected={t.id === selected || otherIds.has(t.id)} title={`${t.name ?? "Tile"} (${t.id}); Ctrl+click to select several`} onClick={(e) => pick(t.id, e.ctrlKey || e.metaKey)}>
                <TileThumb project={project} tile={t} size={40} />
              </button>
            ))}
          </div>
        )}
        <AddFromSlices images={images} accepts={hasSlices} defaultImage={images.find((i) => data.tiles.some((t) => t.sprite.includes(`${i}#`))) ?? images[0]} disabled={readOnly} onAdd={addFrom} />
      </div>

      {tile && (
        <TileEditor
          key={tile.id}
          data={data}
          tile={tile}
          readOnly={readOnly}
          others={otherIds.size}
          setTile={(patch, label) => setTile(tile.id, patch, label)}
          setOthers={(patch, label) => setTiles(otherIds, patch, label)}
          onDelete={() => {
            set({ tiles: data.tiles.filter((t) => t.id !== tile.id) });
            setSelected(null);
          }}
          project={project}
        />
      )}
    </AssetDocumentFrame>
  );
}

/** Pick an image with slices (the SDK's asset picker over images, narrowed to those with slices) and add a tile per slice. */
function AddFromSlices(props: { images: string[]; accepts: (image: string) => boolean; defaultImage: string | undefined; disabled: boolean; onAdd: (image: string) => void }) {
  const [image, setImage] = useState(props.defaultImage ?? "");
  const chosen = props.images.includes(image) ? image : props.defaultImage ?? "";
  if (props.images.length === 0) return <p class="hint">No image in the project has slices yet.</p>;
  return (
    <div class="tileset-add">
      <AssetPicker label="Image" kinds={["texture"]} stored="path" none={null} accepts={props.accepts} value={chosen} onCommit={setImage} />
      <button disabled={props.disabled || !chosen} onClick={() => props.onAdd(chosen)}>
        Add tiles from slices
      </button>
    </div>
  );
}

function TileEditor(props: { data: TilesetData; tile: TileDef; readOnly: boolean; others: number; project: NonNullable<typeof editor.project.current>; setTile: (patch: Partial<TileDef>, label?: string) => void; setOthers: (patch: Partial<TileDef>, label: string) => void; onDelete: () => void }) {
  const { data, tile, readOnly, setTile } = props;
  const [json, setJson] = useState(tile.data ? JSON.stringify(tile.data, null, 2) : "");
  const [jsonError, setJsonError] = useState<string | null>(null);
  const pattern = tile.pattern ?? ANY_PATTERN;

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
        <button class="tileset-delete" disabled={readOnly} title="Delete the tile (maps that used it leave those cells empty; no tile added later takes its place)" onClick={props.onDelete}>
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
      <TileShapeEditor project={props.project} data={data} tile={tile} readOnly={readOnly} others={props.others} onPatch={(patch, label) => setTile(patch, label)} onApplyToSelected={props.setOthers} />
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
      <label class="import-row" title="Applies in y-sorted sorting layers: the tile sorts this many cells above its cell's bottom, against sprites and other tiles (a tree whose trunk stands in the cell above). 0 sorts by the cell's bottom.">
        <span>Sort Offset</span>
        <input
          type="number"
          step={0.5}
          aria-label="Sort Offset"
          disabled={readOnly}
          value={tile.sortOffset ?? 0}
          onChange={(e) => {
            const input = e.currentTarget as HTMLInputElement;
            const v = Number(input.value);
            if (input.value.trim() === "" || !Number.isFinite(v)) {
              input.value = String(tile.sortOffset ?? 0);
              return;
            }
            setTile({ sortOffset: v === 0 ? undefined : v }, "Set sort offset");
          }}
        />
      </label>
      <TileAnimationEditor project={props.project} tile={tile} readOnly={readOnly} onPatch={setTile} />
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

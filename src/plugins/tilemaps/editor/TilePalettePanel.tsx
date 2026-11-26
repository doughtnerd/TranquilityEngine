// The Tile Palette (ADR 0103): for the selected Tilemap, the brush tools, the layer list and the tileset's tiles and
// terrains. Choosing a tile, a block of tiles, several tiles (random brush) or a terrain sets the brush the scene
// view paints with through the brush (tilemap/brush.ts, ADR 0289; tilemap/paintTool.ts).
// ADR 0425: each layer has a lock (the brushes skip a locked layer; choosing it says so), and Dim inactive layers is a
// per-user view toggle. ADR 0426: the selection tool's actions and its All layers toggle; the tileset's saved stamps
// (save the brush's stamp by name, click to use, rename and delete from its menu, all tileset edits with the tileset's
// undo); a tile's menu has Replace with…; the Prefabs tab lists the tileset's prefabs for the prefab brush (drop one from
// the Assets panel to add it).
import { useEffect, useRef, useState } from "preact/hooks";
import type { Tilemap } from "../runtime";
import { FLIP_DIAGONAL, FLIP_X, FLIP_Y, newLayer, tileIdOf, type TilemapLayerData } from "../runtime/format";
import type { TileDef, Tileset, TilesetData } from "../runtime/tileset";
import {
  activeLayer,
  BRUSH_TOOLS,
  brushFlags,
  brushLayers,
  brushPrefabs,
  brushRandom,
  brushSource,
  brushStamp,
  brushTerrain,
  brushTool,
  canRotateOn,
  chooseBlock,
  choosePrefabs,
  chooseStamp,
  chooseTerrain,
  dimInactiveLayers,
  flipBrush,
  pickBrushTool,
  tilemapOf,
} from "./brush";
import { blockStamp, commitLayers, commitTileset, editedLayers, replaceTileIn, type ReplaceScope } from "./palette";
import { prefabPath } from "./prefabBrush";
import { blockIsEmpty, blockOfStamp, decodeStamp, encodeStamp, removePrefab, removeStamp, renameStamp, retargetBlock, uniqueStampName, withPrefab, withStamp, type StampBlock } from "./stampLibrary";
import { copyTiles, cutTiles, deleteTiles, selectAllLayers, selectionOf, tileSelection, transformTiles } from "./tileSelection";
import { TileThumb } from "./TileThumb";
import { ContextMenu, editor, EmptyState, openAssetDocument, Panel, registerAssetDropTarget, type AssetDocument, type MenuEntry } from "../../../editor/sdk";
import "./tilePalette.css";

const MIN_COLUMNS = 1, MAX_COLUMNS = 32;

type Project = NonNullable<typeof editor.project.current>;

/** A padlock, closed or open, stroked in a 24 × 24 box. */
const LOCK_CLOSED = "M7 11V8a5 5 0 0 1 10 0v3M5 11h14v10H5z";
const LOCK_OPEN = "M7 11V8a5 5 0 0 1 9.6-2M5 11h14v10H5z";

/** The Tile Palette panel (see the file comment). */
export function TilePalettePanel() {
  editor.project.version;
  editor.scene.selection.active;
  const [tab, setTab] = useState<"tiles" | "prefabs">("tiles");
  const scene = editor.scene.open, path = editor.scene.selection.path(), project = editor.project.current;
  const map = editor.scene.whyNotEdit() === null ? tilemapOf(editor.scene.selection.node()) : null;
  if (!scene || !path || !project || !map) return <Panel><EmptyState compact title="Select a node with a Tilemap to paint." /></Panel>;
  const readOnly = !project.canSave;
  const layers = map.toLayerData();
  const tileset = map.tilesetAsset;
  const tilesets = project.files.filter((f) => editor.assets.kindOf(f) === "tileset");
  const sortingLayers = project.settings.render?.sortingLayers ?? ["Default"];
  const active = Math.min(activeLayer.value, layers.length - 1);

  const edit = (label: string, fn: (l: typeof layers) => void) => commitLayers(scene, path, editedLayers(map, fn), label);
  const move = (i: number, by: -1 | 1) => {
    const j = i + by;
    if (j < 0 || j >= layers.length) return;
    edit("Move layer", (l) => void ([l[i], l[j]] = [l[j], l[i]]));
    if (active === i) activeLayer.value = j;
    else if (active === j) activeLayer.value = i;
  };
  const chooseLayer = (i: number, l: TilemapLayerData) => {
    activeLayer.value = i;
    if (l.locked) editor.messages.info(`The layer “${l.name}” is locked: the brushes skip it until it's unlocked.`);
  };
  const tilesetDoc = tileset && map.tileset ? openAssetDocument<TilesetData>(project, map.tileset, "tileset") : null;

  return (
    <Panel>
      <div class="tile-palette">
        <BrushBar map={map} />
        <SelectionBar map={map} />
        <section class="tile-palette-section">
          <h4>Tileset</h4>
          <select aria-label="Tileset" disabled={readOnly} value={map.tileset} onChange={(e) => commitTileset(scene, path, (e.currentTarget as HTMLSelectElement).value)}>
            <option value="">{tilesets.length === 0 ? "No tilesets in the project" : "Choose a tileset…"}</option>
            {tilesets.map((f) => (
              <option key={f} value={f}>
                {f}
              </option>
            ))}
            {map.tileset && !tilesets.includes(map.tileset) && <option value={map.tileset}>{map.tileset} (missing)</option>}
          </select>
        </section>
        <section class="tile-palette-section">
          <h4>Layers</h4>
          <ul class="tile-layers" aria-label="Layers">
            {layers.map((l, i) => (
              <li key={i} class={`${i === active ? "active" : ""}${l.locked ? " locked" : ""}`} onClick={() => chooseLayer(i, l)}>
                <button
                  class={`tile-layer-lock${l.locked ? " active" : ""}`}
                  aria-label={`${l.name} locked`}
                  aria-pressed={!!l.locked}
                  title={l.locked ? "Locked: the brushes skip this layer. Click to unlock." : "Lock the layer so the brushes skip it"}
                  disabled={readOnly}
                  onClick={(e) => {
                    e.stopPropagation();
                    edit(l.locked ? "Unlock layer" : "Lock layer", (x) => {
                      if (l.locked) delete x[i].locked;
                      else x[i].locked = true;
                    });
                  }}
                >
                  <svg viewBox="0 0 24 24" width="12" height="12" aria-hidden="true">
                    <path d={l.locked ? LOCK_CLOSED : LOCK_OPEN} />
                  </svg>
                </button>
                <input type="checkbox" aria-label={`${l.name} visible`} title="Visible" checked={l.visible} disabled={readOnly} onClick={(e) => e.stopPropagation()} onChange={(e) => edit("Toggle layer visibility", (x) => (x[i].visible = (e.currentTarget as HTMLInputElement).checked))} />
                <input type="checkbox" aria-label={`${l.name} collision`} title="Collision" checked={l.collision} disabled={readOnly} onClick={(e) => e.stopPropagation()} onChange={(e) => edit("Toggle layer collision", (x) => (x[i].collision = (e.currentTarget as HTMLInputElement).checked))} />
                <input
                  key={l.name}
                  type="text"
                  class="tile-layer-name"
                  aria-label={`Layer ${i + 1} name`}
                  defaultValue={l.name}
                  disabled={readOnly}
                  onClick={(e) => e.stopPropagation()}
                  onChange={(e) => {
                    const name = (e.currentTarget as HTMLInputElement).value.trim();
                    if (name) edit("Rename layer", (x) => (x[i].name = name));
                    else (e.currentTarget as HTMLInputElement).value = l.name;
                  }}
                />
                <select aria-label={`${l.name} sorting layer`} title="Sorting layer" value={l.sortingLayer} disabled={readOnly} onClick={(e) => e.stopPropagation()} onChange={(e) => edit("Set sorting layer", (x) => (x[i].sortingLayer = (e.currentTarget as HTMLSelectElement).value))}>
                  {(sortingLayers.includes(l.sortingLayer) ? sortingLayers : [...sortingLayers, l.sortingLayer]).map((s) => (
                    <option key={s} value={s}>
                      {s}
                    </option>
                  ))}
                </select>
                <input
                  type="number"
                  step={1}
                  class="tile-layer-order"
                  aria-label={`${l.name} order in layer`}
                  title="Order in layer"
                  value={l.orderInLayer}
                  disabled={readOnly}
                  onClick={(e) => e.stopPropagation()}
                  onChange={(e) => {
                    const v = Math.round(Number((e.currentTarget as HTMLInputElement).value));
                    if (Number.isFinite(v)) edit("Set layer order", (x) => (x[i].orderInLayer = v));
                  }}
                />
                <button aria-label={`Move ${l.name} up`} title="Move up" disabled={readOnly || i === 0} onClick={(e) => (e.stopPropagation(), move(i, -1))}>
                  ↑
                </button>
                <button aria-label={`Move ${l.name} down`} title="Move down" disabled={readOnly || i === layers.length - 1} onClick={(e) => (e.stopPropagation(), move(i, 1))}>
                  ↓
                </button>
                <button
                  aria-label={`Remove ${l.name}`}
                  title={layers.length === 1 ? "A Tilemap keeps at least one layer" : "Remove the layer and its tiles"}
                  disabled={readOnly || layers.length === 1}
                  onClick={(e) => {
                    e.stopPropagation();
                    edit("Remove layer", (x) => void x.splice(i, 1));
                    if (active >= i) activeLayer.value = Math.max(0, active - 1);
                  }}
                >
                  ✕
                </button>
              </li>
            ))}
          </ul>
          <div class="tile-layer-actions">
            <button
              disabled={readOnly}
              onClick={() => {
                let n = layers.length + 1;
                while (layers.some((l) => l.name === `Layer ${n}`)) n++;
                edit("Add layer", (x) => void x.push(newLayer(`Layer ${n}`, sortingLayers[0] ?? "Default")));
                activeLayer.value = layers.length;
              }}
            >
              Add Layer
            </button>
            <label class="tile-dim" title="While painting, draw this Tilemap's other layers at 35 % in the scene view (your setting, not saved in the scene)">
              <input type="checkbox" aria-label="Dim inactive layers" checked={dimInactiveLayers.value} onChange={(e) => (dimInactiveLayers.value = (e.currentTarget as HTMLInputElement).checked)} />
              Dim inactive layers
            </label>
          </div>
        </section>
        {tileset ? (
          <>
            <div class="tile-tabs" role="tablist" aria-label="Brush content">
              <button role="tab" aria-selected={tab === "tiles"} class={tab === "tiles" ? "active" : ""} onClick={() => (setTab("tiles"), choosePrefabs([]))}>
                Tiles
              </button>
              <button role="tab" aria-selected={tab === "prefabs"} class={tab === "prefabs" ? "active" : ""} onClick={() => setTab("prefabs")}>
                Prefabs
              </button>
            </div>
            {tab === "tiles" ? (
              <>
                <section class="tile-palette-section">
                  <h4>Tiles</h4>
                  <TileGridView tiles={tileset.data.tiles} tileset={tileset} project={project} replace={(from, to, scope) => replaceTileIn(scene, path, map, from, to, scope, active)} readOnly={readOnly} />
                </section>
                {tileset.data.terrains.length > 0 && (
                  <section class="tile-palette-section">
                    <h4>Terrains</h4>
                    <ul class="tile-terrains" aria-label="Terrains">
                      {tileset.data.terrains.map((t) => (
                        <li key={t.name}>
                          <button
                            class={brushTerrain.value === t.name ? "active" : ""}
                            aria-pressed={brushTerrain.value === t.name}
                            onClick={() => chooseTerrain(brushTerrain.peek() === t.name ? null : t.name)}
                          >
                            <span class="tile-terrain-swatch" style={{ background: t.color ?? "var(--muted)" }} />
                            {t.name}
                          </button>
                        </li>
                      ))}
                    </ul>
                  </section>
                )}
                {tilesetDoc && <StampsSection doc={tilesetDoc} tileset={tileset} layerName={layers[active]?.name ?? ""} />}
              </>
            ) : (
              tilesetDoc && <PrefabsSection doc={tilesetDoc} project={project} />
            )}
          </>
        ) : (
          map.tileset && <p class="hint">The tileset “{map.tileset}” couldn't be read.</p>
        )}
      </div>
    </Panel>
  );
}

/** The tool buttons, random toggle and flip buttons. Rotate is off on hexagonal maps (ADR 0421). */
function BrushBar(props: { map: Tilemap }) {
  const tool = brushTool.value, flags = brushFlags.value;
  const canRotate = canRotateOn(props.map);
  return (
    <div class="tile-brushbar" role="toolbar" aria-label="Brush">
      {BRUSH_TOOLS.map((t) => (
        <button key={t.tool} class={tool === t.tool ? "active" : ""} aria-pressed={tool === t.tool} title={t.title} onClick={() => pickBrushTool(tool === t.tool ? null : t.tool)}>
          {t.label}
        </button>
      ))}
      <span class="tile-brushbar-gap" />
      <button class={brushRandom.value ? "active" : ""} aria-pressed={brushRandom.value} title="Paint with one of the chosen tiles at random, by weight" onClick={() => (brushRandom.value = !brushRandom.value)}>
        Random
      </button>
      <button class={flags & FLIP_X ? "active" : ""} aria-pressed={!!(flags & FLIP_X)} title="Flip what is painted horizontally (X)" onClick={() => flipBrush("x", props.map)}>
        Flip X
      </button>
      <button class={flags & FLIP_Y ? "active" : ""} aria-pressed={!!(flags & FLIP_Y)} title="Flip what is painted vertically (Y)" onClick={() => flipBrush("y", props.map)}>
        Flip Y
      </button>
      <button
        class={flags & FLIP_DIAGONAL ? "active" : ""}
        aria-pressed={!!(flags & FLIP_DIAGONAL)}
        disabled={!canRotate}
        title={canRotate ? "Rotate what is painted a quarter turn (Z)" : "A quarter turn isn't a symmetry of a hexagonal grid"}
        onClick={() => flipBrush("rotate", props.map)}
      >
        Rotate
      </button>
    </div>
  );
}

/** The selection tool's actions on the selection (ADR 0426), shown while selecting or while there's a selection. */
function SelectionBar(props: { map: Tilemap }) {
  void tileSelection.value;
  const selected = selectionOf(props.map).size;
  if (brushTool.value !== "select" && selected === 0) return null;
  const none = selected === 0;
  const canRotate = canRotateOn(props.map);
  return (
    <div class="tile-brushbar tile-selectionbar" role="toolbar" aria-label="Selection">
      <span class="hint">{none ? "Drag cells to select them" : `${selected} ${selected === 1 ? "cell" : "cells"} selected`}</span>
      <span class="tile-brushbar-gap" />
      <button disabled={none} title="Copy the selected cells into the brush (Ctrl/⌘+C)" onClick={() => copyTiles()}>
        Copy
      </button>
      <button disabled={none} title="Copy the selected cells into the brush and empty them (Ctrl/⌘+X)" onClick={() => cutTiles()}>
        Cut
      </button>
      <button disabled={none} title="Empty the selected cells (Delete)" onClick={() => deleteTiles()}>
        Delete
      </button>
      <button disabled={none} title="Mirror the selection left to right in place (X)" onClick={() => transformTiles("x")}>
        Flip X
      </button>
      <button disabled={none} title="Mirror the selection top to bottom in place (Y)" onClick={() => transformTiles("y")}>
        Flip Y
      </button>
      <button disabled={none || !canRotate} title={canRotate ? "Turn the selection a quarter turn in place (Z)" : "A quarter turn isn't a symmetry of a hexagonal grid"} onClick={() => transformTiles("rotate")}>
        Rotate
      </button>
      <label class="tile-dim" title="Select, copy, cut and delete on every unlocked layer">
        <input type="checkbox" aria-label="All layers" checked={selectAllLayers.value} onChange={(e) => (selectAllLayers.value = (e.currentTarget as HTMLInputElement).checked)} />
        All layers
      </label>
    </div>
  );
}

/**
 * The tiles in id order. Click picks one; dragging (or Shift-dragging) picks the block of tiles it covers as a
 * stamp; Ctrl/⌘-click adds or removes tiles from a set for the random brush. A tile's menu (right-click) has Replace
 * with…: the next tile clicked replaces it in the chosen scope (ADR 0426).
 */
function TileGridView(props: { tiles: readonly TileDef[]; tileset: Tileset; project: Project; readOnly: boolean; replace: (from: number, to: number, scope: ReplaceScope) => number }) {
  const [columns, setColumns] = useState(8);
  const [menu, setMenu] = useState<{ x: number; y: number; tile: TileDef } | null>(null);
  const [replacing, setReplacing] = useState<TileDef | null>(null);
  const [scope, setScope] = useState<ReplaceScope>("layer");
  const anchor = useRef<number | null>(null);
  const dragged = useRef(false);
  const tiles = [...props.tiles].sort((a, b) => a.id - b.id);
  const ids = tiles.map((t) => t.id);
  const stamp = brushStamp.value;
  const chosen = new Set(brushTerrain.value || brushPrefabs.value.length > 0 ? [] : stamp.values.filter((v) => v !== 0).map(tileIdOf));
  const label = (t: TileDef) => `${t.name ?? "Tile"} (${t.id})`;

  const indexAt = (e: PointerEvent): number | null => {
    const el = document.elementFromPoint(e.clientX, e.clientY)?.closest<HTMLElement>("[data-index]");
    return el ? Number(el.dataset.index) : null;
  };
  const choose = (a: number, b: number) => chooseStamp(blockStamp(ids, columns, a, b), false, props.tileset);
  const replaceWith = (to: TileDef) => {
    const from = replacing;
    setReplacing(null);
    if (!from || from.id === to.id) return;
    const n = props.replace(from.id, to.id, scope);
    editor.messages.info(n === 0 ? `No cell has ${label(from)} there.` : `Replaced ${label(from)} with ${label(to)} in ${n} ${n === 1 ? "cell" : "cells"}.`);
  };
  const menuEntries = (t: TileDef): MenuEntry[] => [
    { id: "replace", label: "Replace with…", disabled: props.readOnly, title: "Pick the tile to put in its place", run: () => setReplacing(t) },
  ];

  return (
    <>
      <label class="tile-columns">
        Columns
        <input type="number" min={MIN_COLUMNS} max={MAX_COLUMNS} step={1} aria-label="Columns" value={columns} onChange={(e) => {
          const v = Math.round(Number((e.currentTarget as HTMLInputElement).value));
          if (Number.isFinite(v)) setColumns(Math.min(MAX_COLUMNS, Math.max(MIN_COLUMNS, v)));
        }} />
      </label>
      {replacing && (
        <div class="tile-replace" role="group" aria-label="Replace tile">
          <span>Click the tile to replace {label(replacing)} with, in</span>
          <select aria-label="Replace in" value={scope} onChange={(e) => setScope((e.currentTarget as HTMLSelectElement).value as ReplaceScope)}>
            <option value="layer">the active layer</option>
            <option value="layers">every layer</option>
            <option value="scene">every Tilemap in the scene with this tileset</option>
          </select>
          <button onClick={() => setReplacing(null)}>Cancel</button>
        </div>
      )}
      {tiles.length === 0 && <p class="hint">The tileset has no tiles. Select it in the Assets panel to add some.</p>}
      <div class="tile-grid" role="listbox" aria-label="Tiles" aria-multiselectable="true" style={{ gridTemplateColumns: `repeat(${columns}, max-content)` }}>
        {tiles.map((t, i) => (
          <button
            key={t.id}
            data-index={i}
            class={`tile-grid-cell${chosen.has(t.id) ? " selected" : ""}${replacing?.id === t.id ? " replacing" : ""}`}
            role="option"
            aria-selected={chosen.has(t.id)}
            title={label(t)}
            onContextMenu={(e) => {
              e.preventDefault();
              setMenu({ x: e.clientX, y: e.clientY, tile: t });
            }}
            onPointerDown={(e) => {
              if (e.button !== 0) return;
              if (replacing) {
                e.preventDefault();
                replaceWith(t);
                return;
              }
              if (e.ctrlKey || e.metaKey) {
                e.preventDefault();
                const now = new Set(chosen);
                if (now.has(t.id)) now.delete(t.id);
                else now.add(t.id);
                if (now.size === 0) return;
                const picked = [...now];
                chooseStamp({ width: picked.length, height: 1, values: picked }, true, props.tileset);
                return;
              }
              anchor.current = e.shiftKey && anchor.current !== null ? anchor.current : i;
              dragged.current = e.shiftKey;
              if (e.shiftKey) choose(anchor.current, i);
              (e.currentTarget as HTMLElement).setPointerCapture?.(e.pointerId);
            }}
            onPointerMove={(e) => {
              if (anchor.current === null || !(e.buttons & 1)) return;
              const at = indexAt(e);
              if (at === null || (at === anchor.current && !dragged.current)) return;
              dragged.current = true;
              choose(anchor.current, at);
            }}
            onPointerUp={() => {
              if (anchor.current !== null && !dragged.current) chooseStamp({ width: 1, height: 1, values: [t.id] }, false, props.tileset);
              anchor.current = null;
              dragged.current = false;
            }}
          >
            <TileThumb project={props.project} tile={t} size={32} />
          </button>
        ))}
      </div>
      {menu && <ContextMenu inline label="Tile menu" at={{ x: menu.x, y: menu.y }} entries={menuEntries(menu.tile)} onClose={() => setMenu(null)} />}
    </>
  );
}

/** The brush's stamp as a block of `tileset`'s tiles, the one layer named `layerName` (null when it has no tile). */
function brushBlockOf(tileset: Tileset, layerName: string): StampBlock | null {
  let block = brushLayers.value ?? blockOfStamp(brushStamp.value, layerName);
  const from = brushSource.value;
  if (from && from.data !== tileset.data) block = retargetBlock(block, from, tileset).block;
  return blockIsEmpty(block) ? null : block;
}

/**
 * The tileset's saved stamps (ADR 0426): Save stamp stores the brush's stamp under a name, a click makes a stamp the
 * brush's, and its menu renames or deletes it. Each change is an edit of the tileset's document (its undo).
 */
function StampsSection(props: { doc: AssetDocument<TilesetData>; tileset: Tileset; layerName: string }) {
  const { doc, tileset } = props;
  const data = doc.value.value;
  const stamps = data.stamps ?? [];
  const [name, setName] = useState("");
  const [menu, setMenu] = useState<{ x: number; y: number; name: string } | null>(null);
  const [renaming, setRenaming] = useState<string | null>(null);
  const readOnly = doc.readOnly;
  const current = brushBlockOf(tileset, props.layerName);
  const save = () => {
    if (!current) return;
    const stampName = name.trim() ? name.trim() : uniqueStampName(doc.value.peek(), "Stamp");
    const replaced = stamps.some((s) => s.name === stampName);
    doc.edit(withStamp(doc.value.peek(), encodeStamp(stampName, current, tileset)), { label: replaced ? "Replace stamp" : "Save stamp" });
    setName("");
  };
  const use = (stampName: string) => {
    const stamp = (doc.value.peek().stamps ?? []).find((s) => s.name === stampName);
    if (!stamp) return;
    const { block, missing } = decodeStamp(stamp, tileset);
    chooseBlock(block, tileset);
    if (missing > 0) editor.messages.info(`The stamp “${stampName}” names ${missing === 1 ? "a tile" : `${missing} tiles`} the tileset no longer has; ${missing === 1 ? "that cell pastes" : "those cells paste"} empty.`);
  };
  const entries = (stampName: string): MenuEntry[] => [
    { id: "rename", label: "Rename…", disabled: readOnly, run: () => setRenaming(stampName) },
    { id: "delete", label: "Delete", danger: true, disabled: readOnly, run: () => doc.edit(removeStamp(doc.value.peek(), stampName), { label: "Delete stamp" }) },
  ];
  return (
    <section class="tile-palette-section">
      <h4>Stamps</h4>
      {stamps.length === 0 && <p class="hint">No saved stamps. Pick or copy a block of tiles, then save it here.</p>}
      <ul class="tile-stamps" aria-label="Stamps">
        {stamps.map((s) => (
          <li key={s.name}>
            {renaming === s.name ? (
              <input
                type="text"
                aria-label={`Rename ${s.name}`}
                defaultValue={s.name}
                ref={(el) => el?.focus()}
                onKeyDown={(e) => {
                  if (e.key === "Escape") setRenaming(null);
                  else if (e.key === "Enter") (e.currentTarget as HTMLInputElement).blur();
                }}
                onBlur={(e) => {
                  const to = (e.currentTarget as HTMLInputElement).value.trim();
                  setRenaming(null);
                  if (to && to !== s.name) {
                    if (stamps.some((o) => o.name === to)) editor.messages.info(`There's already a stamp called “${to}”.`);
                    else doc.edit(renameStamp(doc.value.peek(), s.name, to), { label: "Rename stamp" });
                  }
                }}
              />
            ) : (
              <button
                class="tile-stamp"
                title={`${s.size[0]} × ${s.size[1]}, ${s.layers.length === 1 ? "1 layer" : `${s.layers.length} layers`}. Click to paint with it; right-click for its menu.`}
                onClick={() => use(s.name)}
                onContextMenu={(e) => {
                  e.preventDefault();
                  setMenu({ x: e.clientX, y: e.clientY, name: s.name });
                }}
              >
                {s.name}
                <span class="tile-stamp-size">
                  {s.size[0]} × {s.size[1]}
                </span>
              </button>
            )}
            <button
              class="tile-stamp-menu"
              aria-label={`${s.name} menu`}
              title="Rename or delete"
              onClick={(e) => {
                const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
                setMenu({ x: r.left, y: r.bottom, name: s.name });
              }}
            >
              …
            </button>
          </li>
        ))}
      </ul>
      <div class="tile-stamp-save">
        <input type="text" aria-label="Stamp name" placeholder={uniqueStampName(data, "Stamp")} value={name} disabled={readOnly} onInput={(e) => setName((e.currentTarget as HTMLInputElement).value)} onKeyDown={(e) => e.key === "Enter" && save()} />
        <button disabled={readOnly || !current} title={current ? "Save the brush's stamp in the tileset under this name" : "Pick or copy some tiles first"} onClick={save}>
          Save stamp
        </button>
      </div>
      {menu && <ContextMenu inline label="Stamp menu" at={{ x: menu.x, y: menu.y }} entries={entries(menu.name)} onClose={() => setMenu(null)} />}
    </section>
  );
}

/**
 * The tileset's prefabs for the prefab brush (ADR 0426): click one to paint with it, Ctrl/⌘-click to choose several
 * (one at random per cell), ✕ to take it off the list; drop prefabs from the Assets panel to add them. The list is a
 * tileset edit with the tileset's undo.
 */
function PrefabsSection(props: { doc: AssetDocument<TilesetData>; project: Project }) {
  const { doc } = props;
  const prefabs = doc.value.value.prefabs ?? [];
  const chosen = new Set(brushPrefabs.value);
  const zone = useRef<HTMLElement>(null);
  const [over, setOver] = useState<string | null>(null);
  const isPrefab = (p: string) => editor.assets.kindOf(p) === "prefab";
  useEffect(() => {
    const el = zone.current;
    if (!el) return;
    return registerAssetDropTarget(el, {
      accepts: (assets) => assets.length > 0 && assets.every(isPrefab),
      label: () => (doc.readOnly ? null : "Add to the tileset's prefabs"),
      drop: (assets) => {
        let next = doc.value.peek();
        for (const a of assets) next = withPrefab(next, `asset:${a}`);
        if (next !== doc.value.peek()) doc.edit(next, { label: assets.length === 1 ? "Add prefab" : "Add prefabs" });
      },
      over: (assets) => setOver(doc.readOnly ? null : `Add ${assets.length === 1 ? editor.assets.fileName(assets[0]!) : `${assets.length} prefabs`}`),
      leave: () => setOver(null),
    });
  }, [doc]);
  const pick = (ref: string, add: boolean) => {
    const path = prefabPath(ref);
    if (!add) return choosePrefabs(chosen.size === 1 && chosen.has(path) ? [] : [path]);
    const now = new Set(chosen);
    if (now.has(path)) now.delete(path);
    else now.add(path);
    choosePrefabs([...now]);
  };
  return (
    <section ref={zone} class={`tile-palette-section tile-prefabs${over ? " over" : ""}`}>
      <h4>Prefabs</h4>
      {prefabs.length === 0 && <p class="hint">Drop prefabs here from the Assets panel to paint them on the grid.</p>}
      <ul class="tile-stamps" aria-label="Prefabs">
        {prefabs.map((ref) => {
          const path = prefabPath(ref);
          const missing = !props.project.files.includes(path);
          return (
            <li key={ref}>
              <button class={`tile-stamp${chosen.has(path) ? " active" : ""}`} aria-pressed={chosen.has(path)} title={missing ? `${path} isn't in the project` : `Paint ${path} with the pencil and rectangle; the eraser removes instances (Ctrl/⌘-click to choose several, placed at random)`} disabled={missing} onClick={(e) => pick(ref, e.ctrlKey || e.metaKey)}>
                {editor.assets.fileName(path)}
                {missing && <span class="tile-stamp-size">missing</span>}
              </button>
              <button class="tile-stamp-menu" aria-label={`Remove ${editor.assets.fileName(path)}`} title="Take it off the tileset's prefabs" disabled={doc.readOnly} onClick={() => {
                if (chosen.has(path)) choosePrefabs([...chosen].filter((p) => p !== path));
                doc.edit(removePrefab(doc.value.peek(), ref), { label: "Remove prefab" });
              }}>
                ✕
              </button>
            </li>
          );
        })}
      </ul>
      {over && <p class="hint">{over}</p>}
    </section>
  );
}

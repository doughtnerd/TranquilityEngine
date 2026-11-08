// The Tile Palette (ADR 0103): for the selected Tilemap, the brush tools, the layer list and the tileset's tiles and
// terrains. Choosing a tile, a block of tiles, several tiles (random brush) or a terrain sets the brush the scene
// view paints with (tilemap/brush.ts, tilemap/paintTool.ts).
import { useRef, useState } from "preact/hooks";
import { FLIP_DIAGONAL, FLIP_X, FLIP_Y, newLayer, tileIdOf } from "../../plugins/tilemaps/runtime/format";
import type { TileDef } from "../../plugins/tilemaps/runtime/tileset";
import { assetKind } from "../assetBrowser";
import { activeLayer, BRUSH_TOOLS, brushFlags, brushRandom, brushStamp, brushTerrain, brushTile, brushTool, flipBrush, pickBrushTool, tilemapOf } from "../tilemap/brush";
import { blockStamp, commitLayers, commitTileset, editedLayers } from "../tilemap/palette";
import { currentProject, docVersion, openScene, playState, selectedPath, selectedWorldNode, selection } from "../state";
import { TileThumb } from "./TileThumb";
import "./tilePalette.css";

const MIN_COLUMNS = 1, MAX_COLUMNS = 32;

/** The Tile Palette panel (see the file comment). */
export function TilePalettePanel() {
  docVersion.value;
  selection.value;
  const scene = openScene.value, path = selectedPath(), project = currentProject.value;
  const map = playState.value === "edit" ? tilemapOf(selectedWorldNode()) : null;
  if (!scene || !path || !project || !map) return <p class="empty">Select a node with a Tilemap to paint.</p>;
  const readOnly = !project.canSave;
  const layers = map.toLayerData();
  const tileset = map.tilesetAsset;
  const tilesets = project.files.filter((f) => assetKind(f) === "tileset");
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

  return (
    <div class="tile-palette">
      <BrushBar />
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
            <li key={i} class={i === active ? "active" : ""} onClick={() => (activeLayer.value = i)}>
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
      </section>
      {tileset ? (
        <>
          <section class="tile-palette-section">
            <h4>Tiles</h4>
            <TileGridView tiles={tileset.data.tiles} project={project} />
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
                      onClick={() => {
                        if (brushTerrain.peek() === t.name) brushTerrain.value = null;
                        else {
                          brushTerrain.value = t.name;
                          if (!brushTool.peek() || brushTool.peek() === "pick") pickBrushTool("pencil");
                        }
                      }}
                    >
                      <span class="tile-terrain-swatch" style={{ background: t.color ?? "var(--muted)" }} />
                      {t.name}
                    </button>
                  </li>
                ))}
              </ul>
            </section>
          )}
        </>
      ) : (
        map.tileset && <p class="hint">The tileset “{map.tileset}” couldn't be read.</p>
      )}
    </div>
  );

}

/** The tool buttons, random toggle and flip buttons. */
function BrushBar() {
  const tool = brushTool.value, flags = brushFlags.value;
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
      <button class={flags & FLIP_X ? "active" : ""} aria-pressed={!!(flags & FLIP_X)} title="Flip what is painted horizontally (X)" onClick={() => flipBrush("x")}>
        Flip X
      </button>
      <button class={flags & FLIP_Y ? "active" : ""} aria-pressed={!!(flags & FLIP_Y)} title="Flip what is painted vertically (Y)" onClick={() => flipBrush("y")}>
        Flip Y
      </button>
      <button class={flags & FLIP_DIAGONAL ? "active" : ""} aria-pressed={!!(flags & FLIP_DIAGONAL)} title="Rotate what is painted a quarter turn (Z)" onClick={() => flipBrush("rotate")}>
        Rotate
      </button>
    </div>
  );
}

/**
 * The tiles in id order. Click picks one; dragging (or Shift-dragging) picks the block of tiles it covers as a
 * stamp; Ctrl/⌘-click adds or removes tiles from a set for the random brush.
 */
function TileGridView(props: { tiles: readonly TileDef[]; project: NonNullable<typeof currentProject.value> }) {
  const [columns, setColumns] = useState(8);
  const anchor = useRef<number | null>(null);
  const dragged = useRef(false);
  const tiles = [...props.tiles].sort((a, b) => a.id - b.id);
  const ids = tiles.map((t) => t.id);
  const stamp = brushStamp.value;
  const chosen = new Set(brushTerrain.value ? [] : stamp.values.filter((v) => v !== 0).map(tileIdOf));

  const indexAt = (e: PointerEvent): number | null => {
    const el = document.elementFromPoint(e.clientX, e.clientY)?.closest<HTMLElement>("[data-index]");
    return el ? Number(el.dataset.index) : null;
  };
  const choose = (a: number, b: number) => {
    brushStamp.value = blockStamp(ids, columns, a, b);
    brushTerrain.value = null;
    brushRandom.value = false;
    if (!brushTool.peek() || brushTool.peek() === "erase" || brushTool.peek() === "pick") pickBrushTool("pencil");
  };

  return (
    <>
      <label class="tile-columns">
        Columns
        <input type="number" min={MIN_COLUMNS} max={MAX_COLUMNS} step={1} aria-label="Columns" value={columns} onChange={(e) => {
          const v = Math.round(Number((e.currentTarget as HTMLInputElement).value));
          if (Number.isFinite(v)) setColumns(Math.min(MAX_COLUMNS, Math.max(MIN_COLUMNS, v)));
        }} />
      </label>
      {tiles.length === 0 && <p class="hint">The tileset has no tiles. Select it in the Assets panel to add some.</p>}
      <div class="tile-grid" role="listbox" aria-label="Tiles" aria-multiselectable="true" style={{ gridTemplateColumns: `repeat(${columns}, max-content)` }}>
        {tiles.map((t, i) => (
          <button
            key={t.id}
            data-index={i}
            class={`tile-grid-cell${chosen.has(t.id) ? " selected" : ""}`}
            role="option"
            aria-selected={chosen.has(t.id)}
            title={`${t.name ?? "Tile"} (${t.id})`}
            onPointerDown={(e) => {
              if (e.button !== 0) return;
              if (e.ctrlKey || e.metaKey) {
                e.preventDefault();
                const now = new Set(chosen);
                if (now.has(t.id)) now.delete(t.id);
                else now.add(t.id);
                if (now.size === 0) return;
                const picked = [...now];
                brushStamp.value = { width: picked.length, height: 1, values: picked };
                brushTerrain.value = null;
                brushRandom.value = true;
                if (!brushTool.peek() || brushTool.peek() === "erase" || brushTool.peek() === "pick") pickBrushTool("pencil");
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
              if (anchor.current !== null && !dragged.current) {
                brushTile(t.id);
                brushRandom.value = false;
              }
              dragged.current = false;
            }}
          >
            <TileThumb project={props.project} tile={t} size={32} />
          </button>
        ))}
      </div>
    </>
  );
}

import { signal } from "@preact/signals";
import { useEffect, useState } from "preact/hooks";
import type { GameObject } from "../../engine";
import type { World } from "../../engine/core/World";
import { engineWorld } from "../../engine/editor";
import { createLiveNode, createLiveSibling, deleteLive, moveLive, renameLive, whyNotDeleteLive, whyNotMoveLive } from "../liveEdits";
import type { PlaySession } from "../playMode";
import { highlightLive, inspectWorld, inspectedWorld, liveRows, liveSelection } from "../runtimeInspect";
import { playing } from "../session";
import { playState, status } from "../state";
import { HierarchyMenu, hierarchyMenu } from "./HierarchyMenu";
import "./playdebug.css";

/** The live tree refreshes this often (not every frame). */
const REFRESH_MS = 300;

/** Collapsed live nodes, by entity. */
const collapsed = signal<ReadonlySet<number>>(new Set());

/** The live node being renamed in place, by entity. */
const renaming = signal<number | null>(null);

/** The live node being dragged (to reparent), and the row it would drop on (entity; -1: the header, the top level). */
let dragged: GameObject | null = null;
const dropOn = signal<number | null>(null);

/** Re-render every `ms` while mounted and `on`. */
function useTick(ms: number, on = true): number {
  const [tick, setTick] = useState(0);
  useEffect(() => {
    if (!on) return;
    const t = setInterval(() => setTick((n) => n + 1), ms);
    return () => clearInterval(t);
  }, [ms, on]);
  return tick;
}

// --- live edits (ADR 0124): the running game only, no undo ------------------------------------------

/** Run a live edit: report a refusal, redraw while paused. */
function liveEdit(session: PlaySession, what: string, run: () => string | null): void {
  const reason = run();
  if (reason) status.value = { kind: "error", text: `Can't ${what}: ${reason}.` };
  if (session.paused) session.redraw();
}

/** Select a live node (or none) and outline it. */
function chooseLive(session: PlaySession, worldName: string, node: GameObject | null): void {
  liveSelection.value = node;
  highlightLive(session.engine, worldName, node);
  if (session.paused) session.redraw();
}

/** Make an empty node (under `parent`, or right after `beside`), select it and start renaming it. */
function createAndSelect(session: PlaySession, worldName: string, world: World, at: { parent: GameObject | null } | { beside: GameObject }): void {
  const node = "beside" in at ? createLiveSibling(at.beside) : createLiveNode(world, at.parent);
  chooseLive(session, worldName, node);
  renaming.value = node.entity;
}

function deleteNode(session: PlaySession, worldName: string, node: GameObject): void {
  const name = node.name;
  liveEdit(session, `delete ${name}`, () => deleteLive(node));
  if (node.isValid) return;
  if (!liveSelection.peek()?.isValid) chooseLive(session, worldName, null);
  status.value = { kind: "info", text: `Deleted ${name} from the running game (World ${worldName}); the scene is unchanged.` };
}

const SEPARATOR = { label: "", separator: true };

/** The live Hierarchy's right-click menu for `node` (null: empty space). */
function liveMenuItems(session: PlaySession, worldName: string, world: World, node: GameObject | null) {
  const create = { label: "Create Empty", run: () => createAndSelect(session, worldName, world, node ? { beside: node } : { parent: null }) };
  if (!node) return [create];
  return [
    create,
    { label: "Create Empty Child", run: () => createAndSelect(session, worldName, world, { parent: node }) },
    SEPARATOR,
    { label: "Rename", shortcut: "F2", run: () => (renaming.value = node.entity) },
    { label: "Move to Top Level", disabled: whyNotMoveLive(node, null) ?? (node.parent === world.activeScene || node.parent === world.root ? "it's already at the top level" : null), run: () => liveEdit(session, `move ${node.name}`, () => moveLive(node, null)) },
    { label: "Delete", shortcut: "Del", disabled: whyNotDeleteLive(node), run: () => deleteNode(session, worldName, node) },
  ];
}

/** Rename a live node in place: Enter or blur commits, Escape cancels. */
function LiveRename(props: { node: GameObject }) {
  let done = false;
  const finish = (value: string | null) => {
    if (done) return;
    done = true;
    renaming.value = null;
    if (value !== null && props.node.isValid) renameLive(props.node, value);
  };
  return (
    <input
      class="rename-input"
      aria-label="Node name"
      ref={(input) => {
        // Not a controlled value: the tree re-renders every 300 ms, which would reset the typing.
        if (input && input.ownerDocument.activeElement !== input) {
          input.value = props.node.name;
          input.focus();
          input.select();
        }
      }}
      onClick={(e) => e.stopPropagation()}
      onPointerDown={(e) => e.stopPropagation()}
      onKeyDown={(e) => {
        e.stopPropagation();
        if (e.key === "Enter") finish((e.currentTarget as HTMLInputElement).value);
        if (e.key === "Escape") finish(null);
      }}
      onBlur={(e) => finish((e.currentTarget as HTMLInputElement).value)}
    />
  );
}

/**
 * While playing: which World the Hierarchy and Inspector show, the edited scene or a live World
 * of the running game (Worlds created at runtime included). Nothing while editing.
 */
export function WorldPicker() {
  const session = playing.value;
  const active = playState.value === "playing" && !!session;
  useTick(500, active); // Worlds come and go at runtime
  if (!active) return null;
  const names = session!.engine.worlds().map((w) => w.name);
  const current = inspectedWorld.value;
  const value = current !== null && names.includes(current) ? current : "";
  return (
    <div class="world-picker">
      <label>
        <span class="world-picker-label">Show</span>
        <select aria-label="Inspect World" value={value} onChange={(e) => inspectWorld(e.currentTarget.value || null)}>
          <option value="">Scene (editing)</option>
          {names.map((n) => (
            <option key={n} value={n}>
              {n} (live)
            </option>
          ))}
        </select>
      </label>
    </div>
  );
}

/**
 * A live World's node tree: scene nodes, nodes made at runtime, ghosts and connections, refreshed
 * as it changes. Nodes can be created, renamed, deleted and dragged to a new parent; those edits
 * change the running game only (ADR 0124).
 */
export function RuntimeHierarchy() {
  useTick(REFRESH_MS);
  const session = playing.value;
  const name = inspectedWorld.value;
  const world = session && name ? engineWorld(session.engine, name) : null;
  const selected = liveSelection.value;
  if (!session || !name || !world) {
    return (
      <div class="runtime-hierarchy">
        <WorldPicker />
        <p class="empty">
          World {name} is gone.{" "}
          <button class="link-button" onClick={() => inspectWorld(null)}>
            Show the scene
          </button>
        </p>
      </div>
    );
  }
  const rows = liveRows(world, collapsed.value);
  const toggle = (entity: number) => {
    const next = new Set(collapsed.value);
    if (!next.delete(entity)) next.add(entity);
    collapsed.value = next;
  };
  const openMenu = (x: number, y: number, node: GameObject | null) => (hierarchyMenu.value = { x, y, items: liveMenuItems(session, name, world, node) });
  const onKeyDown = (e: KeyboardEvent) => {
    if ((e.target as HTMLElement).closest("input")) return;
    const node = liveSelection.peek();
    if (!node?.isValid) return;
    if (e.key === "Delete") deleteNode(session, name, node);
    else if (e.key === "F2") renaming.value = node.entity;
    else return;
    e.preventDefault();
    e.stopPropagation(); // not the edited scene's Delete shortcut
  };
  const dragOver = (e: DragEvent, parent: GameObject | null, key: number) => {
    if (!dragged || whyNotMoveLive(dragged, parent)) return;
    e.preventDefault(); // allows the drop
    if (dropOn.value !== key) dropOn.value = key;
  };
  const drop = (e: DragEvent, parent: GameObject | null) => {
    e.preventDefault();
    e.stopPropagation();
    const node = dragged;
    dragged = null;
    dropOn.value = null;
    if (node) liveEdit(session, `move ${node.name}`, () => moveLive(node, parent));
  };
  const leave = (key: number) => {
    if (dropOn.value === key) dropOn.value = null;
  };
  return (
    <div
      class="runtime-hierarchy"
      onContextMenu={(e) => {
        if ((e.target as HTMLElement).closest("input, select")) return;
        e.preventDefault();
        openMenu(e.clientX, e.clientY, null);
      }}
    >
      <WorldPicker />
      <div class="hierarchy-header">
        <div
          class={`scene-name live-name${dropOn.value === -1 ? " drop-into" : ""}`}
          title={`The running World "${name}": edits here change the game only. Drop a node here to move it to the top level.`}
          onDragOver={(e) => dragOver(e, null, -1)}
          onDragLeave={() => leave(-1)}
          onDrop={(e) => drop(e, null)}
        >
          {name}
          <span class="live-badge">live{session.paused ? " · paused" : ""}</span>
        </div>
        <button
          class="hierarchy-add"
          aria-label="Create live node"
          title="Create an empty node in the running game (not saved to the scene)"
          onClick={(e) => {
            const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
            const sel = liveSelection.value?.isValid && liveSelection.value.world === world ? liveSelection.value : null;
            hierarchyMenu.value = {
              x: r.left,
              y: r.bottom + 2,
              items: [
                { label: "Create Empty", run: () => createAndSelect(session, name, world, { parent: null }) },
                ...(sel ? [{ label: "Create Empty Child", run: () => createAndSelect(session, name, world, { parent: sel }) }] : []),
              ],
            };
          }}
        >
          +
        </button>
      </div>
      {rows.length === 0 && <p class="empty">This World has no nodes.</p>}
      <ul class="tree live-tree" role="tree" aria-label="Live nodes" tabIndex={0} onKeyDown={onKeyDown}>
        {rows.map((r) => {
          const isSelected = selected === r.node && r.node.isValid;
          const open = !collapsed.value.has(r.node.entity);
          const entity = r.node.entity;
          const isRenaming = renaming.value === entity;
          return (
            <li key={entity} role="treeitem" aria-selected={isSelected} aria-expanded={r.children > 0 ? open : undefined} aria-level={r.depth + 1}>
              <div
                class={`row${isSelected ? " selected" : ""}${r.inactive ? " inactive" : ""}${r.kind ? ` live-${r.kind}` : ""}${dropOn.value === entity ? " drop-into" : ""}`}
                data-entity={entity}
                data-name={r.name}
                style={{ paddingLeft: `${r.depth * 14 + 4}px` }}
                draggable={!isRenaming && !whyNotMoveLive(r.node, null)}
                onClick={() => chooseLive(session, name, r.node)}
                onDblClick={() => (renaming.value = entity)}
                onContextMenu={(e) => {
                  e.preventDefault();
                  e.stopPropagation();
                  chooseLive(session, name, r.node);
                  openMenu(e.clientX, e.clientY, r.node);
                }}
                onDragStart={(e) => {
                  dragged = r.node;
                  e.dataTransfer?.setData("text/plain", r.name);
                  if (e.dataTransfer) e.dataTransfer.effectAllowed = "move";
                }}
                onDragEnd={() => {
                  dragged = null;
                  dropOn.value = null;
                }}
                onDragOver={(e) => dragOver(e, r.node, entity)}
                onDragLeave={() => leave(entity)}
                onDrop={(e) => drop(e, r.node)}
              >
                <span
                  class={`caret${r.children > 0 ? "" : " leaf"}`}
                  onClick={(e) => {
                    e.stopPropagation();
                    if (r.children > 0) toggle(entity);
                  }}
                >
                  {r.children > 0 ? (open ? "▾" : "▸") : ""}
                </span>
                {isRenaming ? <LiveRename node={r.node} /> : <span class="name">{r.name}</span>}
                {r.badge && (
                  <span class={`badge live-kind-${r.kind}`} title={r.detail ?? undefined}>
                    {r.badge}
                  </span>
                )}
              </div>
            </li>
          );
        })}
      </ul>
      <HierarchyMenu />
    </div>
  );
}

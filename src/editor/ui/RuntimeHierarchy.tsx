import { signal } from "@preact/signals";
import { useEffect, useRef, useState } from "preact/hooks";
import type { GameObject } from "../../engine";
import type { World } from "../../engine/core/World";
import { engineWorld, listNodes } from "../../engine/editor";
import { createLiveNode, createLiveSibling, deleteLive, moveLive, renameLive, whyNotDeleteLive, whyNotMoveLive } from "../liveEdits";
import type { PlaySession } from "../playMode";
import { highlightLive, inspectWorld, inspectedWorld, liveRows, liveSelection, type LiveRow } from "../runtimeInspect";
import { startPointerDrag } from "../pointerDrag";
import { playing } from "../session";
import { playState, status } from "../state";
import { HierarchyMenu, hierarchyMenu } from "./HierarchyMenu";
import { TreeView, renameRow, type TreeRow } from "./TreeView";
import "./playdebug.css";
import { EmptyState } from "./EmptyState";

/** The live tree refreshes this often (not every frame). */
const REFRESH_MS = 300;

/** Collapsed live nodes, by entity. */
const collapsed = signal<ReadonlySet<number>>(new Set());

/** The tree name live rows are renamed under (`renameRow`, ADR 0278); their keys are entity numbers. */
const LIVE_TREE = "live";

/** A live node being dragged to a new parent (ADR 0278's one row drag): the row it would drop on (entity; -1: the header, the top level), or why it can't. */
interface LiveDrag {
  readonly node: GameObject;
  readonly x: number;
  readonly y: number;
  readonly on: number | null;
  readonly problem: string | null;
}
const liveDrag = signal<LiveDrag | null>(null);

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
function createAndSelect(session: PlaySession, worldName: string, world: World, at: { parent: GameObject | null } | { beside: GameObject }, owner: object): void {
  const node = "beside" in at ? createLiveSibling(at.beside) : createLiveNode(world, at.parent);
  chooseLive(session, worldName, node);
  renameRow(LIVE_TREE, String(node.entity), owner);
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
function liveMenuItems(session: PlaySession, worldName: string, world: World, node: GameObject | null, owner: object) {
  const create = { label: "Create Empty", run: () => createAndSelect(session, worldName, world, node ? { beside: node } : { parent: null }, owner) };
  if (!node) return [create];
  return [
    create,
    { label: "Create Empty Child", run: () => createAndSelect(session, worldName, world, { parent: node }, owner) },
    SEPARATOR,
    { label: "Rename", shortcut: "F2", run: () => renameRow(LIVE_TREE, String(node.entity), owner) },
    { label: "Move to Top Level", disabled: whyNotMoveLive(node, null) ?? (node.parent === world.activeScene || node.parent === world.root ? "it's already at the top level" : null), run: () => liveEdit(session, `move ${node.name}`, () => moveLive(node, null)) },
    { label: "Delete", shortcut: "Del", disabled: whyNotDeleteLive(node), run: () => deleteNode(session, worldName, node) },
  ];
}

/** The live node with entity `entity` in `world`, or null when it's gone. */
const nodeOfEntity = (world: World, entity: number): GameObject | null => listNodes(world).find((n) => n.depth > 0 && n.node.entity === entity)?.node ?? null;

/**
 * Press on a live row: past the threshold this drags the node; releasing over another row makes it the parent,
 * over the World's header moves it to the top level. Live edits change the running game only (ADR 0124).
 */
function startLiveDrag(e: PointerEvent, session: PlaySession, world: World, node: GameObject): void {
  startPointerDrag(e, {
    move: (m, doc) => {
      const el = doc.elementFromPoint(m.clientX, m.clientY) as HTMLElement | null;
      const header = el?.closest(".runtime-hierarchy .live-name");
      const row = el?.closest<HTMLElement>(".live-tree .row[data-entity]");
      let on: number | null = null, problem: string | null = "drop it on a node, or on the World's name for the top level";
      if (header) {
        on = -1;
        problem = whyNotMoveLive(node, null);
      } else if (row) {
        on = Number(row.dataset.entity);
        const parent = nodeOfEntity(world, on);
        problem = parent ? whyNotMoveLive(node, parent) : "that node is gone";
      }
      liveDrag.value = { node, x: m.clientX, y: m.clientY, on: problem ? null : on, problem };
    },
    end: (how) => {
      const state = liveDrag.value;
      liveDrag.value = null;
      if (how !== "drop" || !state || state.on === null) return;
      const parent = state.on === -1 ? null : nodeOfEntity(world, state.on);
      if (state.on !== -1 && !parent) return;
      liveEdit(session, `move ${node.name}`, () => moveLive(node, parent));
    },
  });
}

/**
 * While playing: which World the Hierarchy and Inspector show, a live World of the running game
 * (Worlds created at runtime included; the one playing the scene by default, ADR 0257) or the scene
 * file, read-only until Stop. Nothing while editing.
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
          <option value="">Scene file (read-only)</option>
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
  const owner = useRef({}).current; // this panel's menus (`hierarchyMenu`)
  const session = playing.value;
  const name = inspectedWorld.value;
  const world = session && name ? engineWorld(session.engine, name) : null;
  const selected = liveSelection.value;
  if (!session || !name || !world) {
    return (
      <div class="runtime-hierarchy">
        <WorldPicker />
        <EmptyState compact title={`World ${name} is gone.`} action={{ label: "Show the scene", run: () => inspectWorld(null) }} />
      </div>
    );
  }
  const openMenu = (x: number, y: number, node: GameObject | null) => (hierarchyMenu.value = { x, y, items: liveMenuItems(session, name, world, node, owner), owner });
  const drag = liveDrag.value;
  /** A live row for the tree view (ADR 0278): its edits are live edits (ADR 0124). */
  const liveRow = (r: LiveRow, children: TreeRow[]): TreeRow => {
    const node = r.node, entity = node.entity;
    return {
      key: String(entity),
      label: r.name,
      expandable: r.children > 0,
      open: !collapsed.value.has(entity),
      children,
      selected: selected === node && node.isValid,
      className: [r.inactive && "inactive", r.kind && `live-${r.kind}`, drag?.on === entity && "drop-into"].filter(Boolean).join(" "),
      attrs: { "data-entity": entity, "data-name": r.name },
      dragging: drag?.node === node,
      trailing: r.badge ? (
        <span class={`badge live-kind-${r.kind}`} title={r.detail ?? undefined}>
          {r.badge}
        </span>
      ) : undefined,
      setOpen: (open) => {
        if (collapsed.value.has(entity) !== open) return;
        const next = new Set(collapsed.value);
        if (open) next.delete(entity);
        else next.add(entity);
        collapsed.value = next;
      },
      select: () => chooseLive(session, name, node),
      menu: (x, y) => {
        chooseLive(session, name, node);
        openMenu(x, y, node);
      },
      activate: () => renameRow(LIVE_TREE, String(entity), owner),
      rename: {
        value: r.name,
        label: "Node name",
        commit: (value) => {
          if (node.isValid && value !== node.name) renameLive(node, value);
        },
      },
      remove: () => deleteNode(session, name, node),
      drag: whyNotMoveLive(node, null) ? undefined : (e) => startLiveDrag(e, session, world, node),
    };
  };
  // `liveRows` lists the showing nodes parents first with their depth; the tree view takes them nested.
  const top: TreeRow[] = [];
  const stack: { depth: number; children: TreeRow[] }[] = [{ depth: -1, children: top }];
  for (const r of liveRows(world, collapsed.value)) {
    while (stack[stack.length - 1]!.depth >= r.depth) stack.pop();
    const children: TreeRow[] = [];
    stack[stack.length - 1]!.children.push(liveRow(r, children));
    stack.push({ depth: r.depth, children });
  }
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
          class={`scene-name live-name${drag?.on === -1 ? " drop-into" : ""}`}
          title={`The running World "${name}": edits here change the game only. Drop a node here to move it to the top level.`}
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
              owner,
              x: r.left,
              y: r.bottom + 2,
              items: [
                { label: "Create Empty", run: () => createAndSelect(session, name, world, { parent: null }, owner) },
                ...(sel ? [{ label: "Create Empty Child", run: () => createAndSelect(session, name, world, { parent: sel }, owner) }] : []),
              ],
            };
          }}
        >
          +
        </button>
      </div>
      {top.length === 0 && <EmptyState compact title="This World has no nodes." />}
      <TreeView tree={LIVE_TREE} label="Live nodes" class="tree live-tree" rows={top} owner={owner} />
      {drag && (
        <div class={`asset-drag-ghost${drag.problem ? " invalid" : ""}`} style={{ left: `${drag.x + 14}px`, top: `${drag.y + 14}px` }} role="status">
          {drag.problem ? `${drag.node.name}: ${drag.problem}` : `Move ${drag.node.name} ${drag.on === -1 ? "to the top level" : `into ${nodeOfEntity(world, drag.on!)?.name ?? "it"}`}`}
        </div>
      )}
      <HierarchyMenu owner={owner} />
    </div>
  );
}

import { signal } from "@preact/signals";
import { useEffect, useLayoutEffect, useRef, useState } from "preact/hooks";
import type { LinkConfig, WorldTag } from "../../engine";
import { listSystemCatalog, type SystemCatalogEntry } from "../../engine/core/systems";
import { listTransports } from "../../engine/net/Transport";
import { liveLinks, type LiveLink } from "../../engine/editor";
import { usePanelHistory } from "../activeHistory";
import { playWorldSources } from "../netPlay";
import { playing } from "../session";
import type { ProjectSectionSession } from "../projectSection";
import type { EditorProject } from "../projects";
import { currentProject, playState, scriptsVersion } from "../state";
import { worlds } from "../worldsInstance";
import { editedWorlds, type WorldsDraft } from "../worldsSection";
import {
  PRESET_TAGS,
  addLink,
  addTemplate,
  addWorld,
  configOf,
  groupProblems,
  isSpawnableName,
  linkableNames,
  linkIds,
  lobbyLinks,
  serverRoles,
  type ServerRole,
  mentions,
  nameOf,
  remove,
  removeLink,
  rename,
  setSystem,
  spawnableName,
  systemStatus,
  tagsOf,
  transportChoices,
  updateConfig,
  updateLink,
  setLinkOption,
  linkOptionsFor,
  extraOptionKeys,
  optionText,
  parseOptionText,
  type GroupedProblems,
  type TemplateConfig,
  type TemplateEntry,
  type WorldRef,
  type WorldsModel,
  withReplicationSetting,
} from "../worldsConfig";
import { PROJECT_FILE } from "../projectPaths";
import { DEFAULT_LAYOUT, layoutGraph } from "../worldsLayout";
import { placeNodes, positionKey, readWorldsGraph, renameNode, writeWorldsGraph, type NodePositions } from "../worldsGraphPositions";
import {
  NO_PAN,
  WireRefusal,
  handleProps,
  isFieldTarget,
  px,
  startPointerDrag,
  useGraphCanvas,
  useGraphWiring,
  useNodeDrag,
  wirePath,
  type CanvasNode,
  type GraphDragHooks,
  type Point,
  type PortSide,
} from "../graph";
import { KEY_OWNER } from "../graph/keyOwner";
import "../graph/graph.css";
import "./worlds.css";
import { usePanelState } from "./panel/Panel";
import { ProjectSectionToolbar } from "./ProjectSectionToolbar";
import { NumberField, TextField } from "./settingsControls";
import { EmptyState } from "./EmptyState";

/**
 * What a Worlds panel copy edits through: the shell's Worlds section session (ADR 0151, shared by every copy) and this
 * copy's own selection (ADR 0174 view state).
 */
interface PanelState {
  readonly session: ProjectSectionSession<WorldsDraft, string>;
  select(ref: WorldRef | null): void;
}

/**
 * This copy's selected World or template. It belongs to one session: a new session (after an outside edit, or
 * another project) selects the first World again.
 */
interface Selection {
  readonly of: ProjectSectionSession<WorldsDraft, string> | null;
  readonly ref: WorldRef | null;
}

/** Make an edit: record it for undo and save it (if valid), selecting `selectRef` when given. */
function edit(s: PanelState, label: string, model: WorldsModel, selectRef?: WorldRef | null): void {
  const session = s.session;
  if (session.draft.view.kind !== "graph" || !session.project.canSave) return;
  if (selectRef !== undefined) s.select(selectRef);
  void session.edit(label, editedWorlds(model));
}

const sameJson = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

/**
 * The project's start-up Worlds, Spawnable Worlds (`templates` in project.json) and links (ADR 0032,
 * 0062) as a graph, with the live connections drawn in during play, with each one's
 * settings and system checklist below it. Edits are saved to `project.json`'s `bootstrap`
 * section when they leave it valid; Ctrl/Cmd+Z undoes them while the panel has focus.
 */
export function WorldsPanel() {
  const root = useRef<HTMLDivElement>(null);
  usePanelHistory(root, worlds.history);
  const selection = usePanelState<Selection>("worlds.selection", { of: null, ref: null });
  worlds.version.value;
  scriptsVersion.value; // scripts define systems
  const project = currentProject.value;
  if (!project) return <EmptyState compact title="No project open" />;
  const session = worlds.open(project);
  const s: PanelState = { session, select: (ref) => (selection.value = { of: session, ref }) };
  const view = session.draft.view;
  if (view.kind === "code") {
    return (
      <EmptyState compact title={`This project starts its Worlds from a code bootstrap, ${view.path}. Edit that script to change them.`} />
    );
  }
  if (view.kind === "broken") {
    return (
      <div class="worlds-panel">
        <EmptyState compact title={`${PROJECT_FILE}'s bootstrap section can't be shown as a graph. Fix it in the Code panel:`} />
        <ul class="worlds-problems">{view.problems.map((p) => <li key={p}>{p}</li>)}</ul>
      </div>
    );
  }

  const model = view.model;
  const catalog = listSystemCatalog();
  const problems = groupProblems(session.problems);
  const editable = project.canSave;
  let selected: WorldRef | null = selection.value.of === session ? selection.value.ref : { kind: "world" as const, index: 0 };
  if (selected && !configOf(model, selected)) selected = model.worlds.length ? { kind: "world", index: 0 } : null;

  return (
    <div class="worlds-panel" tabIndex={-1} ref={root}>
      <ProjectSectionToolbar
        session={session}
        noun="Worlds"
        class="worlds-toolbar"
        problemsNote="play mode won't start until they're fixed"
        saved={
          view.explicit
            ? { label: "Saved", title: "Matches project.json's bootstrap" }
            : { label: "Default bootstrap", title: "The project has no bootstrap, so it runs the default one: a single World. Your first edit writes it out." }
        }
      >
        <button disabled={!editable} title="Add a start-up World" onClick={() => edit(s, "Add World", addWorld(model), { kind: "world", index: model.worlds.length })}>
          + World
        </button>
        <button
          disabled={!editable}
          title="Add a Spawnable World: one that game code creates when it's needed, with Engine.createWorld"
          onClick={() => edit(s, "Add Spawnable World", addTemplate(model, "Spawnable"), { kind: "template", index: model.templates.length })}
        >
          + Spawnable World
        </button>
      </ProjectSectionToolbar>
      <div class="worlds-body">
        <GraphSection s={s} model={model} problems={problems} selected={selected} project={project} defaultRate={defaultTickRate(project)} />
        {problems.general.length > 0 && <Problems list={problems.general} />}
        <fieldset class="worlds-fields" disabled={!editable}>
          {selected && <Details s={s} model={model} target={selected} problems={problems} catalog={catalog} project={project} />}
          <Links s={s} model={model} problems={problems} />
        </fieldset>
      </div>
    </div>
  );
}

function defaultTickRate(project: EditorProject): number {
  return Math.round(1 / (project.settings.time?.fixedDeltaTime ?? 1 / 60));
}

function Problems(props: { list: readonly string[] }) {
  return (
    <ul class="worlds-problems" role="list" aria-label="Problems">
      {props.list.map((p, i) => (
        <li key={i}>{p}</li>
      ))}
    </ul>
  );
}

// --- graph --------------------------------------------------------------------------------------

const { nodeW: NODE_W, nodeH: NODE_H, labelH: LABEL_H, labelPadX: LABEL_PAD, charW: CHAR_W } = DEFAULT_LAYOUT;
const SPAWNABLE_HINT = "Created by game code when needed, not at start-up";
/** The space between arrows that join the same two Worlds, where they meet the nodes. */
const FAN = 10;

/**
 * The live connections between the play session's Worlds, refreshed a few times a second while
 * playing; empty otherwise. Worlds multiplayer Play made (`Client 1…N`, `Thin 1…T`) are drawn as
 * the project World they copy, so several connections can share one arrow (`count`).
 */
function useLiveLinks(): (LiveLink & { count: number })[] {
  const session = playState.value === "playing" ? playing.value : null;
  const [links, setLinks] = useState<(LiveLink & { count: number })[]>([]);
  useEffect(() => {
    if (!session) {
      setLinks([]);
      return;
    }
    const sources = session.netPlay ? playWorldSources(session.netPlay) : new Map<string, string>();
    const read = () => setLinks((old) => {
      const next = mergeLiveLinks(liveLinks(session.engine), sources);
      return sameJson(old, next) ? old : next;
    });
    read();
    const timer = setInterval(read, 250);
    return () => clearInterval(timer);
  }, [session]);
  return links;
}

/** Live links with each end mapped to the project World it stands for, one per pair (open wins over connecting over closed). */
function mergeLiveLinks(links: readonly LiveLink[], sources: ReadonlyMap<string, string>): (LiveLink & { count: number })[] {
  const rank = { open: 2, handshake: 1, closed: 0 } as Record<string, number>;
  const byPair = new Map<string, LiveLink & { count: number }>();
  for (const l of links) {
    const from = sources.get(l.from) ?? l.from, to = sources.get(l.to) ?? l.to;
    const key = `${from}>${to}`;
    const seen = byPair.get(key);
    if (!seen) byPair.set(key, { ...l, from, to, count: 1 });
    else byPair.set(key, { ...seen, state: (rank[l.state] ?? 0) > (rank[seen.state] ?? 0) ? l.state : seen.state, count: seen.count + 1 });
  }
  return [...byPair.values()];
}

/** Each project's stored node positions (ADR 0382), read once per project and shared by every panel copy. */
const positionCache = new WeakMap<EditorProject, NodePositions>();
const positionsVersion = signal(0);

/** The project's stored node positions, or null while they're being read. */
function useNodePositions(project: EditorProject): NodePositions | null {
  positionsVersion.value;
  useEffect(() => {
    if (positionCache.has(project)) return;
    void readWorldsGraph(project).then((read) => {
      if (positionCache.has(project)) return;
      positionCache.set(project, read);
      positionsVersion.value++;
    });
  }, [project]);
  return positionCache.get(project) ?? null;
}

/** Keep new node positions: for this session, and in `.myco/worlds-graph.json` when the project can be saved. */
function storeNodePositions(project: EditorProject, next: NodePositions): void {
  positionCache.set(project, next);
  positionsVersion.value++;
  if (project.canSave) void writeWorldsGraph(project, next).catch((e) => console.warn(`Couldn't save the Worlds graph layout: ${e}`));
}

/** A stored position follows a World's rename (ADR 0382). */
function renameNodePosition(project: EditorProject, kind: WorldRef["kind"], from: string, to: string): void {
  const before = positionCache.get(project);
  if (!before) return;
  const after = renameNode(before, kind, from, to);
  if (after !== before) storeNodePositions(project, after);
}

/** The graph once the project's node positions are read (an empty pane until then, so it opens framed on where they are). */
function GraphSection(props: Omit<GraphProps, "positions">) {
  const positions = useNodePositions(props.project);
  if (!positions) return <div class="sg-pane worlds-graph" aria-busy="true" />;
  return <Graph {...props} positions={positions} />;
}

interface GraphProps {
  s: PanelState;
  model: WorldsModel;
  problems: GroupedProblems;
  selected: WorldRef | null;
  project: EditorProject;
  positions: NodePositions;
  defaultRate: number;
}

/** A World or Spawnable World on the canvas. */
interface WorldNode {
  /** Its canvas id (`w0`, `t0`), which its ports are named by. */
  id: string;
  ref: WorldRef;
  /** Where its position is stored (`worldsGraphPositions.ts`). */
  key: string;
  /** The World name links use. */
  name: string;
}

/** One arrow: a link in project.json, a link the lobby makes, or a live connection. */
interface Arrow {
  key: string;
  from: string;
  to: string;
  label: string;
  cls: string;
  /** The attribute naming it by its ends (`data-link-arrow`, `data-lobby-link`, `data-live-link`). */
  attr: string;
  live: boolean;
  /** Its index in `links`, for a link in project.json (which can be picked and removed). */
  link?: number;
}

const splitRef = (ref: string) => {
  const i = ref.lastIndexOf(".");
  return { node: ref.slice(0, i), port: ref.slice(i + 1) };
};

/** The World name a port reference (`w0.out`, `t1.in`) stands for in `model`. */
function endName(model: WorldsModel, ref: string): string | undefined {
  const id = splitRef(ref).node;
  const i = Number(id.slice(1));
  if (id[0] === "w") return model.worlds[i]?.name;
  const t = model.templates[i];
  return t && spawnableName(t);
}

/** Why `from` can't link to `to` (port references), or null. */
function whyNotLink(model: WorldsModel, from: string, to: string): string | null {
  const a = endName(model, from), b = endName(model, to);
  if (a === undefined || b === undefined) return "That World is gone";
  if (a === b) return "A World can't link to itself";
  if (model.links.some((l) => l.from === a && l.to === b)) return `${a} already links to ${b}`;
  return null;
}

/**
 * Start-up and Spawnable Worlds as a node graph on the shared graph canvas (ADR 0382, over ADR 0046's
 * xyflow layer): pan with a drag on the empty canvas (or the middle or right button), zoom with the
 * wheel, F frames every World. Click a node to edit that World; drag it to move it (positions are
 * the editor's, in `.myco/worlds-graph.json`; a World never moved sits where the auto layout,
 * `worldsLayout.ts`, puts it). Drag from a World's right edge to another World to link them
 * (client → server, over loopback); click a link and press Delete to remove it. Spawnable Worlds are
 * dashed and tagged, as are links naming them (they apply when game code creates the World). While
 * playing, the live connections between the session's Worlds are drawn too.
 */
function Graph(props: GraphProps) {
  const { s, model, problems, selected, project, positions, defaultRate } = props;
  const editable = project.canSave;
  const live = useLiveLinks();
  const [dragging, setDragging] = useState<ReadonlyMap<string, Point> | null>(null);
  /** The picked link, by its identity (`linkIds`), or null: an undo or a removal doesn't move the pick onto another link. */
  const [picked, setPicked] = useState<string | null>(null);
  const ids = linkIds(model.links);
  const pickedIndex = picked === null ? -1 : ids.indexOf(picked);
  // A picked link that's gone (removed, changed, undone) is no longer picked.
  useEffect(() => {
    if (picked !== null && pickedIndex < 0) setPicked(null);
  }, [picked, pickedIndex]);
  const implied = lobbyLinks(model);
  const roles = serverRoles(model);

  const nodes: WorldNode[] = [
    ...model.worlds.map((w, i) => ({ id: `w${i}`, ref: { kind: "world", index: i } as WorldRef, key: positionKey("world", w.name), name: w.name })),
    ...model.templates.map((t, i) => ({ id: `t${i}`, ref: { kind: "template", index: i } as WorldRef, key: positionKey("template", t.key), name: spawnableName(t) })),
  ];
  const auto = layoutGraph(
    nodes.map((n) => ({ key: n.id, name: n.name, spawnable: n.ref.kind === "template" })),
    [...model.links.map((l) => ({ from: l.from, to: l.to, label: l.transport })), ...implied.map((l) => ({ from: l.from, to: l.to, label: l.label }))],
  );
  const places: Point[] = nodes.map((n, i) => {
    const moving = dragging?.get(n.id);
    if (moving) return moving;
    const stored = positions.get(n.key);
    return stored ? { x: stored[0], y: stored[1] } : { x: auto.nodes[i].x, y: auto.nodes[i].y };
  });
  const isSelected = (ref: WorldRef) => selected?.kind === ref.kind && selected.index === ref.index;
  const canvasNodes: CanvasNode[] = nodes.map((n, i) => ({
    id: n.id,
    x: places[i].x,
    y: places[i].y,
    width: NODE_W,
    height: NODE_H,
    selected: isSelected(n.ref),
    inputs: [{ id: "in", x: 0, y: NODE_H / 2 }],
    outputs: [{ id: "out", x: NODE_W, y: NODE_H / 2 }],
  }));
  const latest = useRef({ model, nodes, canvasNodes, positions });
  latest.current = { model, nodes, canvasNodes, positions };
  const linkLabel = useRef("Link Worlds");

  const canvas = useGraphCanvas({ viewKey: `worlds:${project.root ?? project.name}`, nodes: canvasNodes, onContextMenu: () => undefined });
  const wiring = useGraphWiring<WorldsModel>({
    flowPrefix: "wg",
    edits: {
      sourceOf: () => null, // a World takes any number of links
      whyNot: whyNotLink,
      connect: (g, from, to) => {
        if (whyNotLink(g, from, to)) return g;
        const a = endName(g, from)!, b = endName(g, to)!;
        linkLabel.current = `Link ${a} to ${b}`;
        return addLink(g, { from: a, to: b, transport: "loopback" });
      },
      disconnect: (g) => g,
      split: splitRef,
    },
    graph: () => latest.current.model,
    commit: (next) => {
      if (next === latest.current.model) return;
      pinAll(new Map());
      edit(s, linkLabel.current, next);
    },
    readOnly: !editable,
    root: canvas.pane,
    canvas: () => canvas,
    nodes: () => latest.current.canvasNodes,
    onDropInSpace: () => undefined,
  });
  /**
   * Store every World where it's drawn now, `moved` ones where they were dragged to: once the user arranges
   * the graph (or draws a link), the auto layout no longer moves the Worlds it placed.
   */
  const pinAll = (moved: ReadonlyMap<string, Point>) => {
    const now = latest.current;
    const at = now.nodes.map((n, i) => [n.key, moved.get(n.id) ?? now.canvasNodes[i]] as const);
    storeNodePositions(project, placeNodes(now.positions, at.map(([key, p]) => [key, [p.x, p.y]] as const), now.nodes.map((n) => n.key)));
  };
  // A pane hidden when the graph opened (a background tab) is framed when it's first shown.
  const hiddenAtOpen = useRef(false);
  useLayoutEffect(() => {
    hiddenAtOpen.current = (canvas.pane.current?.clientWidth ?? 0) === 0;
  }, []);
  useEffect(() => {
    if (!hiddenAtOpen.current || (canvas.pane.current?.clientWidth ?? 0) === 0) return;
    hiddenAtOpen.current = false;
    canvas.frameAll();
  }, [canvas.paneSize]);
  // Moving a World changes only the editor's layout, so a read-only project can be arranged too (it isn't written).
  const drag: GraphDragHooks = {
    pane: () => canvas.pane.current!,
    nodes: () => latest.current.canvasNodes,
    view: () => canvas.viewRef.current,
    panBy: canvas.panBy,
    onMove: (m) => setDragging(new Map(m)),
    onEnd: (m) => {
      setDragging(null);
      if (m.size) pinAll(m);
    },
  };

  const byName = new Map<string, number>();
  nodes.forEach((n, i) => byName.has(n.name) || byName.set(n.name, i));
  const liveLabel = (l: LiveLink & { count: number }) =>
    (l.state === "open" ? "connected" : l.state === "handshake" ? "connecting…" : "closed") + (l.count > 1 ? ` ×${l.count}` : "");
  const arrows: Arrow[] = [
    ...model.links.map((l, i): Arrow => {
      const spawnable = isSpawnableName(model, l.from) || isSpawnableName(model, l.to);
      return { key: `l:${ids[i]}`, from: l.from, to: l.to, label: l.transport, cls: `worlds-link${spawnable ? " spawnable" : ""}${problems.links.has(i) ? " invalid" : ""}${pickedIndex === i ? " selected" : ""}`, attr: "data-link-arrow", live: false, link: i };
    }),
    ...implied.map((l): Arrow => ({ key: `lobby:${l.from}>${l.to}`, from: l.from, to: l.to, label: l.label, cls: "worlds-link spawnable implied", attr: "data-lobby-link", live: false })),
    ...live.map((l): Arrow => ({ key: `live:${l.from}>${l.to}`, from: l.from, to: l.to, label: liveLabel(l), cls: `worlds-link live ${l.state}`, attr: "data-live-link", live: true })),
  ];
  // Arrows joining the same two Worlds fan out side by side.
  const ends = arrows.map((a) => {
    const i = byName.get(a.from), j = byName.get(a.to);
    return i === undefined || j === undefined || i === j ? null : { i, j };
  });
  const perPair = new Map<string, number>();
  for (const e of ends) if (e) perPair.set(`${e.i}>${e.j}`, (perPair.get(`${e.i}>${e.j}`) ?? 0) + 1);
  const seen = new Map<string, number>();
  const drawn = arrows.map((a, k) => {
    const e = ends[k];
    if (!e) return null;
    const pair = `${e.i}>${e.j}`;
    const nth = seen.get(pair) ?? 0;
    seen.set(pair, nth + 1);
    const off = (nth - (perPair.get(pair)! - 1) / 2) * FAN;
    const from = { x: places[e.i].x + NODE_W, y: places[e.i].y + NODE_H / 2 + off };
    const to = { x: places[e.j].x - 1, y: places[e.j].y + NODE_H / 2 + off };
    const w = a.label.length * CHAR_W + LABEL_PAD * 2;
    const mid = { x: (from.x + to.x) / 2, y: (from.y + to.y) / 2 };
    return { ...a, ends: `${a.from}>${a.to}`, d: wirePath(from, to), pill: { x: mid.x - w / 2, y: mid.y - LABEL_H / 2, w, h: LABEL_H } };
  });

  const arrowId = `${wiring.flowId}-arrow`, liveArrowId = `${wiring.flowId}-arrow-live`;
  const focusPane = () => canvas.pane.current?.focus({ preventScroll: true });
  const pick = (e: PointerEvent, link: number) => {
    if (e.button !== 0) return;
    e.stopPropagation();
    focusPane();
    setPicked(ids[link] ?? null);
  };
  const removePicked = (): boolean => {
    const l = pickedIndex < 0 ? undefined : model.links[pickedIndex];
    if (!l || !editable) return false;
    setPicked(null);
    edit(s, `Remove link ${l.from} → ${l.to}`, removeLink(model, pickedIndex));
    return true;
  };
  const panFrom = (e: PointerEvent) => {
    const v0 = canvas.viewRef.current;
    startPointerDrag(e, {
      zoom: () => 1,
      onMove: (dx, dy) => {
        const v = { x: v0.x + dx, y: v0.y + dy, zoom: v0.zoom };
        canvas.paneApi.current?.setView(v);
        canvas.setView(v);
      },
      onEnd: () => undefined,
    });
  };

  return (
    <>
      <div
        class="sg-pane worlds-graph"
        ref={canvas.pane}
        tabIndex={-1}
        aria-label="Worlds graph"
        {...{ [KEY_OWNER]: "" }}
        onPointerMove={canvas.onPointerMove}
        onContextMenu={(e) => e.preventDefault()}
        onPointerDown={(e) => {
          if (e.button !== 0 || (e.target as Element).closest(".worlds-node, .worlds-link-hit, .worlds-link-label.pickable, .worlds-graph-tools")) return;
          focusPane();
          setPicked(null);
          panFrom(e as unknown as PointerEvent);
        }}
        onKeyDown={(e) => {
          if (isFieldTarget(e.target) || e.ctrlKey || e.metaKey || e.altKey) return;
          const key = (e.key ?? "").toLowerCase();
          let handled = true;
          if (key === "delete" || key === "backspace") handled = removePicked();
          else if (key === "f") canvas.frameAll();
          else if (key === "escape" && pickedIndex >= 0) setPicked(null);
          else handled = false;
          if (handled) {
            e.preventDefault();
            e.stopPropagation();
          }
        }}
      >
        <div class="sg-viewport" style={{ transform: `translate(${canvas.view.x}px, ${canvas.view.y}px) scale(${canvas.view.zoom})` }}>
          <svg class="sg-wires worlds-links" aria-hidden="true">
            <defs>
              <marker id={arrowId} viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
                <path d="M0,0 L10,5 L0,10 z" class="worlds-arrowhead" />
              </marker>
              <marker id={liveArrowId} viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
                <path d="M0,0 L10,5 L0,10 z" class="worlds-arrowhead live" />
              </marker>
            </defs>
            {/* Arrows first, then every label, so a pill never hides under another link's arrow. */}
            {drawn.map((r) => r && (
              <g key={r.key} class={r.cls} {...{ [r.attr]: r.ends }}>
                <path class="worlds-link-line" d={r.d} marker-end={`url(#${r.live ? liveArrowId : arrowId})`} />
                {r.link !== undefined && (
                  <path class="worlds-link-hit" d={r.d} onPointerDown={(e) => pick(e as unknown as PointerEvent, r.link!)}>
                    <title>{`${r.ends.replace(">", " → ")} over ${r.label}: click, then Delete removes it`}</title>
                  </path>
                )}
              </g>
            ))}
            {drawn.map((r) => {
              if (!r) return null;
              const { x, y, w, h } = r.pill;
              const pickable = r.link !== undefined;
              return (
                <g
                  key={`${r.key}:label`}
                  class={`${r.cls} worlds-link-label${pickable ? " pickable" : ""}`}
                  data-label-for={r.ends}
                  onPointerDown={pickable ? (e) => pick(e as unknown as PointerEvent, r.link!) : undefined}
                >
                  <rect x={x} y={y} width={w} height={h} rx={h / 2} />
                  <text x={x + w / 2} y={y + h / 2} text-anchor="middle" dominant-baseline="central">
                    {r.label}
                  </text>
                </g>
              );
            })}
            {wiring.draft && <path class={`sg-draft${wiring.draft.valid ? " valid" : ""}`} d={wirePath(wiring.draft.from, wiring.draft.to)} />}
          </svg>
          {nodes.map((n, i) => {
            const common = {
              id: n.id,
              at: places[i],
              role: n.ref.kind === "world" ? roles.worlds[n.ref.index] : roles.templates[n.ref.index],
              selected: isSelected(n.ref),
              editable,
              flowId: wiring.flowId,
              drag,
              onPortDown: wiring.onPortDown,
              onSelect: () => {
                setPicked(null);
                s.select(n.ref);
              },
            };
            if (n.ref.kind === "world") {
              const w = model.worlds[n.ref.index];
              const renders = w.renders ?? n.ref.index === 0;
              return (
                <GraphNode
                  key={n.id}
                  {...common}
                  name={w.name}
                  tags={tagsOf(w)}
                  rate={w.tickRate ?? defaultRate}
                  badges={[renders ? "renders" : null, w.input ?? renders ? "input" : null]}
                  invalid={problems.worlds.has(n.ref.index)}
                />
              );
            }
            const t = model.templates[n.ref.index];
            return (
              <GraphNode
                key={n.id}
                {...common}
                template
                name={t.key}
                tags={tagsOf(t.config)}
                rate={t.config.tickRate ?? defaultRate}
                badges={[t.config.renders ? "renders" : null, t.config.input ?? t.config.renders ? "input" : null]}
                invalid={problems.templates.has(t.key)}
              />
            );
          })}
          <WireRefusal draft={wiring.draft} hint={wiring.hint} />
        </div>
        <div class={`worlds-graph-tools ${NO_PAN}`}>
          <button title="Fit every World in the view (F)" onClick={() => canvas.frameAll()}>
            Frame all
          </button>
        </div>
      </div>
      <div class="worlds-legend">
        <span class="worlds-legend-item">
          <span class="worlds-legend-swatch" aria-hidden="true" /> start-up
        </span>
        <span class="worlds-legend-item" title={SPAWNABLE_HINT}>
          <span class="worlds-legend-swatch spawnable" aria-hidden="true" /> spawnable <span class="worlds-hint">created by game code when needed</span>
        </span>
        {implied.length > 0 && (
          <span class="worlds-legend-item" title="Connections the lobby makes while the game runs (ADR 0068), from its matchTemplate and clientTemplate; they aren't links in project.json.">
            <span class="worlds-legend-line implied" aria-hidden="true" /> lobby <span class="worlds-hint">connected by the lobby at runtime</span>
          </span>
        )}
        {editable && <span class="worlds-legend-item worlds-hint">Drag from a World's right edge to another World to link them</span>}
      </div>
    </>
  );
}

function GraphNode(props: {
  id: string;
  at: Point;
  name: string;
  tags: readonly WorldTag[];
  rate: number;
  badges: (string | null)[];
  /** Its network role from the bootstrap topology (ADR 0256), if any. */
  role?: ServerRole | null;
  template?: boolean;
  selected: boolean;
  invalid: boolean;
  /** Whether it shows ports to draw links from and to. */
  editable: boolean;
  flowId: string;
  drag: GraphDragHooks;
  onPortDown(e: MouseEvent, node: string, port: string, side: PortSide): void;
  onSelect: () => void;
}) {
  const { id, at, name, tags, rate, badges, role, template, selected, invalid, editable, flowId, onPortDown, onSelect } = props;
  const el = useRef<HTMLDivElement>(null);
  useNodeDrag(el, id, false, props.drag);
  const out = handleProps(flowId, id, "out", "output");
  const inp = handleProps(flowId, id, "in", "input");
  return (
    <div
      ref={el}
      class={`worlds-node${template ? " template" : ""}${selected ? " selected" : ""}${invalid ? " invalid" : ""}`}
      style={{ left: px(at.x), top: px(at.y), width: px(NODE_W), height: px(NODE_H) }}
      role="button"
      tabIndex={0}
      aria-pressed={selected}
      data-world={template ? undefined : name}
      data-template={template ? name : undefined}
      title={`${template ? "Spawnable World" : "Start-up World"} ${name}: click to edit, drag to move`}
      onPointerDown={(e) => {
        if (e.button !== 0) return;
        el.current?.focus({ preventScroll: true });
        onSelect();
      }}
      onClick={onSelect}
      onKeyDown={(e) => (e.key === "Enter" || e.key === " ") && (e.preventDefault(), e.stopPropagation(), onSelect())}
    >
      {editable && <span {...inp} class={`${inp.class} worlds-port in`} title="Drop a link here: this World is its server" onMouseDown={(e) => onPortDown(e, id, "in", "input")} />}
      <div class="worlds-node-head">
        <span class="worlds-node-name">{name || "(unnamed)"}</span>
        <span class="worlds-node-rate">{rate} Hz</span>
      </div>
      <div class="worlds-chips">
        {tags.length === 0 && <span class="worlds-none">no tags</span>}
        {tags.map((t) => (
          <span key={t} class="worlds-chip">
            {t}
          </span>
        ))}
      </div>
      <div class="worlds-badges">
        {template && (
          <span class="worlds-node-tag" title={SPAWNABLE_HINT}>
            spawnable
          </span>
        )}
        {role && (
          <span class="worlds-node-role" title={role.title}>
            {role.label}
          </span>
        )}
        <span>{badges.filter(Boolean).join(" · ")}</span>
      </div>
      {editable && <span {...out} class={`${out.class} worlds-port out`} title="Drag to another World to link them: this World connects to it as a client" onMouseDown={(e) => onPortDown(e, id, "out", "output")} />}
    </div>
  );
}

// --- details ------------------------------------------------------------------------------------

/** The selected World's or template's settings and system checklist. */
function Details(props: { s: PanelState; model: WorldsModel; target: WorldRef; problems: GroupedProblems; catalog: readonly SystemCatalogEntry[]; project: EditorProject }) {
  const { s, model, target, problems, catalog, project } = props;
  const config = configOf(model, target)!;
  const name = nameOf(model, target);
  const kind = target.kind === "world" ? "World" : "Spawnable World";
  const own = target.kind === "world" ? problems.worlds.get(target.index) : problems.templates.get(name);
  const set = (label: string, patch: Partial<Omit<TemplateConfig, "name">>) => edit(s, `${label} (${name})`, updateConfig(model, target, patch));
  const tags = tagsOf(config);
  const setTags = (next: readonly WorldTag[], label: string) => set(label, { tags: next });
  const scenes = config.scenes ?? [];
  const sceneFiles = project.files.filter((f) => f.endsWith(".scene.json") && !scenes.includes(f));
  const isFirst = target.kind === "world" && target.index === 0;

  return (
    <section class="worlds-details" aria-label={`${kind} ${name}`}>
      <div class="worlds-details-head">
        <span class="worlds-kind">{target.kind === "world" ? "World" : "Spawnable World"}</span>
        <TextField value={name} label={`${kind} name`} class="worlds-name" onCommit={(v) => {
          if (!project.canSave) return;
          renameNodePosition(project, target.kind, name, v);
          edit(s, `Rename ${name} to ${v}`, rename(model, target, v));
        }} />
        <button
          title={`Remove this ${kind}${target.kind === "world" ? " and its links" : ""}`}
          disabled={target.kind === "world" && model.worlds.length === 1}
          onClick={() => edit(s, `Remove ${name}`, remove(model, target), model.worlds.length > 0 ? { kind: "world", index: 0 } : null)}
        >
          Remove
        </button>
      </div>
      {own && <Problems list={own} />}
      {target.kind === "template" && <SpawnInfo template={model.templates[target.index]} project={project} />}
      <div class="worlds-form">
        <label>Tags</label>
        <div class="worlds-tags">
          {tags.map((t) => (
            <span key={t} class="worlds-chip">
              {t}
              <button class="worlds-chip-x" title={`Remove the tag ${t}`} aria-label={`Remove tag ${t}`} onClick={() => setTags(tags.filter((x) => x !== t), `Remove tag ${t}`)}>
                ×
              </button>
            </span>
          ))}
          {PRESET_TAGS.filter((t) => !tags.includes(t)).map((t) => (
            <button key={t} class="worlds-chip add" title={`Add the tag ${t}`} aria-label={`Add tag ${t}`} onClick={() => setTags([...tags, t], `Add tag ${t}`)}>
              + {t}
            </button>
          ))}
          <TextField
            value=""
            label="New tag"
            placeholder="tag…"
            class="worlds-tag-input"
            onCommit={(v) => {
              const tag = v.trim();
              if (tag && !tags.includes(tag)) setTags([...tags, tag], `Add tag ${tag}`);
            }}
          />
        </div>

        <label for="worlds-tick">Tick rate</label>
        <NumberField
          id="worlds-tick"
          value={config.tickRate}
          placeholder={`${defaultTickRate(project)} (project)`}
          suffix="Hz"
          label="Tick rate"
          onCommit={(v) => set("Set tick rate", { tickRate: v })}
        />

        {tags.includes("server") && (
          <>
            <label for="worlds-send-rate">Snapshot rate</label>
            <NumberField
              id="worlds-send-rate"
              value={config.replication?.sendRate}
              placeholder="tick rate"
              suffix="/s"
              label="Snapshot rate"
              onCommit={(v) => set("Set snapshot rate", { replication: withReplicationSetting(config.replication, "sendRate", v) })}
            />
            <label for="worlds-snapshot-bytes">Snapshot budget</label>
            <NumberField
              id="worlds-snapshot-bytes"
              value={config.replication?.maxSnapshotBytes}
              placeholder="65536"
              suffix="bytes"
              label="Snapshot budget"
              onCommit={(v) => set("Set snapshot budget", { replication: withReplicationSetting(config.replication, "maxSnapshotBytes", v) })}
            />
          </>
        )}

        <label for="worlds-scale">Time scale</label>
        <NumberField id="worlds-scale" value={config.timeScale} placeholder="1" label="Time scale" onCommit={(v) => set("Set time scale", { timeScale: v })} />

        <label for="worlds-renders">Renders</label>
        <TriState
          id="worlds-renders"
          value={config.renders}
          defaultLabel={target.kind === "world" ? `default (${isFirst ? "yes: the first World" : "no"})` : "default (no)"}
          onChange={(v) => set("Set renders", { renders: v })}
        />

        <label for="worlds-input">Input</label>
        <TriState id="worlds-input" value={config.input} defaultLabel="default (same as renders)" onChange={(v) => set("Set input", { input: v })} />

        <label>Scenes</label>
        <div class="worlds-scenes">
          {scenes.length === 0 && <span class="worlds-none">none at start</span>}
          {scenes.map((path, i) => (
            <div key={path} class="worlds-scene">
              <span title={i === 0 ? "Loaded first, replacing" : "Loaded additively"}>{path}</span>
              <button class="worlds-chip-x" aria-label={`Remove scene ${path}`} onClick={() => set(`Remove scene ${path}`, { scenes: scenes.length > 1 ? scenes.filter((p) => p !== path) : undefined })}>
                ×
              </button>
            </div>
          ))}
          {sceneFiles.length > 0 && (
            <select
              aria-label="Add a scene"
              value=""
              onChange={(e) => {
                const path = (e.currentTarget as HTMLSelectElement).value;
                if (path) set(`Add scene ${path}`, { scenes: [...scenes, path] });
              }}
            >
              <option value="">Add a scene…</option>
              {sceneFiles.map((f) => (
                <option key={f} value={f}>
                  {f}
                </option>
              ))}
            </select>
          )}
        </div>
      </div>
      <Systems s={s} model={model} target={target} catalog={catalog} name={name} />
    </section>
  );
}

/**
 * A Spawnable World's "how to use it": the line of code that creates it (with a copy button) and
 * the project scripts that mention it by name.
 */
function SpawnInfo(props: { template: TemplateEntry; project: EditorProject }) {
  const { template, project } = props;
  // createWorld takes the template's key; scripts may use the key or the World name it gives.
  const code = `Engine.createWorld(${JSON.stringify(template.key)})`;
  const scripts = [...project.scripts].map(([path, text]) => ({ path, text }));
  const found = mentions(scripts, [template.key, spawnableName(template)]);
  const [copied, setCopied] = useState(false);
  const copy = () => {
    void navigator.clipboard?.writeText(code).then(
      () => {
        setCopied(true);
        setTimeout(() => setCopied(false), 1200);
      },
      () => {},
    );
  };
  return (
    <div class="worlds-spawn" aria-label="How to create it">
      <p class="worlds-spawn-hint">Created by game code when it's needed, not at start-up:</p>
      <div class="worlds-spawn-code">
        <code>{code}</code>
        <button title="Copy this line" aria-label="Copy the code" onClick={copy}>
          {copied ? "Copied" : "Copy"}
        </button>
      </div>
      <p class="worlds-spawn-hint">
        Mentioned in:{" "}
        {found.length === 0 ? (
          <span class="worlds-none">no project script yet</span>
        ) : (
          found.map((path, i) => (
            <span key={path}>
              {i > 0 && ", "}
              <code>{path}</code>
            </span>
          ))
        )}
      </p>
    </div>
  );
}

/** Every catalog system, checked if the World runs it, with the reason. */
function Systems(props: { s: PanelState; model: WorldsModel; target: WorldRef; catalog: readonly SystemCatalogEntry[]; name: string }) {
  const { s, model, target, catalog, name } = props;
  const config = configOf(model, target)!;
  const groups: [string, SystemCatalogEntry[]][] = [
    ["Engine", catalog.filter((e) => e.builtin)],
    ["Scripts", catalog.filter((e) => !e.builtin)],
  ];
  return (
    <div class="worlds-systems" role="group" aria-label="Systems">
      {groups.map(([title, entries]) => (
        <div key={title} class="worlds-system-group">
          <h4>{title}</h4>
          {entries.length === 0 && <p class="worlds-none">{title === "Scripts" ? "No systems defined by the project's scripts" : "None"}</p>}
          {entries.map((entry) => {
            const st = systemStatus(config, entry);
            return (
              <label key={entry.name} class={`worlds-system${st.runs ? " on" : ""}`} data-system={entry.name} title={`${entry.name} (${entry.phase}); for Worlds tagged ${entry.worlds.join(", ")}`}>
                <input
                  type="checkbox"
                  checked={st.runs}
                  onChange={(e) => {
                    const on = (e.currentTarget as HTMLInputElement).checked;
                    edit(s, `${on ? "Run" : "Stop"} ${entry.name} in ${name}`, setSystem(model, target, entry, on));
                  }}
                />
                <span class="worlds-system-name">{entry.name}</span>
                <span class="worlds-system-reason">{st.reason}</span>
              </label>
            );
          })}
        </div>
      ))}
    </div>
  );
}

// --- links --------------------------------------------------------------------------------------

function Links(props: { s: PanelState; model: WorldsModel; problems: GroupedProblems }) {
  const { s, model, problems } = props;
  const names = linkableNames(model);
  const transports = transportChoices(listTransports(), model.links.map((l) => l.transport));
  const describe = (l: LinkConfig) => `${l.from} → ${l.to}`;
  const ids = linkIds(model.links);
  const add = () => {
    const from = names[0] ?? "";
    const to = names.find((n) => n !== from) ?? from;
    edit(s, `Link ${from} to ${to}`, addLink(model, { from, to, transport: "loopback" }));
  };
  return (
    <section class="worlds-links-list" aria-label="Links">
      <h4>
        Links <span class="worlds-hint">client → server</span>
      </h4>
      {model.links.length === 0 && <p class="worlds-none">No links at start-up. Worlds can also connect while the game runs, from scripts (world.connect(…)).</p>}
      {model.links.map((l, i) => (
        // Keyed by the link, not its place, so a row's open Options and half-typed option follow it when a link before it goes.
        <div key={ids[i]} class="worlds-link-row" data-link={i}>
          <div class="worlds-link-edit">
            <Picker label={`Link ${i + 1} from`} value={l.from} options={names} onChange={(from) => edit(s, `Link ${from} to ${l.to}`, updateLink(model, i, { from }))} />
            <span>→</span>
            <Picker label={`Link ${i + 1} to`} value={l.to} options={names} onChange={(to) => edit(s, `Link ${l.from} to ${to}`, updateLink(model, i, { to }))} />
            <span>over</span>
            <Picker label={`Link ${i + 1} transport`} value={l.transport} options={transports} onChange={(transport) => edit(s, `Set ${describe(l)} transport`, updateLink(model, i, { transport }))} />
            <button class="worlds-chip-x" aria-label={`Remove link ${i + 1}`} title="Remove this link" onClick={() => edit(s, `Remove link ${describe(l)}`, removeLink(model, i))}>
              ×
            </button>
          </div>
          {(isSpawnableName(model, l.from) || isSpawnableName(model, l.to)) && (
            <p class="worlds-none">Applies when game code creates {[l.from, l.to].filter((n) => isSpawnableName(model, n)).join(" or ")}.</p>
          )}
          <LinkOptions s={s} model={model} index={i} />
          {problems.links.has(i) && <Problems list={problems.links.get(i)!} />}
        </div>
      ))}
      <button title="Link two Worlds: the first connects to the second as its server, once both exist" onClick={add}>
        + Link
      </button>
    </section>
  );
}

/** A link's `options`: one input per known option of its transport, plus any other keys it holds, collapsed by default. */
function LinkOptions(props: { s: PanelState; model: WorldsModel; index: number }) {
  const { s, model, index } = props;
  const l = model.links[index];
  const count = Object.keys(l.options ?? {}).length;
  const where = `${l.from} → ${l.to}`;
  const set = (key: string, value: unknown) => edit(s, `Set ${where} ${key}`, setLinkOption(model, index, key, value));
  const [newKey, setNewKey] = useState("");
  const [newValue, setNewValue] = useState("");
  const addOption = () => {
    const key = newKey.trim();
    const value = parseOptionText(newValue);
    if (key === "" || value === undefined) return;
    set(key, value);
    setNewKey("");
    setNewValue("");
  };
  return (
    <details class="worlds-link-options" data-link-options={index}>
      <summary>Options{count > 0 ? ` (${count})` : ""}</summary>
      <div class="worlds-option-grid">
        {linkOptionsFor(l.transport).map((o) => {
          const v = l.options?.[o.key];
          const id = `link-${index}-${o.key}`;
          return (
            <div key={o.key} class="worlds-option" title={o.hint}>
              <label for={id}>{o.label}</label>
              {o.kind === "number" && (v === undefined || typeof v === "number") ? (
                <NumberField id={id} value={v as number | undefined} placeholder={o.default !== undefined ? String(o.default) : "off"} label={`Link ${index + 1} ${o.key}`} onCommit={(n) => set(o.key, n)} />
              ) : (
                <TextField label={`Link ${index + 1} ${o.key}`} value={v === undefined ? "" : optionText(v)} placeholder={o.kind === "string" ? "" : "number"} onCommit={(t) => set(o.key, o.kind === "string" ? t : parseOptionText(t))} />
              )}
            </div>
          );
        })}
        {extraOptionKeys(l).map((k) => (
          <div key={k} class="worlds-option extra">
            <span class="worlds-option-key">{k}</span>
            <TextField label={`Link ${index + 1} option ${k}`} value={optionText(l.options![k])} onCommit={(t) => set(k, parseOptionText(t))} />
            <button class="worlds-chip-x" aria-label={`Remove option ${k}`} title="Remove this option" onClick={() => set(k, undefined)}>
              ×
            </button>
          </div>
        ))}
        <div class="worlds-option add">
          <input type="text" aria-label={`Link ${index + 1} new option name`} placeholder="option name" value={newKey} onInput={(e) => setNewKey((e.currentTarget as HTMLInputElement).value)} />
          <input
            type="text"
            aria-label={`Link ${index + 1} new option value`}
            placeholder="value (JSON or text)"
            value={newValue}
            onInput={(e) => setNewValue((e.currentTarget as HTMLInputElement).value)}
            onKeyDown={(e) => e.key === "Enter" && addOption()}
          />
          <button title="Add an option this panel has no field for" disabled={newKey.trim() === "" || newValue.trim() === ""} onClick={addOption}>
            Add option
          </button>
        </div>
      </div>
    </details>
  );
}

// --- fields -------------------------------------------------------------------------------------

function Picker(props: { label: string; value: string; options: readonly string[]; onChange: (v: string) => void }) {
  const options = props.options.includes(props.value) ? props.options : [props.value, ...props.options];
  return (
    <select aria-label={props.label} value={props.value} onChange={(e) => props.onChange((e.currentTarget as HTMLSelectElement).value)}>
      {options.map((o) => (
        <option key={o} value={o}>
          {o}
        </option>
      ))}
    </select>
  );
}

function TriState(props: { id: string; value: boolean | undefined; defaultLabel: string; onChange: (v: boolean | undefined) => void }) {
  const value = props.value === undefined ? "" : props.value ? "yes" : "no";
  return (
    <select id={props.id} value={value} onChange={(e) => {
      const v = (e.currentTarget as HTMLSelectElement).value;
      props.onChange(v === "" ? undefined : v === "yes");
    }}>
      <option value="">{props.defaultLabel}</option>
      <option value="yes">yes</option>
      <option value="no">no</option>
    </select>
  );
}


import { signal } from "@preact/signals";
import { useEffect, useLayoutEffect, useRef, useState } from "preact/hooks";
import type { LinkConfig, WorldTag } from "../../engine";
import { listSystemCatalog, type SystemCatalogEntry } from "../../engine/core/systems";
import { listTransports } from "../../engine/net/Transport";
import { liveLinks, type LiveLink } from "../../engine/editor";
import { usePanelHistory, type UndoHistory } from "../activeHistory";
import { playWorldSources } from "../netPlay";
import { playing } from "../session";
import { errorStatus } from "../messages";
import type { EditorProject } from "../projects";
import { currentProject, playState, scriptsVersion, status } from "../state";
import {
  EditHistory,
  PRESET_TAGS,
  addLink,
  addTemplate,
  addWorld,
  configOf,
  groupProblems,
  isSpawnableName,
  linkableNames,
  lobbyLinks,
  mentions,
  modelProblems,
  modelToConfig,
  nameOf,
  readBootstrap,
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
  withBootstrap,
  type BootstrapView,
  type GroupedProblems,
  type TemplateConfig,
  type TemplateEntry,
  type WorldRef,
  type WorldsModel,
  withReplicationSetting,
} from "../worldsConfig";
import { PROJECT_FILE, queueProjectFileWrite } from "../projectFile";
import { DEFAULT_LAYOUT, layoutGraph, type LayoutLinkIn, type LayoutNodeIn } from "../worldsLayout";
import "./worlds.css";
import { NumberField, TextField } from "./settingsControls";

/** An undoable panel state: the model, and whether it's written out (false: the project has no bootstrap and runs the default one). */
interface Draft {
  model: WorldsModel;
  explicit: boolean;
}

/** The panel's state for the open project. Kept outside the component, since a hidden tab unmounts. */
interface PanelState {
  project: EditorProject;
  /** `project.json`'s text when the panel last read or wrote it; another change to it (the Code panel) starts over. */
  fileText: string | undefined;
  /** The text a save in progress is writing: until it's done, the project may already hold it. */
  writingText?: string;
  view: BootstrapView;
  history: EditHistory<Draft> | null;
  selected: WorldRef | null;
  saving: boolean;
  error: string | null;
}

let state: PanelState | null = null;
/** Bumped when the panel's state changes, so it re-renders. */
const version = signal(0);

/** The state for `project`, read again from `project.json` if that changed since the panel last saw it. */
function stateFor(project: EditorProject): PanelState {
  const text = project.textOf(PROJECT_FILE);
  if (state && state.project === project && (state.fileText === text || (state.writingText !== undefined && state.writingText === text))) return state;
  // Another key changed (the Project panel's save): keep the draft and its undo history.
  if (state && state.project === project && state.writingText === undefined && sameJson(bootstrapIn(state.fileText), project.settings.bootstrap)) {
    state.fileText = text;
    return state;
  }
  const view = readBootstrap(project.settings.bootstrap);
  const history = view.kind === "graph" ? new EditHistory<Draft>({ model: view.model, explicit: view.explicit }) : null;
  state = { project, fileText: text, view, history, selected: view.kind === "graph" ? { kind: "world", index: 0 } : null, saving: false, error: null };
  return state;
}

const sameJson = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

/** The bootstrap in a `project.json` text (undefined if it has none or doesn't parse). */
function bootstrapIn(text: string | undefined): unknown {
  try {
    return text === undefined ? undefined : (JSON.parse(text) as { bootstrap?: unknown }).bootstrap;
  } catch {
    return undefined;
  }
}

/** The bootstrap a draft writes: undefined while it's still the implicit default. */
const settingOf = (draft: Draft) => (draft.explicit ? modelToConfig(draft.model) : undefined);

/**
 * Write the current draft to `project.json` if it's valid and differs from the file. Invalid
 * drafts stay in the panel, unsaved (play mode would refuse them), until an edit or undo fixes
 * them. Writes run one at a time and always write the latest draft.
 */
function persist(s: PanelState): void {
  void queueProjectFileWrite(async () => {
    if (state !== s || !s.history || !s.project.canSave) return;
    const draft = s.history.current;
    if (modelProblems(draft.model, listSystemCatalog()).length > 0) return;
    const setting = settingOf(draft);
    if (sameJson(setting, s.project.settings.bootstrap)) return;
    const text = withBootstrap(s.project.textOf(PROJECT_FILE) ?? "{}\n", setting);
    s.saving = true;
    version.value++;
    s.writingText = text; // a render mid-save sees either text, and mustn't take its own save for an outside change
    try {
      await s.project.writeText(PROJECT_FILE, text);
      s.fileText = text;
      s.error = null;
    } catch (err) {
      s.error = errorStatus(`Couldn't save the Worlds to ${PROJECT_FILE}`, err).text;
      status.value = errorStatus(`Couldn't save the Worlds to ${PROJECT_FILE}`, err);
    } finally {
      s.writingText = undefined;
      s.saving = false;
      version.value++;
    }
  });
}

/** Make an edit: record it for undo and save it (if valid). */
function edit(s: PanelState, label: string, model: WorldsModel, select?: WorldRef | null): void {
  if (!s.history || !s.project.canSave) return;
  s.history.push(label, { model, explicit: true });
  if (select !== undefined) s.selected = select;
  version.value++;
  persist(s);
}

function undo(s: PanelState): void {
  if (s.history?.undo()) afterJump(s);
}

function redo(s: PanelState): void {
  if (s.history?.redo()) afterJump(s);
}

function afterJump(s: PanelState): void {
  version.value++;
  persist(s);
}

/** The panel's undo list, the active history while the panel has the focus (ADR 0145): Ctrl+Z and Edit > Undo step it. */
const worldsHistory: UndoHistory = {
  name: "Worlds",
  get canUndo() {
    return (version.value, !!state?.project.canSave && !!state.history?.canUndo);
  },
  get canRedo() {
    return (version.value, !!state?.project.canSave && !!state.history?.canRedo);
  },
  get undoLabel() {
    return (version.value, state?.history?.undoLabel ?? null);
  },
  get redoLabel() {
    return (version.value, state?.history?.redoLabel ?? null);
  },
  undo: () => state && undo(state),
  redo: () => state && redo(state),
};

/**
 * The project's start-up Worlds, Spawnable Worlds (`templates` in project.json) and links (ADR 0032,
 * 0062) as a graph, with the live connections drawn in during play, with each one's
 * settings and system checklist below it. Edits are saved to `project.json`'s `bootstrap`
 * section when they leave it valid; Ctrl/Cmd+Z undoes them while the panel has focus.
 */
export function WorldsPanel() {
  const root = useRef<HTMLDivElement>(null);
  usePanelHistory(root, worldsHistory);
  version.value;
  scriptsVersion.value; // scripts define systems
  const project = currentProject.value;
  if (!project) return <p class="empty">No project open</p>;
  const s = stateFor(project);
  if (s.view.kind === "code") {
    return (
      <p class="empty">
        This project starts its Worlds from a code bootstrap, <code>{s.view.path}</code>. Edit that script to change them.
      </p>
    );
  }
  if (s.view.kind === "broken" || !s.history) {
    return (
      <div class="worlds-panel">
        <p class="empty">{PROJECT_FILE}'s bootstrap section can't be shown as a graph. Fix it in the Code panel:</p>
        <ul class="worlds-problems">{s.view.kind === "broken" && s.view.problems.map((p) => <li key={p}>{p}</li>)}</ul>
      </div>
    );
  }

  const history = s.history;
  const draft = history.current;
  const model = draft.model;
  const catalog = listSystemCatalog();
  const all = modelProblems(model, catalog);
  const problems = groupProblems(all);
  const editable = project.canSave;
  const unsaved = !sameJson(settingOf(draft), project.settings.bootstrap);
  let selected = s.selected;
  if (selected && !configOf(model, selected)) selected = model.worlds.length ? { kind: "world", index: 0 } : null;

  return (
    <div class="worlds-panel" tabIndex={-1} ref={root}>
      <div class="worlds-toolbar">
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
        <button disabled={!editable || !history.undoLabel} title={history.undoLabel ? `Undo ${history.undoLabel} (Ctrl+Z)` : "Nothing to undo"} onClick={() => undo(s)}>
          Undo
        </button>
        <button disabled={!editable || !history.redoLabel} title={history.redoLabel ? `Redo ${history.redoLabel} (Ctrl+Shift+Z)` : "Nothing to redo"} onClick={() => redo(s)}>
          Redo
        </button>
        <SaveMarker editable={editable} saving={s.saving} error={s.error} problems={all.length} unsaved={unsaved} explicit={draft.explicit} />
      </div>
      <div class="worlds-body">
        <Graph model={model} problems={problems} selected={selected} onSelect={(ref) => ((s.selected = ref), version.value++)} defaultRate={defaultTickRate(project)} />
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

function SaveMarker(props: { editable: boolean; saving: boolean; error: string | null; problems: number; unsaved: boolean; explicit: boolean }) {
  const { editable, saving, error, problems, unsaved, explicit } = props;
  if (!editable) return <span class="worlds-status readonly" title="This project is read-only. Open a project folder to edit its Worlds.">Read-only</span>;
  const plural = problems === 1 ? "" : "s";
  if (problems > 0 && unsaved) {
    return (
      <span class="worlds-status unsaved" title={`project.json keeps the last valid Worlds. Fix the problem${plural} to save, or undo.`}>
        ● Not saved: {problems} problem{plural}
      </span>
    );
  }
  if (problems > 0) {
    return (
      <span class="worlds-status unsaved" title={`project.json's bootstrap has ${problems} problem${plural}; play mode won't start until they're fixed.`}>
        {problems} problem{plural} in project.json
      </span>
    );
  }
  if (saving) return <span class="worlds-status">Saving…</span>;
  if (error) return <span class="worlds-status unsaved" title={error}>● Not saved</span>;
  if (unsaved) return <span class="worlds-status">Saving…</span>;
  return (
    <span class="worlds-status saved" title={explicit ? "Matches project.json's bootstrap" : "The project has no bootstrap, so it runs the default one: a single World. Your first edit writes it out."}>
      {explicit ? "Saved" : "Default bootstrap"}
    </span>
  );
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

const { nodeW: NODE_W, nodeH: NODE_H } = DEFAULT_LAYOUT;
const SPAWNABLE_HINT = "Created by game code when needed, not at start-up";

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

/**
 * Start-up and Spawnable Worlds as one graph (worldsLayout.ts): columns by link depth, clients left
 * of their servers, arrows routed between the nodes with a label pill each. Spawnable Worlds are
 * dashed and tagged, as are links naming them (they apply when game code creates the World).
 * While playing, the live connections between the session's Worlds are drawn too.
 */
function Graph(props: { model: WorldsModel; problems: GroupedProblems; selected: WorldRef | null; onSelect: (ref: WorldRef) => void; defaultRate: number }) {
  const { model, problems, selected, onSelect, defaultRate } = props;
  const live = useLiveLinks();
  const nodes: LayoutNodeIn[] = [
    ...model.worlds.map((w, i) => ({ key: `w${i}`, name: w.name, spawnable: false })),
    ...model.templates.map((t, i) => ({ key: `t${i}`, name: spawnableName(t), spawnable: true })),
  ];
  const liveLabel = (l: LiveLink & { count: number }) =>
    (l.state === "open" ? "connected" : l.state === "handshake" ? "connecting…" : "closed") + (l.count > 1 ? ` ×${l.count}` : "");
  const implied = lobbyLinks(model);
  const links: LayoutLinkIn[] = [
    ...model.links.map((l) => ({ from: l.from, to: l.to, label: l.transport })),
    ...implied.map((l) => ({ from: l.from, to: l.to, label: l.label })),
    ...live.map((l) => ({ from: l.from, to: l.to, label: liveLabel(l) })),
  ];
  const layout = layoutGraph(nodes, links);
  const routes = layout.links.map((route, i) => {
    if (!route) return null;
    if (i < model.links.length) {
      const l = model.links[i];
      const spawnable = isSpawnableName(model, l.from) || isSpawnableName(model, l.to);
      return { route, label: l.transport, key: `l${i}`, cls: `worlds-link${spawnable ? " spawnable" : ""}${problems.links.has(i) ? " invalid" : ""}`, data: { "data-link-arrow": `${l.from}>${l.to}` }, marker: "worlds-arrow" };
    }
    if (i < model.links.length + implied.length) {
      const l = implied[i - model.links.length];
      return { route, label: l.label, key: `lobby:${l.from}>${l.to}`, cls: "worlds-link spawnable implied", data: { "data-lobby-link": `${l.from}>${l.to}` }, marker: "worlds-arrow" };
    }
    const l = live[i - model.links.length - implied.length];
    return { route, label: links[i].label, key: `live:${l.from}>${l.to}`, cls: `worlds-link live ${l.state}`, data: { "data-live-link": `${l.from}>${l.to}` }, marker: "worlds-arrow-live" };
  });
  const isSelected = (ref: WorldRef) => selected?.kind === ref.kind && selected.index === ref.index;
  const node = (key: string) => layout.nodes.find((p) => p.key === key)!;

  return (
    <>
      <div class="worlds-graph">
        <div class="worlds-canvas" style={{ width: `${layout.width}px`, height: `${layout.height}px` }}>
          <svg class="worlds-links" width={layout.width} height={layout.height} aria-hidden="true">
            <defs>
              <marker id="worlds-arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
                <path d="M0,0 L10,5 L0,10 z" class="worlds-arrowhead" />
              </marker>
              <marker id="worlds-arrow-live" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
                <path d="M0,0 L10,5 L0,10 z" class="worlds-arrowhead live" />
              </marker>
            </defs>
            {/* Arrows first, then every label, so a pill never hides under another link's arrow. */}
            {routes.map((r) => r && (
              <g key={r.key} class={r.cls} {...r.data}>
                <path d={r.route.d} marker-end={`url(#${r.marker})`} />
              </g>
            ))}
            {routes.map((r) => {
              if (!r) return null;
              const { x, y, w, h } = r.route.label;
              return (
                <g key={`${r.key}:label`} class={`${r.cls} worlds-link-label`} data-label-for={Object.values(r.data)[0]}>
                  <rect x={x} y={y} width={w} height={h} rx={h / 2} />
                  <text x={x + w / 2} y={y + h / 2} text-anchor="middle" dominant-baseline="central">
                    {r.label}
                  </text>
                </g>
              );
            })}
          </svg>
          {model.worlds.map((w, i) => {
            const ref: WorldRef = { kind: "world", index: i };
            const renders = w.renders ?? i === 0;
            const at = node(`w${i}`);
            return (
              <GraphNode
                key={`w${i}`}
                x={at.x}
                y={at.y}
                name={w.name}
                tags={tagsOf(w)}
                rate={w.tickRate ?? defaultRate}
                badges={[renders ? "renders" : null, w.input ?? renders ? "input" : null]}
                selected={isSelected(ref)}
                invalid={problems.worlds.has(i)}
                onSelect={() => onSelect(ref)}
              />
            );
          })}
          {model.templates.map((t, i) => {
            const ref: WorldRef = { kind: "template", index: i };
            const at = node(`t${i}`);
            return (
              <GraphNode
                key={`t${i}`}
                template
                x={at.x}
                y={at.y}
                name={t.key}
                tags={tagsOf(t.config)}
                rate={t.config.tickRate ?? defaultRate}
                badges={[t.config.renders ? "renders" : null, t.config.input ?? t.config.renders ? "input" : null]}
                selected={isSelected(ref)}
                invalid={problems.templates.has(t.key)}
                onSelect={() => onSelect(ref)}
              />
            );
          })}
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
      </div>
    </>
  );
}

function GraphNode(props: {
  x: number;
  y: number;
  name: string;
  tags: readonly WorldTag[];
  rate: number;
  badges: (string | null)[];
  template?: boolean;
  selected: boolean;
  invalid: boolean;
  onSelect: () => void;
}) {
  const { x, y, name, tags, rate, badges, template, selected, invalid, onSelect } = props;
  return (
    <div
      class={`worlds-node${template ? " template" : ""}${selected ? " selected" : ""}${invalid ? " invalid" : ""}`}
      style={{ left: `${x}px`, top: `${y}px`, width: `${NODE_W}px`, height: `${NODE_H}px` }}
      role="button"
      tabIndex={0}
      aria-pressed={selected}
      data-world={template ? undefined : name}
      data-template={template ? name : undefined}
      title={`${template ? "Spawnable World" : "Start-up World"} ${name}: click to edit`}
      onClick={onSelect}
      onKeyDown={(e) => (e.key === "Enter" || e.key === " ") && (e.preventDefault(), onSelect())}
    >
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
        <span>{badges.filter(Boolean).join(" · ")}</span>
      </div>
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
        <TextField value={name} label={`${kind} name`} class="worlds-name" onCommit={(v) => edit(s, `Rename ${name} to ${v}`, rename(model, target, v))} />
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
        <div key={i} class="worlds-link-row" data-link={i}>
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


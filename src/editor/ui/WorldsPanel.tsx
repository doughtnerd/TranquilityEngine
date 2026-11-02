import { signal } from "@preact/signals";
import { useEffect, useState } from "preact/hooks";
import type { LinkConfig, WorldTag } from "../../engine";
import { listSystemCatalog, type SystemCatalogEntry } from "../../engine/core/systems";
import { listTransports } from "../../engine/net/Transport";
import { errorStatus } from "../messages";
import type { EditorProject } from "../projects";
import { currentProject, scriptsVersion, status } from "../state";
import {
  EditHistory,
  PRESET_TAGS,
  addLink,
  addTemplate,
  addWorld,
  configOf,
  groupProblems,
  layoutWorlds,
  modelProblems,
  modelToConfig,
  nameOf,
  readBootstrap,
  remove,
  removeLink,
  rename,
  setSystem,
  systemStatus,
  tagsOf,
  transportChoices,
  updateConfig,
  updateLink,
  withBootstrap,
  type BootstrapView,
  type GroupedProblems,
  type TemplateConfig,
  type WorldRef,
  type WorldsModel,
} from "../worldsConfig";
import "./worlds.css";

const PROJECT_FILE = "project.json";

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
let writing: Promise<void> = Promise.resolve();

/** The state for `project`, read again from `project.json` if that changed since the panel last saw it. */
function stateFor(project: EditorProject): PanelState {
  const text = project.textOf(PROJECT_FILE);
  if (state && state.project === project && (state.fileText === text || (state.writingText !== undefined && state.writingText === text))) return state;
  const view = readBootstrap(project.settings.bootstrap);
  const history = view.kind === "graph" ? new EditHistory<Draft>({ model: view.model, explicit: view.explicit }) : null;
  state = { project, fileText: text, view, history, selected: view.kind === "graph" ? { kind: "world", index: 0 } : null, saving: false, error: null };
  return state;
}

const sameJson = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

/** The bootstrap a draft writes: undefined while it's still the implicit default. */
const settingOf = (draft: Draft) => (draft.explicit ? modelToConfig(draft.model) : undefined);

/**
 * Write the current draft to `project.json` if it's valid and differs from the file. Invalid
 * drafts stay in the panel, unsaved (play mode would refuse them), until an edit or undo fixes
 * them. Writes run one at a time and always write the latest draft.
 */
function persist(s: PanelState): void {
  writing = writing.then(async () => {
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

const isTextField = (el: EventTarget | null) =>
  el instanceof HTMLTextAreaElement || (el instanceof HTMLInputElement && !["checkbox", "radio", "button"].includes(el.type));

/**
 * The project's start-up Worlds, templates and links (ADR 0032) as a graph, with each one's
 * settings and system checklist below it. Edits are saved to `project.json`'s `bootstrap`
 * section when they leave it valid; Ctrl/Cmd+Z undoes them while the panel has focus.
 */
export function WorldsPanel() {
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

  const onKeyDown = (e: KeyboardEvent) => {
    if (!(e.ctrlKey || e.metaKey) || e.altKey || isTextField(e.target)) return;
    const key = e.key.toLowerCase();
    if (key !== "z" && key !== "y") return;
    e.preventDefault();
    e.stopPropagation(); // not the scene's undo
    if (key === "y" || e.shiftKey) redo(s);
    else undo(s);
  };

  return (
    <div class="worlds-panel" tabIndex={-1} onKeyDown={onKeyDown}>
      <div class="worlds-toolbar">
        <button disabled={!editable} title="Add a start-up World" onClick={() => edit(s, "Add World", addWorld(model), { kind: "world", index: model.worlds.length })}>
          + World
        </button>
        <button
          disabled={!editable}
          title="Add a template: a World config that game code creates later with Engine.createWorld"
          onClick={() => edit(s, "Add template", addTemplate(model), { kind: "template", index: model.templates.length })}
        >
          + Template
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

// Two columns (a client and its server) fit the default panel width.
const NODE_W = 118;
const NODE_H = 62;
const GAP_X = 44;
const GAP_Y = 12;
const PAD = 8;
const LABEL_H = 20;

/** Start-up Worlds as nodes, columns ordered client → server, with link arrows; templates in a row below, dashed. */
function Graph(props: { model: WorldsModel; problems: GroupedProblems; selected: WorldRef | null; onSelect: (ref: WorldRef) => void; defaultRate: number }) {
  const { model, problems, selected, onSelect, defaultRate } = props;
  const places = layoutWorlds(model);
  const cols = Math.max(1, ...places.map((p) => p.col + 1));
  const rows = Math.max(1, ...places.map((p) => p.row + 1));
  const pos = places.map((p) => ({ x: PAD + p.col * (NODE_W + GAP_X), y: PAD + LABEL_H + p.row * (NODE_H + GAP_Y) }));
  const templatesY = PAD + LABEL_H + rows * (NODE_H + GAP_Y) + LABEL_H;
  const width = PAD * 2 + Math.max(cols * (NODE_W + GAP_X) - GAP_X, model.templates.length * (NODE_W + GAP_Y) - GAP_Y);
  const height = model.templates.length ? templatesY + NODE_H + PAD : templatesY - LABEL_H + PAD;
  const index = new Map<string, number>();
  model.worlds.forEach((w, i) => index.has(w.name) || index.set(w.name, i));
  const isSelected = (ref: WorldRef) => selected?.kind === ref.kind && selected.index === ref.index;

  return (
    <div class="worlds-graph" style={{ height: `${height}px` }}>
      <div class="worlds-row-label" style={{ top: `${PAD}px` }}>
        Start-up Worlds
      </div>
      <svg class="worlds-links" width={width} height={height} aria-hidden="true">
        <defs>
          <marker id="worlds-arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
            <path d="M0,0 L10,5 L0,10 z" class="worlds-arrowhead" />
          </marker>
        </defs>
        {model.links.map((l, i) => {
          const a = index.get(l.from), b = index.get(l.to);
          if (a === undefined || b === undefined || a === b) return null;
          const x1 = pos[a].x + NODE_W, y1 = pos[a].y + NODE_H / 2;
          const x2 = pos[b].x, y2 = pos[b].y + NODE_H / 2;
          const bend = Math.max(40, Math.abs(x2 - x1) / 2);
          const d = `M${x1},${y1} C${x1 + bend},${y1} ${x2 - bend},${y2} ${x2 - 2},${y2}`;
          return (
            <g key={i} class={`worlds-link${problems.links.has(i) ? " invalid" : ""}`}>
              <path d={d} marker-end="url(#worlds-arrow)" />
              <text x={(x1 + x2) / 2} y={(y1 + y2) / 2 - 5} text-anchor="middle">
                {l.transport}
              </text>
            </g>
          );
        })}
      </svg>
      {model.worlds.map((w, i) => {
        const ref: WorldRef = { kind: "world", index: i };
        const renders = w.renders ?? i === 0;
        return (
          <GraphNode
            key={`w${i}`}
            x={pos[i].x}
            y={pos[i].y}
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
      {model.templates.length > 0 && (
        <div class="worlds-row-label" style={{ top: `${templatesY - LABEL_H}px` }}>
          Templates
        </div>
      )}
      {model.templates.map((t, i) => {
        const ref: WorldRef = { kind: "template", index: i };
        return (
          <GraphNode
            key={`t${i}`}
            template
            x={PAD + i * (NODE_W + GAP_Y)}
            y={templatesY}
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
      title={`${template ? "Template" : "World"} ${name}: click to edit`}
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
      <div class="worlds-badges">{badges.filter(Boolean).join(" · ")}</div>
    </div>
  );
}

// --- details ------------------------------------------------------------------------------------

/** The selected World's or template's settings and system checklist. */
function Details(props: { s: PanelState; model: WorldsModel; target: WorldRef; problems: GroupedProblems; catalog: readonly SystemCatalogEntry[]; project: EditorProject }) {
  const { s, model, target, problems, catalog, project } = props;
  const config = configOf(model, target)!;
  const name = nameOf(model, target);
  const kind = target.kind === "world" ? "World" : "template";
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
        <span class="worlds-kind">{target.kind === "world" ? "World" : "Template"}</span>
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
  const names = [...new Set(model.worlds.map((w) => w.name))];
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
      {model.links.length === 0 && <p class="worlds-none">No links: the Worlds don't talk to each other.</p>}
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
          {problems.links.has(i) && <Problems list={problems.links.get(i)!} />}
        </div>
      ))}
      <button title="Link two Worlds: the first connects to the second as its server" onClick={add}>
        + Link
      </button>
    </section>
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

/** Text that commits on Enter or blur and reverts on Escape (an empty value field clears itself after committing). */
function TextField(props: { value: string; label: string; class?: string; placeholder?: string; onCommit: (v: string) => void }) {
  const [draft, setDraft] = useState(props.value);
  useEffect(() => setDraft(props.value), [props.value]);
  const commit = () => {
    if (draft !== props.value) props.onCommit(draft);
    if (props.value === "") setDraft("");
  };
  return (
    <input
      type="text"
      class={props.class}
      aria-label={props.label}
      placeholder={props.placeholder}
      value={draft}
      onInput={(e) => setDraft((e.currentTarget as HTMLInputElement).value)}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === "Enter") {
          if (props.value === "") commit(); // keep focus to type the next one
          else (e.currentTarget as HTMLInputElement).blur();
        }
        if (e.key === "Escape") {
          setDraft(props.value);
          (e.currentTarget as HTMLInputElement).blur();
        }
      }}
    />
  );
}

/** An optional number: empty means the default (shown as the placeholder); text that isn't a number reverts. */
function NumberField(props: { id: string; value: number | undefined; placeholder: string; label: string; suffix?: string; onCommit: (v: number | undefined) => void }) {
  const shown = props.value === undefined ? "" : String(props.value);
  const [draft, setDraft] = useState(shown);
  useEffect(() => setDraft(shown), [shown]);
  const commit = () => {
    const text = draft.trim();
    if (text === shown) return;
    if (text === "") return props.onCommit(undefined);
    const n = Number(text);
    if (Number.isFinite(n)) props.onCommit(n);
    else setDraft(shown);
  };
  return (
    <span class="worlds-number">
      <input
        id={props.id}
        type="text"
        inputMode="decimal"
        aria-label={props.label}
        placeholder={props.placeholder}
        value={draft}
        onInput={(e) => setDraft((e.currentTarget as HTMLInputElement).value)}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === "Enter") (e.currentTarget as HTMLInputElement).blur();
          if (e.key === "Escape") {
            setDraft(shown);
            (e.currentTarget as HTMLInputElement).blur();
          }
        }}
      />
      {props.suffix && <span class="worlds-hint">{props.suffix}</span>}
    </span>
  );
}

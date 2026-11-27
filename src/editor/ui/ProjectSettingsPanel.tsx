import type { ComponentChildren } from "preact";
import { Panel } from "./panel/Panel";
import { useEffect, useRef, useState } from "preact/hooks";
import { useDraftText } from "./draftText";
import { ANTIALIAS_MODES, LIGHTS_2D_QUALITIES, PLATFORMS, PARTICLE_QUALITIES, PROBE_QUALITIES, SHADER_LEVELS, SHADOW_QUALITIES } from "../../engine/core/graphics";
import { defaultSettings, INPUT_JOIN_POLICIES } from "../../engine/core/settings";
import { inputActionSets } from "../../engine/editor";
import { allPluginManifests } from "../../plugins/thirdPartyEditor";
import { RENAMED_PLUGINS } from "../../plugins/enabled";
import { usePanelHistory } from "../activeHistory";
import { actionSetRow, codeActionSets, unlistedActionSets } from "../actionSetList";
import { createAsset } from "../assetKindHost";
import { projectSettingsCategory } from "../preferences";
import { projectSettingsSections, type ProjectSettingsSectionContribution, type ProjectSettingsSectionProps } from "../sdk/contributions";
import type { ProjectSectionSession } from "../projectSection";
import { projectSettings } from "../projectSettingsInstance";
import {
  actionSetsOf,
  addActionSet,
  addAutoload,
  addSortingLayer,
  addTier,
  autoloadsOf,
  graphicsOf,
  moveActionSetTo,
  moveAutoload,
  moveSortingLayer,
  moveTier,
  removeActionSet,
  removeAutoload,
  removeSortingLayer,
  removeTier,
  renameSortingLayer,
  renameTier,
  setAutoDetect,
  setDefaultTier,
  setPlatformDefault,
  setTargetFrameRate,
  setName,
  setTierValue,
  settingsWarnings,
  setValue,
  sortingLayersOf,
  type SettingsDraft,
  type SettingsProblem,
  type TierValueKey,
} from "../projectSettingsModel";
import type { EditorProject } from "../projects";
import { currentProject, docVersion } from "../state";
import { SortableList } from "./SortableList";
import { PluginsSection } from "./PluginsSection";
import { ProjectSectionToolbar } from "./ProjectSectionToolbar";
import { lazyComponent, type LazyComponent } from "./lazy";
import { NumberField, TextField } from "./settingsControls";
import { NameList, ProblemList, Row } from "./settingsControls";
import "./projectSettings.css";

/** The panel's state for the open project: its project section's session (ADR 0151), kept outside the component. */
type PanelState = ProjectSectionSession<SettingsDraft, SettingsProblem>;

/**
 * The `project.json` keys the built-in categories and the registered sections own: the draft,
 * its undo, saving and outside changes (ADR 0151). The shell's one instance, shared with `editor.project.settings`
 * (ADR 0173). Saves reload the editor's graphics tiers and re-apply plugins turned on or off.
 */
const settings = projectSettings;

function edit(s: PanelState, label: string, draft: SettingsDraft): void {
  void s.edit(label, draft);
}

/**
 * The Project panel (ADR 0038): `project.json`'s settings other than the Worlds (name, display,
 * time, physics layers and collisions, sorting layers, autoloads). Valid edits save as they're
 * made; problems are listed and keep the file at its last valid settings. Ctrl/Cmd+Z undoes.
 */
export function ProjectSettingsPanel() {
  const root = useRef<HTMLDivElement>(null);
  usePanelHistory(root, settings.history);
  settings.version.value;
  void projectSettingsSections.version.value; // a plugin's category (de)registered, with the keys it owns
  docVersion.value; // files added (autoload choices)
  const project = currentProject.value;
  if (!project) return <Panel><p class="empty">No project open</p></Panel>;
  const s = settings.open(project);
  const draft = s.draft;
  const editable = project.canSave;
  const problems = s.problems;
  const warnings = settingsWarnings(draft, [...allPluginManifests().map((m) => m.name), ...Object.keys(RENAMED_PLUGINS)]); // old names still work (ADR 0137)
  const problemsAt = (field: string) => problems.filter((p) => p.field === field || p.field.startsWith(`${field}.`));
  const set = (label: string, next: SettingsDraft) => edit(s, label, next);

  const display = draft.display ?? {};
  const time = draft.time ?? {};
  const render = draft.render ?? {};
  const folder = project.root?.split(/[\\/]/).filter(Boolean).pop() ?? project.name;

  return (
    <Panel>
      <div class="project-settings" tabIndex={-1} ref={root}>
        <ProjectSectionToolbar session={s} noun="settings" class="project-settings-toolbar" />
        <CategoryLayout counts={categoryProblems(problems)}>
          {problems.length > 0 && <ProblemList list={problems.map((p) => p.message)} label="Problems" />}
          {warnings.length > 0 && <ProblemList list={warnings} label="Warnings" warning />}
          <fieldset class="project-settings-fields" disabled={!editable}>
            <Section title="Project">
              <Row label="Name" problems={problemsAt("name")}>
                <TextField value={draft.name ?? ""} placeholder={folder} label="Project name" onCommit={(v) => set("Rename project", setName(draft, v))} />
              </Row>
            </Section>

            <Section title="Display">
              <Row label="Width" problems={problemsAt("display.width")}>
                <NumberField id="ps-width" label="Display width" value={display.width} placeholder={String(defaultSettings.display.width)} suffix="px" onCommit={(v) => set("Set display width", setValue(draft, "display", "width", v))} />
              </Row>
              <Row label="Height" problems={problemsAt("display.height")}>
                <NumberField id="ps-height" label="Display height" value={display.height} placeholder={String(defaultSettings.display.height)} suffix="px" onCommit={(v) => set("Set display height", setValue(draft, "display", "height", v))} />
              </Row>
              <Row label="Background" problems={problemsAt("display.backgroundColor")}>
                <ColorField value={display.backgroundColor} fallback={defaultSettings.display.backgroundColor} onCommit={(v) => set("Set background colour", setValue(draft, "display", "backgroundColor", v))} />
              </Row>
              <Row label="Scaling" problems={problemsAt("display.scaleMode")}>
                <select
                  aria-label="Display scaling"
                  value={display.scaleMode ?? defaultSettings.display.scaleMode}
                  onChange={(e) => {
                    const v = (e.currentTarget as HTMLSelectElement).value;
                    set("Set display scaling", setValue(draft, "display", "scaleMode", v === defaultSettings.display.scaleMode ? undefined : v));
                  }}
                >
                  <option value="fit">Fit (keep aspect ratio)</option>
                  <option value="stretch">Stretch (fill the window)</option>
                  <option value="pixel-perfect">Pixel-perfect (whole multiples)</option>
                </select>
              </Row>
              <p class="project-settings-hint">The reference size above sets the aspect ratio; the scaling says how the game canvas fills its window.</p>
            </Section>

            <Section title="Time">
              <Row label="Fixed timestep" problems={problemsAt("time.fixedDeltaTime")}>
                <NumberField id="ps-fixed" label="Fixed timestep" value={time.fixedDeltaTime} placeholder={`${round(defaultSettings.time.fixedDeltaTime)}`} suffix={time.fixedDeltaTime ? `s (${round(1 / time.fixedDeltaTime)} Hz)` : "s"} onCommit={(v) => set("Set fixed timestep", setValue(draft, "time", "fixedDeltaTime", v))} />
              </Row>
              <Row label="Max frame time" problems={problemsAt("time.maxFrameTime")}>
                <NumberField id="ps-maxframe" label="Max frame time" value={time.maxFrameTime} placeholder={String(defaultSettings.time.maxFrameTime)} suffix="s" onCommit={(v) => set("Set max frame time", setValue(draft, "time", "maxFrameTime", v))} />
              </Row>
              <Row label="Max sub-steps" problems={problemsAt("time.maxSubSteps")}>
                <NumberField id="ps-substeps" label="Max sub-steps" value={time.maxSubSteps} placeholder={String(defaultSettings.time.maxSubSteps)} onCommit={(v) => set("Set max sub-steps", setValue(draft, "time", "maxSubSteps", v))} />
              </Row>
            </Section>

            <Section title="Rendering">
              <Row label="Pixels per unit" problems={problemsAt("render.pixelsPerUnit")}>
                <NumberField id="ps-ppu" label="Pixels per unit" value={render.pixelsPerUnit} placeholder={String(defaultSettings.render.pixelsPerUnit)} onCommit={(v) => set("Set pixels per unit", setValue(draft, "render", "pixelsPerUnit", v))} />
              </Row>
              <NameList
                title="Sorting layers"
                hint="back to front"
                names={sortingLayersOf(draft)}
                field="render.sortingLayers"
                problems={problems}
                item="sorting layer"
                onAdd={() => set("Add sorting layer", addSortingLayer(draft))}
                onRename={(i, v) => set(`Rename sorting layer to ${v}`, renameSortingLayer(draft, i, v))}
                onRemove={(i) => set("Remove sorting layer", removeSortingLayer(draft, i))}
                onMove={(i, by) => set("Reorder sorting layers", moveSortingLayer(draft, i, by))}
              />
            </Section>

            <Section title="Graphics">
              <Tiers draft={draft} problems={problemsAt("graphics")} set={set} />
            </Section>

            <Section title="Input">
              <InputSettings s={s} draft={draft} project={project} problems={problems} />
            </Section>

            <Section title="Plugins">
              <PluginsSection draft={draft} set={set} />
            </Section>

            <Section title="Autoloads">
              <Autoloads s={s} draft={draft} project={project} problems={problems} />
            </Section>

            <Section title="Build">
              <p class="project-settings-hint">Used when the game is exported as a desktop app.</p>
              <Row label="App identifier" problems={problemsAt("build.identifier")}>
                <TextField value={draft.build?.identifier ?? ""} placeholder="com.example.mygame" label="App identifier" onCommit={(v) => set("Set app identifier", setValue(draft, "build", "identifier", v.trim() || undefined))} />
              </Row>
              <Row label="Version" problems={problemsAt("build.version")}>
                <TextField value={draft.build?.version ?? ""} placeholder="0.1.0" label="Version" onCommit={(v) => set("Set version", setValue(draft, "build", "version", v.trim() || undefined))} />
              </Row>
              <Row label="Icon" problems={problemsAt("build.icon")}>
                <select
                  aria-label="Icon"
                  value={draft.build?.icon ?? ""}
                  onChange={(e) => set("Set icon", setValue(draft, "build", "icon", (e.currentTarget as HTMLSelectElement).value || undefined))}
                >
                  <option value="">Default icon</option>
                  {[...new Set([...(draft.build?.icon ? [draft.build.icon] : []), ...project.files.filter((f) => /\.(png|svg)$/i.test(f))])].map((f) => (
                    <option key={f} value={f}>
                      {f}
                    </option>
                  ))}
                </select>
              </Row>
            </Section>

            {projectSettingsSections.list().map((c) => {
              const View = lazySection(c);
              return (
                <Section key={c.id} title={c.title}>
                  <View draft={draft} problems={problemsAt(c.id).map((p) => p.message)} fieldProblems={problemsAt(c.id)} refresh={settings.refresh} set={set} project={project} />
                </Section>
              );
            })}
          </fieldset>
        </CategoryLayout>
      </div>
    </Panel>
  );
}

const round = (n: number) => Math.round(n * 1e4) / 1e4;

/** The settings categories, in order (Unity-style list). A category's title is its id. */
const BUILTIN_CATEGORIES = ["Project", "Display", "Time", "Rendering", "Graphics", "Input", "Plugins", "Autoloads", "Build"] as const;

/** The categories in order: the built-in ones, with each registered section (a plugin's, ADR 0133) after the one it names, else last. */
function categories(): string[] {
  const list: string[] = [...BUILTIN_CATEGORIES];
  for (const c of projectSettingsSections.list()) {
    const at = c.after ? list.indexOf(c.after) : -1;
    list.splice(at < 0 ? list.length : at + 1, 0, c.title);
  }
  return list;
}

// One lazy wrapper per contribution object, created on first use.
const sectionViews = new WeakMap<ProjectSettingsSectionContribution, LazyComponent<ProjectSettingsSectionProps>>();
const lazySection = (c: ProjectSettingsSectionContribution) => {
  let lazy = sectionViews.get(c);
  if (!lazy) sectionViews.set(c, (lazy = lazyComponent(c.view)));
  return lazy;
};
const NARROW_WIDTH = 250;

/** The category a problem's field belongs to (`"render.pixelsPerUnit"` is Rendering's). */
function categoryOf(field: string): string {
  const head = field.split(".")[0];
  switch (head) {
    case "name":
      return "Project";
    case "render":
      return "Rendering";
    case "autoload":
      return "Autoloads";
    case "input":
      return "Input";
    default:
      return projectSettingsSections.list().find((c) => c.id === head)?.title ?? head[0].toUpperCase() + head.slice(1);
  }
}

function categoryProblems(problems: readonly SettingsProblem[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const p of problems) counts[categoryOf(p.field)] = (counts[categoryOf(p.field)] ?? 0) + 1;
  return counts;
}

const selectedCategory = (): string => {
  const v = projectSettingsCategory.value;
  return categories().includes(v) ? v : BUILTIN_CATEGORIES[0];
};
const tabId = (c: string) => `ps-tab-${c}`;
const plural = (n: number) => `${n} problem${n === 1 ? "" : "s"}`;

/**
 * The category list on the left and the selected category's settings on the right; under
 * ~250 px wide the list is a dropdown above the settings. Arrow keys move through the list.
 */
function CategoryLayout(props: { counts: Record<string, number>; children: ComponentChildren }) {
  const ref = useRef<HTMLDivElement>(null);
  const [narrow, setNarrow] = useState(false);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    setNarrow(el.clientWidth < NARROW_WIDTH);
    if (typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver((entries) => setNarrow(entries[0].contentRect.width < NARROW_WIDTH));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  const CATEGORIES = categories();
  const selected = selectedCategory();
  const select = (c: string, focus = false) => {
    projectSettingsCategory.value = c;
    if (focus) ref.current?.querySelector<HTMLElement>(`[id="${tabId(c)}"]`)?.focus();
  };
  const onListKey = (e: KeyboardEvent) => {
    const i = CATEGORIES.indexOf(selected);
    const next = e.key === "ArrowDown" ? i + 1 : e.key === "ArrowUp" ? i - 1 : e.key === "Home" ? 0 : e.key === "End" ? CATEGORIES.length - 1 : null;
    if (next === null) return;
    e.preventDefault();
    select(CATEGORIES[Math.max(0, Math.min(CATEGORIES.length - 1, next))], true);
  };
  return (
    <div ref={ref} class={`project-settings-main${narrow ? " narrow" : ""}`}>
      {narrow ? (
        <select class="project-settings-category-select" id="ps-category-select" aria-label="Settings category" value={selected} onChange={(e) => select((e.currentTarget as HTMLSelectElement).value)}>
          {CATEGORIES.map((c) => (
            <option key={c} value={c}>
              {props.counts[c] ? `${c} (${props.counts[c]})` : c}
            </option>
          ))}
        </select>
      ) : (
        <div class="project-settings-categories" role="tablist" aria-orientation="vertical" aria-label="Settings categories" onKeyDown={onListKey}>
          {CATEGORIES.map((c) => (
            <button
              key={c}
              id={tabId(c)}
              role="tab"
              type="button"
              class={`project-settings-category${c === selected ? " selected" : ""}`}
              aria-selected={c === selected}
              aria-controls="ps-category-panel"
              aria-label={props.counts[c] ? `${c}, ${plural(props.counts[c])}` : c}
              tabIndex={c === selected ? 0 : -1}
              onClick={() => select(c)}
            >
              <span>{c}</span>
              {props.counts[c] > 0 && (
                <span class="project-settings-badge" aria-hidden="true" title={plural(props.counts[c])}>
                  {props.counts[c]}
                </span>
              )}
            </button>
          ))}
        </div>
      )}
      <div class="project-settings-body" id="ps-category-panel" role="tabpanel" aria-labelledby={narrow ? "ps-category-select" : tabId(selected)}>
        {props.children}
      </div>
    </div>
  );
}

/** A category's settings: only the selected category's section is shown. */
function Section(props: { title: string; children: ComponentChildren }) {
  if (props.title !== selectedCategory()) return null;
  return (
    <section class="project-settings-section" aria-label={props.title}>
      <h4>{props.title}</h4>
      {props.children}
    </section>
  );
}

/** A colour: the picker, and a hex text box (empty: the default). */
function ColorField(props: { value: string | undefined; fallback: string; onCommit: (v: string | undefined) => void }) {
  const { input } = useDraftText(props.value ?? "", (text) => {
    const t = text.trim();
    if (t === (props.value ?? "")) return;
    props.onCommit(t === "" ? undefined : t);
  });
  const shown = /^#[0-9a-f]{6}$/i.test(props.value ?? "") ? props.value! : props.fallback;
  return (
    <span class="project-settings-color">
      <input type="color" aria-label="Background colour picker" value={shown} onChange={(e) => props.onCommit((e.currentTarget as HTMLInputElement).value)} />
      <input
        type="text"
        aria-label="Background colour"
        placeholder={props.fallback}
        {...input}
      />
    </span>
  );
}

/** Scenes and prefabs instanced at startup that persist across scene loads, in order. */
function Autoloads(props: { s: PanelState; draft: SettingsDraft; project: EditorProject; problems: readonly SettingsProblem[] }) {
  const { s, draft, project, problems } = props;
  const list = autoloadsOf(draft);
  const choices = project.files.filter((f) => /\.(scene|prefab)\.json$/.test(f) && !list.includes(f));
  const set = (label: string, next: SettingsDraft) => edit(s, label, next);
  return (
    <div class="project-settings-list" role="group" aria-label="Autoload list">
      <p class="project-settings-hint">Instanced under the World root at startup; they stay when scenes change.</p>
      {list.length === 0 && <p class="project-settings-none">None</p>}
      {list.map((path, i) => (
        <div key={path} class={`project-settings-item${problems.some((p) => p.field === `autoload.${i}`) ? " invalid" : ""}`} data-autoload={path}>
          <span class="project-settings-path">{path}</span>
          <button class="icon" aria-label={`Move ${path} up`} disabled={i === 0} onClick={() => set("Reorder autoloads", moveAutoload(draft, i, -1))}>
            ↑
          </button>
          <button class="icon" aria-label={`Move ${path} down`} disabled={i === list.length - 1} onClick={() => set("Reorder autoloads", moveAutoload(draft, i, 1))}>
            ↓
          </button>
          <button class="icon" aria-label={`Remove autoload ${path}`} onClick={() => set(`Remove autoload ${path}`, removeAutoload(draft, i))}>
            ×
          </button>
        </div>
      ))}
      {choices.length > 0 && (
        <select
          aria-label="Add an autoload"
          value=""
          onChange={(e) => {
            const path = (e.currentTarget as HTMLSelectElement).value;
            if (path) set(`Autoload ${path}`, addAutoload(draft, path));
          }}
        >
          <option value="">Add a prefab or scene…</option>
          {choices.map((f) => (
            <option key={f} value={f}>
              {f}
            </option>
          ))}
        </select>
      )}
    </div>
  );
}

/** Input players (ADR 0337) and the action sets (ADR 0417): the files in load order, then the sets scripts define. */
function InputSettings(props: { s: PanelState; draft: SettingsDraft; project: EditorProject; problems: readonly SettingsProblem[] }) {
  const { s, draft, project, problems } = props;
  const input = (draft.input ?? {}) as { join?: string; maxPlayers?: number };
  const defaults = defaultSettings.input;
  const at = (field: string) => problems.filter((p) => p.field === field || p.field.startsWith(`${field}.`));
  const set = (label: string, next: SettingsDraft) => edit(s, label, next);
  const paths = actionSetsOf(draft);
  const rows = paths.map((path) => actionSetRow(path, project.files.includes(path), () => project.assets.get(path)));
  const fromScripts = codeActionSets(inputActionSets(), rows);
  const choices = unlistedActionSets(project.files, paths);
  const create = async () => {
    const path = await createAsset("actionSet"); // nothing when the kind isn't registered
    if (path) edit(s, `Add action set ${path}`, addActionSet(s.draft, path));
  };
  return (
    <>
      <Row label="Join" problems={at("input.join")}>
        <select
          aria-label="Input join"
          value={input.join ?? defaults.join}
          onChange={(e) => {
            const v = (e.currentTarget as HTMLSelectElement).value;
            set("Set input join", setValue(draft, "input", "join", v === defaults.join ? undefined : v));
          }}
        >
          {INPUT_JOIN_POLICIES.map((p) => (
            <option key={p} value={p}>
              {p}
            </option>
          ))}
        </select>
      </Row>
      <Row label="Max players" problems={at("input.maxPlayers")}>
        <NumberField id="ps-maxplayers" label="Max players" value={input.maxPlayers} placeholder={String(defaults.maxPlayers)} onCommit={(v) => set("Set max players", setValue(draft, "input", "maxPlayers", v))} />
      </Row>

      <h5 class="project-settings-subhead">Action sets</h5>
      <p class="project-settings-hint">Defined in this order at startup. A set here replaces a script's set with the same id.</p>
      {rows.length === 0 && <p class="project-settings-none">None</p>}
      <SortableList
        class="action-set-list"
        label="Action sets"
        items={rows}
        disabled={!project.canSave}
        itemKey={(r) => r.path}
        itemLabel={(r) => r.path}
        rowClass={(r, i) => (r.problem || at(`input.actionSets.${i}`).length > 0 ? "invalid" : undefined)}
        onMove={(from, to) => set("Reorder action sets", moveActionSetTo(draft, from, to))}
        renderItem={(r, i) => (
          <>
            <span class="action-set-index">{i + 1}</span>
            <span class="project-settings-path" title={r.problem ?? r.path}>
              {r.path}
            </span>
            {r.problem ? (
              <span class="action-set-problem" title={r.problem}>
                {r.problem}
              </span>
            ) : (
              <span class="action-set-info">
                {r.id} · {r.actions} action{r.actions === 1 ? "" : "s"}
              </span>
            )}
            <button class="icon" aria-label={`Remove action set ${r.path}`} onClick={() => set(`Remove action set ${r.path}`, removeActionSet(draft, i))}>
              ×
            </button>
          </>
        )}
      />
      <div class="project-settings-actions">
        <button type="button" onClick={() => void create()}>
          New Action Set
        </button>
        {choices.length > 0 && (
          <select
            aria-label="Add an action set"
            value=""
            onChange={(e) => {
              const path = (e.currentTarget as HTMLSelectElement).value;
              if (path) set(`Add action set ${path}`, addActionSet(draft, path));
            }}
          >
            <option value="">Add…</option>
            {choices.map((f) => (
              <option key={f} value={f}>
                {f}
              </option>
            ))}
          </select>
        )}
      </div>

      {fromScripts.length > 0 && (
        <>
          <h5 class="project-settings-subhead">From scripts</h5>
          <ul class="action-set-code" aria-label="Action sets from scripts">
            {fromScripts.map((c) => (
              <li key={c.id}>
                <span class="project-settings-path">{c.id}</span>
                <span class="action-set-info">
                  {c.actions.length} action{c.actions.length === 1 ? "" : "s"}
                </span>
              </li>
            ))}
          </ul>
        </>
      )}
    </>
  );
}

const LEVEL_LABELS: Record<string, string> = { off: "Off", low: "Low", medium: "Medium", high: "High", ultra: "Ultra", msaa: "MSAA", smaa: "SMAA", fxaa: "FXAA" };
const ANISOTROPY_LEVELS = [1, 2, 4, 8, 16];
const PLATFORM_LABELS = { desktop: "Desktop", web: "Web", mobile: "Mobile" } as const;
const CASCADE_COUNTS = [1, 2, 3, 4];
const CASCADE_LABELS: Record<string, string> = { 1: "1 (off)" };
const AO_OPTIONS = ["off", "low", "medium", "high", "ultra"] as const;

/** The graphics quality tiers (ADR 0050), lowest first, as compact cards. */
function Tiers(props: { draft: SettingsDraft; problems: readonly SettingsProblem[]; set: (label: string, next: SettingsDraft) => void }) {
  const { draft, problems, set } = props;
  const g = graphicsOf(draft);
  const value = (i: number, key: TierValueKey, v: unknown) => set(`Set ${g.tiers[i].name} ${key}`, setTierValue(draft, i, key, v));
  const choice = (i: number, key: TierValueKey, label: string, options: readonly (string | number)[], disabled = false, labels: Record<string, string> = LEVEL_LABELS) => {
    const name = g.tiers[i].name;
    const current = g.tiers[i][key];
    return (
      <select
        aria-label={`${name} ${label}`}
        value={String(current)}
        disabled={disabled}
        onChange={(e) => {
          const raw = (e.currentTarget as HTMLSelectElement).value;
          value(i, key, typeof current === "number" ? Number(raw) : raw);
        }}
      >
        {options.map((o) => (
          <option key={o} value={String(o)}>
            {labels[String(o)] ?? String(o)}
          </option>
        ))}
      </select>
    );
  };
  const toggle = (i: number, key: "postProcessing" | "bloom" | "depthOfField", label: string, disabled = false) => (
    <input
      type="checkbox"
      aria-label={`${g.tiers[i].name} ${label}`}
      checked={g.tiers[i][key]}
      disabled={disabled}
      onChange={(e) => value(i, key, (e.currentTarget as HTMLInputElement).checked)}
    />
  );
  return (
    <div class={`project-settings-list project-settings-tiers${problems.length ? " invalid" : ""}`} role="group" aria-label="Graphics tiers">
      <Row label="Default tier" problems={[]}>
        <select aria-label="Default tier" value={g.defaultTier} onChange={(e) => set("Set default tier", setDefaultTier(draft, (e.currentTarget as HTMLSelectElement).value))}>
          {g.tiers.map((t) => (
            <option key={t.name} value={t.name}>
              {t.name}
            </option>
          ))}
        </select>
      </Row>
      {PLATFORMS.map((p) => (
        <Row key={p} label={`${PLATFORM_LABELS[p]} default`} problems={[]}>
          <select
            aria-label={`${PLATFORM_LABELS[p]} default`}
            value={g.platformDefaults?.[p] ?? ""}
            onChange={(e) => set(`Set ${p} default tier`, setPlatformDefault(draft, p, (e.currentTarget as HTMLSelectElement).value || undefined))}
          >
            <option value="">(project default)</option>
            {g.tiers.map((t) => (
              <option key={t.name} value={t.name}>
                {t.name}
              </option>
            ))}
          </select>
        </Row>
      ))}
      <Row label="Detect the tier on first run" problems={[]}>
        <input
          type="checkbox"
          aria-label="Detect tier automatically"
          checked={g.autoDetect}
          onChange={(e) => set("Set automatic tier detection", setAutoDetect(draft, (e.currentTarget as HTMLInputElement).checked))}
        />
      </Row>
      <Row label="Target frame rate" problems={[]}>
        <input
          type="number"
          min={20}
          max={240}
          step={1}
          aria-label="Target frame rate"
          value={g.targetFrameRate}
          disabled={!g.autoDetect}
          onChange={(e) => {
            const n = (e.currentTarget as HTMLInputElement).valueAsNumber;
            if (Number.isFinite(n)) set("Set target frame rate", setTargetFrameRate(draft, n));
          }}
        />
      </Row>
      <p class="project-settings-hint">Without a saved player choice, the game guesses a tier from the GPU and steps down if it can't keep this frame rate.</p>
      {g.tiers.map((t, i) => (
        <div key={i} class="tier-card" data-tier={t.name}>
          <div class="tier-card-head">
            <TextField value={t.name} label={`Tier ${i + 1} name`} onCommit={(v) => set(`Rename tier to ${v.trim()}`, renameTier(draft, i, v.trim()))} />
            <span class="tier-buttons">
              <button class="icon" aria-label={`Move ${t.name} up`} title="Move up (lower quality)" disabled={i === 0} onClick={() => set("Reorder tiers", moveTier(draft, i, -1))}>
                ↑
              </button>
              <button class="icon" aria-label={`Move ${t.name} down`} title="Move down (higher quality)" disabled={i === g.tiers.length - 1} onClick={() => set("Reorder tiers", moveTier(draft, i, 1))}>
                ↓
              </button>
              <button class="icon" aria-label={`Remove ${t.name}`} title="Remove this tier" disabled={g.tiers.length <= 1} onClick={() => set(`Remove tier ${t.name}`, removeTier(draft, i))}>
                ×
              </button>
            </span>
          </div>
          <div class="tier-fields">
            <label>
              <span class="tier-label">Render scale</span>
              <input
                type="number"
                min={0.25}
                max={2}
                step={0.05}
                aria-label={`${t.name} render scale`}
                value={t.renderScale}
                onChange={(e) => {
                  const n = (e.currentTarget as HTMLInputElement).valueAsNumber;
                  if (Number.isFinite(n)) value(i, "renderScale", n);
                }}
              />
            </label>
            <label>
              <span class="tier-label">Anti-aliasing</span>
              {choice(i, "antialias", "anti-aliasing", ANTIALIAS_MODES)}
            </label>
            <label>
              <span class="tier-label">Shadows</span>
              {choice(i, "shadows", "shadows", SHADOW_QUALITIES)}
            </label>
            <label class={t.shadows === "off" ? "disabled" : ""}>
              <span class="tier-label">Shadow cascades</span>
              {choice(i, "shadowCascades", "shadow cascades", CASCADE_COUNTS, t.shadows === "off", CASCADE_LABELS)}
            </label>
            <label class={t.shadows === "off" || t.shadowCascades <= 1 ? "disabled" : ""}>
              <span class="tier-label">Cascaded lights</span>
              {choice(i, "cascadedLights", "cascaded lights", CASCADE_COUNTS, t.shadows === "off" || t.shadowCascades <= 1)}
            </label>
            <label class={t.shadows === "off" ? "disabled" : ""}>
              <span class="tier-label">Shadow distance</span>
              <input
                type="number"
                min={10}
                max={1000}
                step={10}
                aria-label={`${t.name} shadow distance`}
                value={t.shadowDistance}
                disabled={t.shadows === "off"}
                onChange={(e) => {
                  const n = (e.currentTarget as HTMLInputElement).valueAsNumber;
                  if (Number.isFinite(n)) value(i, "shadowDistance", n);
                }}
              />
            </label>
            <label>
              <span class="tier-label">Anisotropy</span>
              {choice(i, "anisotropy", "anisotropy", ANISOTROPY_LEVELS)}
            </label>
            <label>
              <span class="tier-label">Shader level</span>
              {choice(i, "shaderLevel", "shader level", SHADER_LEVELS)}
            </label>
            <label>
              <span class="tier-label">Post-processing</span>
              {toggle(i, "postProcessing", "post-processing")}
            </label>
            <label class={t.postProcessing ? "" : "disabled"}>
              <span class="tier-label">Bloom</span>
              {toggle(i, "bloom", "bloom", !t.postProcessing)}
            </label>
            <label class={t.postProcessing ? "" : "disabled"}>
              <span class="tier-label">Ambient occlusion</span>
              {choice(i, "ambientOcclusion", "ambient occlusion", AO_OPTIONS, !t.postProcessing)}
            </label>
            <label class={t.postProcessing ? "" : "disabled"}>
              <span class="tier-label">Depth of field</span>
              {toggle(i, "depthOfField", "depth of field", !t.postProcessing)}
            </label>
            <label>
              <span class="tier-label">Reflection probes</span>
              {choice(i, "reflectionProbes", "reflection probes", PROBE_QUALITIES)}
            </label>
            <label>
              <span class="tier-label">Particles</span>
              {choice(i, "particles", "particles", PARTICLE_QUALITIES)}
            </label>
            <label>
              <span class="tier-label">2D lights</span>
              {choice(i, "lights2D", "2D lights", LIGHTS_2D_QUALITIES)}
            </label>
          </div>
        </div>
      ))}
      <button onClick={() => set("Add tier", addTier(draft))}>Add Tier</button>
      <p class="project-settings-hint">Players pick a tier in game with Graphics.quality; the Scene view's Quality menu previews one.</p>
    </div>
  );
}

// The Worlds panel's model (ADR 0032): `project.json`'s `bootstrap` section as start-up Worlds,
// templates and links, the edits the panel makes to them, why each catalog system is in or out
// of a World, and writing the section back into the file. Pure, so it's unit-tested;
// WorldsPanel.tsx draws it and saves the result.
import type { BootstrapConfig, LinkConfig, SystemSelection, WorldConfig, WorldTag } from "../engine";
import { validateBootstrap } from "../engine/core/settings";
import type { SystemCatalogEntry } from "../engine/core/systems";
import { DEFAULT_WORLD_NAME, DEFAULT_WORLD_TAGS, worldsMatch } from "../engine/core/worlds";

/** Tags offered as one-click chips; projects can type their own. */
export const PRESET_TAGS: readonly WorldTag[] = ["default", "client", "server", "local", "editor"];

/** Transports offered for links even before they're registered (ADR 0033). */
export const KNOWN_TRANSPORTS: readonly string[] = ["loopback", "websocket"];

/** A template's config: a World config whose name is optional (it defaults to the template's). */
export type TemplateConfig = Omit<WorldConfig, "name"> & { name?: string };

export interface TemplateEntry {
  /** The template's name: its key in `bootstrap.templates`. */
  key: string;
  config: TemplateConfig;
}

/**
 * The bootstrap as the panel edits it. Templates are a list rather than a record so a draft can
 * hold two with the same name (reported as a problem) without losing one.
 */
export interface WorldsModel {
  worlds: WorldConfig[];
  links: LinkConfig[];
  templates: TemplateEntry[];
}

/** A World or a template in the model. */
export interface WorldRef {
  kind: "world" | "template";
  index: number;
}

/**
 * What the panel can show for a `bootstrap` setting: a graph to edit (`explicit` false when the
 * project has none, so it shows the default bootstrap's World), a code bootstrap's script, or a
 * section too malformed to edit (fix it in the Code panel).
 */
export type BootstrapView =
  | { kind: "graph"; model: WorldsModel; explicit: boolean }
  | { kind: "code"; path: string }
  | { kind: "broken"; problems: string[] };

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/** The default bootstrap's single World, as a model. */
export function defaultModel(): WorldsModel {
  return { worlds: [{ name: DEFAULT_WORLD_NAME, tags: [...DEFAULT_WORLD_TAGS] }], links: [], templates: [] };
}

/** Read `project.json`'s `bootstrap` for the panel. Configs with problems still open as a graph if their shape is editable. */
export function readBootstrap(setting: unknown): BootstrapView {
  if (setting === undefined) return { kind: "graph", model: defaultModel(), explicit: false };
  if (typeof setting === "string") return { kind: "code", path: setting };
  const editable =
    isRecord(setting) &&
    Array.isArray(setting.worlds) &&
    setting.worlds.every(isRecord) &&
    (setting.links === undefined || (Array.isArray(setting.links) && setting.links.every(isRecord))) &&
    (setting.templates === undefined || (isRecord(setting.templates) && Object.values(setting.templates).every(isRecord)));
  if (!editable) {
    const problems = validateBootstrap(setting);
    return { kind: "broken", problems: problems.length ? problems : ["bootstrap isn't a config the Worlds panel can edit."] };
  }
  const config = setting as unknown as BootstrapConfig;
  return {
    kind: "graph",
    explicit: true,
    model: {
      worlds: [...config.worlds],
      links: [...(config.links ?? [])],
      templates: Object.entries(config.templates ?? {}).map(([key, c]) => ({ key, config: c })),
    },
  };
}

/** The `bootstrap` section for a model: `links` and `templates` only when there are some. */
export function modelToConfig(model: WorldsModel): BootstrapConfig {
  const config: { worlds: WorldConfig[]; links?: LinkConfig[]; templates?: Record<string, TemplateConfig> } = { worlds: model.worlds };
  if (model.links.length > 0) config.links = model.links;
  if (model.templates.length > 0) config.templates = Object.fromEntries(model.templates.map((t) => [t.key, t.config]));
  return config;
}

// --- problems -----------------------------------------------------------------------------------

/** Everything wrong with a model: `validateBootstrap` against `catalog`, plus template names it can't see (a record can't hold duplicates). */
export function modelProblems(model: WorldsModel, catalog: readonly SystemCatalogEntry[]): string[] {
  const problems = validateBootstrap(modelToConfig(model), catalog);
  const seen = new Set<string>();
  for (const t of model.templates) {
    if (seen.has(t.key)) problems.push(`bootstrap.templates["${t.key}"]: another template is already named "${t.key}"; template names must be unique.`);
    seen.add(t.key);
  }
  return problems;
}

/** Problems sorted by what they're about, with the location prefix removed: per World (by index), template (by name) and link (by index), and the rest. */
export interface GroupedProblems {
  general: string[];
  worlds: Map<number, string[]>;
  templates: Map<string, string[]>;
  links: Map<number, string[]>;
}

const WORLD_PROBLEM = /^bootstrap\.worlds\[(\d+)\](?: \(".*?"\))?(.*)$/s;
const TEMPLATE_PROBLEM = /^bootstrap\.templates\["(.*?)"\](.*)$/s;
const LINK_PROBLEM = /^bootstrap\.links\[(\d+)\](.*)$/s;

/** `": tickRate must…"` → `"tickRate must…"`, `".systems: unknown key…"` → `"systems: unknown key…"`. */
const rest = (s: string) => s.replace(/^(?::\s*|\.|\s+)/, "");

export function groupProblems(problems: readonly string[]): GroupedProblems {
  const out: GroupedProblems = { general: [], worlds: new Map(), templates: new Map(), links: new Map() };
  const add = <K>(map: Map<K, string[]>, key: K, text: string) => map.set(key, [...(map.get(key) ?? []), text]);
  for (const p of problems) {
    let m: RegExpExecArray | null;
    if ((m = WORLD_PROBLEM.exec(p))) add(out.worlds, Number(m[1]), rest(m[2]));
    else if ((m = TEMPLATE_PROBLEM.exec(p))) add(out.templates, m[1], rest(m[2]));
    else if ((m = LINK_PROBLEM.exec(p))) add(out.links, Number(m[1]), rest(m[2]));
    else out.general.push(p);
  }
  return out;
}

// --- edits --------------------------------------------------------------------------------------

const WORLD_KEYS = ["name", "tags", "tickRate", "timeScale", "renders", "input", "scenes", "systems"];

/** `base`, else `base 2`, `base 3`… : the first not in `taken`. */
export function uniqueName(base: string, taken: readonly string[]): string {
  if (!taken.includes(base)) return base;
  for (let i = 2; ; i++) if (!taken.includes(`${base} ${i}`)) return `${base} ${i}`;
}

/** `config` with `patch` applied (undefined removes a key), keys in the order project.json lists them. */
function patched<T extends object>(config: T, patch: object): T {
  const merged: Record<string, unknown> = { ...(config as Record<string, unknown>), ...patch };
  const out: Record<string, unknown> = {};
  const keys = [...WORLD_KEYS.filter((k) => k in merged), ...Object.keys(merged).filter((k) => !WORLD_KEYS.includes(k))];
  for (const k of keys) if (merged[k] !== undefined) out[k] = merged[k];
  return out as T;
}

export function configOf(model: WorldsModel, ref: WorldRef): WorldConfig | TemplateConfig | undefined {
  return ref.kind === "world" ? model.worlds[ref.index] : model.templates[ref.index]?.config;
}

/** The name shown for a World or template. */
export function nameOf(model: WorldsModel, ref: WorldRef): string {
  return (ref.kind === "world" ? model.worlds[ref.index]?.name : model.templates[ref.index]?.key) ?? "";
}

/** A World's tags, with the default filled in. */
export const tagsOf = (config: { tags?: readonly WorldTag[] }): readonly WorldTag[] => config.tags ?? DEFAULT_WORLD_TAGS;

/** Add a World (no tags yet, so it runs only the engine's every-World systems). */
export function addWorld(model: WorldsModel, name = "World"): WorldsModel {
  const world: WorldConfig = { name: uniqueName(name, model.worlds.map((w) => w.name)), tags: [] };
  return { ...model, worlds: [...model.worlds, world] };
}

export function addTemplate(model: WorldsModel, name = "Template"): WorldsModel {
  const entry: TemplateEntry = { key: uniqueName(name, model.templates.map((t) => t.key)), config: { tags: [] } };
  return { ...model, templates: [...model.templates, entry] };
}

/** Change a World's or template's settings; `undefined` removes a setting (back to its default). */
export function updateConfig(model: WorldsModel, ref: WorldRef, patch: Partial<Omit<WorldConfig, "name">>): WorldsModel {
  if (ref.kind === "world") return { ...model, worlds: model.worlds.map((w, i) => (i === ref.index ? patched(w, patch) : w)) };
  return { ...model, templates: model.templates.map((t, i) => (i === ref.index ? { ...t, config: patched(t.config, patch) } : t)) };
}

/** Rename a World (links to and from it follow) or a template. */
export function rename(model: WorldsModel, ref: WorldRef, name: string): WorldsModel {
  if (ref.kind === "template") return { ...model, templates: model.templates.map((t, i) => (i === ref.index ? { ...t, key: name } : t)) };
  const old = model.worlds[ref.index]?.name;
  if (old === undefined || old === name) return model;
  // Links name Worlds; with two Worlds of the old name (an invalid draft) they keep pointing at the other.
  const shared = model.worlds.some((w, i) => i !== ref.index && w.name === old);
  const follow = (n: string) => (n === old && !shared ? name : n);
  return {
    ...model,
    worlds: model.worlds.map((w, i) => (i === ref.index ? { ...w, name } : w)),
    links: model.links.map((l) => (l.from === old || l.to === old ? { ...l, from: follow(l.from), to: follow(l.to) } : l)),
  };
}

/** Remove a World (and its links) or a template. */
export function remove(model: WorldsModel, ref: WorldRef): WorldsModel {
  if (ref.kind === "template") return { ...model, templates: model.templates.filter((_, i) => i !== ref.index) };
  const name = model.worlds[ref.index]?.name;
  const shared = model.worlds.some((w, i) => i !== ref.index && w.name === name);
  return {
    ...model,
    worlds: model.worlds.filter((_, i) => i !== ref.index),
    links: shared ? model.links : model.links.filter((l) => l.from !== name && l.to !== name),
  };
}

export function addLink(model: WorldsModel, link: LinkConfig): WorldsModel {
  return { ...model, links: [...model.links, link] };
}

export function updateLink(model: WorldsModel, index: number, patch: Partial<LinkConfig>): WorldsModel {
  return { ...model, links: model.links.map((l, i) => (i === index ? { ...l, ...patch } : l)) };
}

export function removeLink(model: WorldsModel, index: number): WorldsModel {
  return { ...model, links: model.links.filter((_, i) => i !== index) };
}

/** Transports to offer: the registered ones, the known ones, and any already in use, without repeats. */
export function transportChoices(registered: readonly string[], inUse: readonly string[] = []): string[] {
  return [...new Set([...registered, ...KNOWN_TRANSPORTS, ...inUse])];
}

// --- systems ------------------------------------------------------------------------------------

export interface SystemStatus {
  /** Whether a World made from the config runs the system. */
  runs: boolean;
  /** Why, as the checklist says it. */
  reason: string;
}

/** Whether a World made from `config` runs `entry`, and why (the rules of `selectSystems`). */
export function systemStatus(config: { tags?: readonly WorldTag[]; systems?: SystemSelection }, entry: SystemCatalogEntry): SystemStatus {
  if (config.systems?.exclude?.includes(entry.name)) return { runs: false, reason: "excluded here" };
  if (config.systems?.include?.includes(entry.name)) return { runs: true, reason: "included here" };
  if (entry.worlds.includes("*")) return { runs: true, reason: entry.builtin ? "every World (engine)" : "every World" };
  const tag = entry.worlds.find((t) => tagsOf(config).includes(t));
  if (tag !== undefined) return { runs: true, reason: `added by tag \`${tag}\`` };
  return { runs: false, reason: "not for this World's tags" };
}

/**
 * The `systems` selection after turning `entry` on or off, changed as little as possible: the name
 * leaves both lists, then goes into `include` or `exclude` only if the tags alone would disagree.
 * Undefined when nothing is left to select.
 */
export function selectSystem(config: { tags?: readonly WorldTag[]; systems?: SystemSelection }, entry: SystemCatalogEntry, on: boolean): SystemSelection | undefined {
  const include = (config.systems?.include ?? []).filter((n) => n !== entry.name);
  const exclude = (config.systems?.exclude ?? []).filter((n) => n !== entry.name);
  const byTags = worldsMatch(entry.worlds, tagsOf(config));
  if (on && !byTags) include.push(entry.name);
  if (!on && byTags) exclude.push(entry.name);
  const out: SystemSelection = { ...(include.length ? { include } : {}), ...(exclude.length ? { exclude } : {}) };
  return out.include || out.exclude ? out : undefined;
}

/** Turn a catalog system on or off for a World or template. */
export function setSystem(model: WorldsModel, ref: WorldRef, entry: SystemCatalogEntry, on: boolean): WorldsModel {
  const config = configOf(model, ref);
  if (!config) return model;
  return updateConfig(model, ref, { systems: selectSystem(config, entry, on) });
}

// --- graph layout -------------------------------------------------------------------------------

/** Where each start-up World goes in the graph: a column per link depth (clients left of the servers they connect to), stacked within a column. */
export function layoutWorlds(model: WorldsModel): { col: number; row: number }[] {
  const n = model.worlds.length;
  const index = new Map<string, number>();
  model.worlds.forEach((w, i) => index.has(w.name) || index.set(w.name, i));
  const col = new Array<number>(n).fill(0);
  // Longest-path layering, capped at n passes so a cycle of links can't loop forever.
  for (let pass = 0; pass < n; pass++) {
    let changed = false;
    for (const l of model.links) {
      const a = index.get(l.from), b = index.get(l.to);
      if (a === undefined || b === undefined || a === b || col[b] >= col[a] + 1 || col[a] + 1 >= n) continue;
      col[b] = col[a] + 1;
      changed = true;
    }
    if (!changed) break;
  }
  const rows = new Map<number, number>();
  return col.map((c) => {
    const row = rows.get(c) ?? 0;
    rows.set(c, row + 1);
    return { col: c, row };
  });
}

// --- undo ---------------------------------------------------------------------------------------

/** A small linear undo history of panel states (the scene's CommandStack is per scene document). */
export class EditHistory<T> {
  private past: { label: string; state: T }[] = [];
  private future: { label: string; state: T }[] = [];

  constructor(public current: T) {}

  /** Record an edit that produced `next`; clears redo. */
  push(label: string, next: T): void {
    this.past.push({ label, state: this.current });
    this.future = [];
    this.current = next;
  }

  get undoLabel(): string | null {
    return this.past.at(-1)?.label ?? null;
  }

  get redoLabel(): string | null {
    return this.future.at(-1)?.label ?? null;
  }

  /** Go back one edit; returns the new current state, or null if there's nothing to undo. */
  undo(): T | null {
    const entry = this.past.pop();
    if (!entry) return null;
    this.future.push({ label: entry.label, state: this.current });
    this.current = entry.state;
    return this.current;
  }

  redo(): T | null {
    const entry = this.future.pop();
    if (!entry) return null;
    this.past.push({ label: entry.label, state: this.current });
    this.current = entry.state;
    return this.current;
  }
}

// --- writing project.json -----------------------------------------------------------------------

interface Member {
  key: string;
  keyStart: number;
  valueStart: number;
  valueEnd: number;
}

const skipSpace = (text: string, i: number) => {
  while (i < text.length && /\s/.test(text[i])) i++;
  return i;
};

function stringEnd(text: string, i: number): number {
  let j = i + 1;
  while (j < text.length && text[j] !== '"') j += text[j] === "\\" ? 2 : 1;
  return j + 1;
}

function valueEnd(text: string, i: number): number {
  if (text[i] === '"') return stringEnd(text, i);
  if (text[i] === "{" || text[i] === "[") {
    let depth = 0;
    while (i < text.length) {
      const c = text[i];
      if (c === '"') {
        i = stringEnd(text, i);
        continue;
      }
      if (c === "{" || c === "[") depth++;
      else if ((c === "}" || c === "]") && --depth === 0) return i + 1;
      i++;
    }
    return i;
  }
  while (i < text.length && !/[\s,}\]]/.test(text[i])) i++;
  return i;
}

/** The root object's members with their text positions, or null for text it doesn't understand. */
function topLevelMembers(text: string): Member[] | null {
  let i = skipSpace(text, 0);
  if (text[i] !== "{") return null;
  i++;
  const out: Member[] = [];
  for (;;) {
    i = skipSpace(text, i);
    if (text[i] === "}" && out.length === 0) return out;
    if (text[i] !== '"') return null;
    const keyStart = i;
    const keyEnd = stringEnd(text, i);
    const key = JSON.parse(text.slice(keyStart, keyEnd)) as string;
    i = skipSpace(text, keyEnd);
    if (text[i] !== ":") return null;
    const start = skipSpace(text, i + 1);
    const end = valueEnd(text, start);
    out.push({ key, keyStart, valueStart: start, valueEnd: end });
    i = skipSpace(text, end);
    if (text[i] === ",") i++;
    else if (text[i] === "}") return out;
    else return null;
  }
}

/**
 * A value as project.json lays values out: objects one key per line, lists of plain values on one
 * line (`["server", "local"]`), lists of objects one per line.
 */
export function formatJsonValue(value: unknown, indent = "", unit = "  ", nl = "\n"): string {
  const inner = indent + unit;
  if (Array.isArray(value)) {
    if (value.length === 0) return "[]";
    if (value.every((v) => v === null || typeof v !== "object")) return `[${value.map((v) => JSON.stringify(v)).join(", ")}]`;
    return `[${nl}${value.map((v) => inner + formatJsonValue(v, inner, unit, nl)).join(`,${nl}`)}${nl}${indent}]`;
  }
  if (isRecord(value)) {
    const entries = Object.entries(value).filter(([, v]) => v !== undefined);
    if (entries.length === 0) return "{}";
    return `{${nl}${entries.map(([k, v]) => `${inner}${JSON.stringify(k)}: ${formatJsonValue(v, inner, unit, nl)}`).join(`,${nl}`)}${nl}${indent}}`;
  }
  return JSON.stringify(value) ?? "null";
}

/**
 * `project.json`'s text with its `bootstrap` set to `setting` (or removed, for undefined). Every
 * other key keeps its text exactly; the section follows the file's indent and line endings. Text
 * it can't scan is rewritten whole (2-space JSON with a trailing newline).
 */
export function withBootstrap(text: string, setting: BootstrapConfig | string | undefined): string {
  const nl = text.includes("\r\n") ? "\r\n" : "\n";
  const members = topLevelMembers(text);
  if (!members) {
    const json = JSON.parse(text) as Record<string, unknown>;
    return `${formatJsonValue({ ...json, bootstrap: setting })}\n`;
  }
  const first = members[0];
  const unit = first ? text.slice(text.lastIndexOf("\n", first.keyStart) + 1, first.keyStart) || "  " : "  ";
  const value = setting === undefined ? undefined : formatJsonValue(setting, unit, unit, nl);
  const at = members.findIndex((m) => m.key === "bootstrap");
  if (at >= 0) {
    const m = members[at];
    if (value !== undefined) return text.slice(0, m.valueStart) + value + text.slice(m.valueEnd);
    if (at > 0) return text.slice(0, members[at - 1].valueEnd) + text.slice(m.valueEnd);
    const next = members[at + 1];
    return next ? text.slice(0, m.keyStart) + text.slice(next.keyStart) : text.slice(0, text.indexOf("{") + 1) + text.slice(text.lastIndexOf("}"));
  }
  if (value === undefined) return text;
  const entry = `"bootstrap": ${value}`;
  const last = members.at(-1);
  if (last) return `${text.slice(0, last.valueEnd)},${nl}${unit}${entry}${text.slice(last.valueEnd)}`;
  const close = text.lastIndexOf("}");
  return `${text.slice(0, close).trimEnd()}${nl}${unit}${entry}${nl}${text.slice(close)}`;
}

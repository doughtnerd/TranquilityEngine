// The Worlds panel's model (ADR 0032, 0062): `project.json`'s `bootstrap` section as start-up Worlds,
// Spawnable Worlds (`templates`) and links, the edits the panel makes to them, why each catalog system is in or out
// of a World, and writing the section back into the file. Pure, so it's unit-tested;
// WorldsPanel.tsx draws it and saves the result.
import type { BootstrapConfig, LinkConfig, ReplicationSettings, SystemSelection, WorldConfig, WorldTag } from "../engine";
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
  model.links.forEach((l, i) => problems.push(...linkOptionProblems(l, `bootstrap.links[${i}]`)));
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

const WORLD_KEYS = ["name", "tags", "tickRate", "timeScale", "renders", "input", "scenes", "systems", "lobby", "replication"];

/**
 * A World config's `replication` (ADR 0101) with `key` set to `value` (undefined removes it);
 * undefined when nothing is left, so the key goes from project.json.
 */
export function withReplicationSetting(
  replication: ReplicationSettings | undefined,
  key: keyof ReplicationSettings,
  value: number | undefined,
): ReplicationSettings | undefined {
  const next: Record<string, number> = { ...(replication as Record<string, number> | undefined) };
  if (value === undefined) delete next[key];
  else next[key] = value;
  return Object.keys(next).length > 0 ? (next as ReplicationSettings) : undefined;
}

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

/** The name of the World a Spawnable World (template) creates: its own `name`, else its key (ADR 0062). */
export const spawnableName = (t: TemplateEntry): string => (t.config.name !== undefined && t.config.name.trim() !== "" ? t.config.name : t.key);

/** The World names a link can name: start-up Worlds, then Spawnable Worlds, without repeats. */
export function linkableNames(model: WorldsModel): string[] {
  return [...new Set([...model.worlds.map((w) => w.name), ...model.templates.map(spawnableName)])];
}

/** A connection the graph shows because a lobby makes it at runtime (ADR 0068), not a declared link. */
export interface ImpliedLink {
  from: string;
  to: string;
  label: string;
}

/**
 * The connections a World with `"lobby"` makes while the game runs, for the Worlds graph: every
 * start-up World that renders (where the menu runs) joins the lobby; the lobby creates match Worlds
 * from its `matchTemplate`; players' `clientTemplate` Worlds join them. Pairs a declared link already
 * covers, and templates that don't exist, are left out.
 */
export function lobbyLinks(model: WorldsModel): ImpliedLink[] {
  const out: ImpliedLink[] = [];
  const declared = new Set(model.links.map((l) => `${l.from}>${l.to}`));
  const push = (from: string, to: string, label: string) => {
    if (from === to || declared.has(`${from}>${to}`) || out.some((l) => l.from === from && l.to === to)) return;
    out.push({ from, to, label });
  };
  const template = (key: string | undefined) => (key ? model.templates.find((t) => t.key === key) : undefined);
  const lobbies = [
    ...model.worlds.map((w) => ({ name: w.name, lobby: w.lobby })),
    ...model.templates.map((t) => ({ name: spawnableName(t), lobby: t.config.lobby })),
  ].filter((l) => l.lobby);
  for (const { name, lobby } of lobbies) {
    model.worlds.forEach((w, i) => {
      const renders = w.renders ?? i === 0;
      if (renders && !w.lobby && !(w.tags ?? []).includes("server")) push(w.name, name, "joins lobby");
    });
    const match = template(lobby!.matchTemplate);
    if (!match) continue;
    push(name, spawnableName(match), "creates matches");
    const client = template(lobby!.clientTemplate);
    if (client) push(spawnableName(client), spawnableName(match), "joins match");
  }
  return out;
}

/** True if `name` is a Spawnable World's (and not a start-up World's), so its links apply when game code creates it. */
export const isSpawnableName = (model: WorldsModel, name: string): boolean => !model.worlds.some((w) => w.name === name) && model.templates.some((t) => spawnableName(t) === name);

/**
 * The scripts that mention a World by name in quotes (`"Server"`, `'Server'` or a template string),
 * for the panel's "Mentioned in". A plain text search, so a name held in a constant is found where
 * the constant is defined.
 */
export function mentions(scripts: readonly { path: string; text: string }[], names: string | readonly string[]): string[] {
  const quoted = (typeof names === "string" ? [names] : names).filter(Boolean).flatMap((n) => [`"${n}"`, `'${n}'`, `\`${n}\``]);
  if (!quoted.length) return [];
  return scripts.filter((s) => quoted.some((q) => s.text.includes(q))).map((s) => s.path);
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

/**
 * Rename a World or a Spawnable World (template). Links to and from it follow, including a
 * template's links when its World name is its key (ADR 0062).
 */
export function rename(model: WorldsModel, ref: WorldRef, name: string): WorldsModel {
  if (ref.kind === "template") {
    const entry = model.templates[ref.index];
    if (!entry || entry.key === name) return model;
    const renamed = { ...entry, key: name };
    const templates = model.templates.map((t, i) => (i === ref.index ? renamed : t));
    return { ...model, templates, links: followLinks(model, spawnableName(entry), spawnableName(renamed), (n) => model.worlds.some((w) => w.name === n) || model.templates.some((t, i) => i !== ref.index && spawnableName(t) === n)) };
  }
  const old = model.worlds[ref.index]?.name;
  if (old === undefined || old === name) return model;
  return {
    ...model,
    worlds: model.worlds.map((w, i) => (i === ref.index ? { ...w, name } : w)),
    // With two Worlds of the old name (an invalid draft), links keep pointing at the other.
    links: followLinks(model, old, name, (n) => model.worlds.some((w, i) => i !== ref.index && w.name === n)),
  };
}

/** Links naming `old` renamed to `name`, unless another World still has the old name (`shared`). */
function followLinks(model: WorldsModel, old: string, name: string, shared: (n: string) => boolean): LinkConfig[] {
  if (old === name || shared(old)) return model.links;
  const follow = (n: string) => (n === old ? name : n);
  return model.links.map((l) => (l.from === old || l.to === old ? { ...l, from: follow(l.from), to: follow(l.to) } : l));
}

/** Remove a World or a Spawnable World (template), and the links naming it. */
export function remove(model: WorldsModel, ref: WorldRef): WorldsModel {
  if (ref.kind === "template") {
    const entry = model.templates[ref.index];
    if (!entry) return model;
    const name = spawnableName(entry);
    const templates = model.templates.filter((_, i) => i !== ref.index);
    const shared = model.worlds.some((w) => w.name === name) || templates.some((t) => spawnableName(t) === name);
    return { ...model, templates, links: shared ? model.links : model.links.filter((l) => l.from !== name && l.to !== name) };
  }
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

// --- link options -------------------------------------------------------------------------------

/** One link option the panel knows how to edit; see `LinkConfig.options`. */
export interface LinkOptionInfo {
  key: string;
  label: string;
  kind: "number" | "string";
  /** What it does, with its default for the placeholder. */
  hint: string;
  /** Default shown as the placeholder (numbers). */
  default?: number;
  /** Only meaningful for these transports; absent means all. */
  transports?: readonly string[];
  /** Numbers must be whole. */
  integer?: boolean;
  /** Numbers must be at most this. */
  max?: number;
}

export const LINK_OPTIONS: readonly LinkOptionInfo[] = [
  { key: "address", label: "Address", kind: "string", hint: "Where the server listens. Loopback makes one up per Engine and server World." },
  { key: "port", label: "Port", kind: "number", hint: "The port a WebSocket server listens on (Node only).", transports: ["websocket"], integer: true, max: 65535 },
  { key: "url", label: "URL", kind: "string", hint: "Where a WebSocket client connects, such as ws://localhost:8080.", transports: ["websocket"] },
  { key: "path", label: "Path", kind: "string", hint: "The URL path the transport serves or connects to." },
  { key: "interpolationMs", label: "Interpolation", kind: "number", default: 100, hint: "The client's interpolation buffer in milliseconds (default 100)." },
  { key: "commandSlack", label: "Command slack", kind: "number", default: 2, hint: "Ticks a client's inputs run ahead of the server (default 2)." },
  { key: "handshakeTimeoutMs", label: "Handshake timeout", kind: "number", default: 5000, hint: "Milliseconds to wait for the connection handshake (default 5000)." },
  { key: "idleTimeoutMs", label: "Idle timeout", kind: "number", default: 15000, hint: "Milliseconds of silence before a connection is dropped (default 15000)." },
  { key: "maxConnections", label: "Max connections", kind: "number", default: 64, hint: "The server's connection cap (default 64).", integer: true },
  { key: "latencyMs", label: "Latency", kind: "number", hint: "Simulated one-way delay in milliseconds.", transports: ["loopback"] },
  { key: "jitterMs", label: "Jitter", kind: "number", hint: "Simulated random extra delay in milliseconds.", transports: ["loopback"] },
  { key: "loss", label: "Packet loss", kind: "number", hint: "Fraction of packets dropped, 0 to 1.", transports: ["loopback"], max: 1 },
];

/** The known options that apply to `transport`, in display order. */
export function linkOptionsFor(transport: string): LinkOptionInfo[] {
  return LINK_OPTIONS.filter((o) => !o.transports || o.transports.includes(transport));
}

/** Keys in a link's options that the panel has no input for on this transport (unknown keys, or ones of another transport). */
export function extraOptionKeys(link: LinkConfig): string[] {
  const shown = new Set(linkOptionsFor(link.transport).map((o) => o.key));
  return Object.keys(link.options ?? {}).filter((k) => !shown.has(k));
}

/** Problems with one link's option values (`where` is its location prefix, as `validateBootstrap` writes it). */
export function linkOptionProblems(link: LinkConfig, where: string): string[] {
  const out: string[] = [];
  const options = link.options;
  if (typeof options !== "object" || options === null || Array.isArray(options)) return out;
  for (const info of LINK_OPTIONS) {
    const v = options[info.key];
    if (v === undefined) continue;
    const at = `${where}: options.${info.key}`;
    if (info.kind === "string") {
      if (typeof v !== "string") out.push(`${at} must be text (got ${JSON.stringify(v)}).`);
    } else if (typeof v !== "number" || !Number.isFinite(v) || v < 0) {
      out.push(`${at} must be a number of 0 or more (got ${JSON.stringify(v)}).`);
    } else if (info.integer && !Number.isInteger(v)) {
      out.push(`${at} must be a whole number (got ${v}).`);
    } else if (info.max !== undefined && v > info.max) {
      out.push(`${at} must be at most ${info.max} (got ${v}).`);
    }
  }
  return out;
}

/**
 * Set (or with `undefined` / `""` remove) one of a link's options. Removing the last one removes `options`.
 * Other keys keep their values and order.
 */
export function setLinkOption(model: WorldsModel, index: number, key: string, value: unknown): WorldsModel {
  const link = model.links[index];
  if (!link) return model;
  const next: Record<string, unknown> = { ...link.options };
  if (value === undefined || value === "") delete next[key];
  else next[key] = value;
  const { options: _old, ...rest } = link;
  const updated: LinkConfig = Object.keys(next).length > 0 ? { ...rest, options: next } : rest;
  return { ...model, links: model.links.map((l, i) => (i === index ? updated : l)) };
}

/** Text for an unknown option's editable value: strings as-is, anything else as JSON. */
export function optionText(value: unknown): string {
  return typeof value === "string" ? value : JSON.stringify(value);
}

/** Parse an unknown option's text: JSON when it is (`5`, `true`, `[1]`), else the string itself. Empty is `undefined`. */
export function parseOptionText(text: string): unknown {
  const t = text.trim();
  if (t === "") return undefined;
  try {
    return JSON.parse(t);
  } catch {
    return t;
  }
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

  get canUndo(): boolean {
    return this.past.length > 0;
  }

  get canRedo(): boolean {
    return this.future.length > 0;
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

  /** Rewrite every state, past and future too, keeping the labels (a project section adopting a key, ADR 0151). */
  map(fn: (state: T) => T): void {
    this.current = fn(this.current);
    for (const list of [this.past, this.future]) for (const entry of list) entry.state = fn(entry.state);
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
  return withMember(text, "bootstrap", setting);
}

/**
 * A JSON object's text with its top-level `key` set to `setting` (or removed, for undefined), the
 * way `withBootstrap` sets `bootstrap`: every other key keeps its text exactly.
 */
export function withMember(text: string, key: string, setting: unknown): string {
  const nl = text.includes("\r\n") ? "\r\n" : "\n";
  const members = topLevelMembers(text);
  if (!members) {
    const json = JSON.parse(text) as Record<string, unknown>;
    return `${formatJsonValue({ ...json, [key]: setting })}\n`;
  }
  const first = members[0];
  const unit = first ? text.slice(text.lastIndexOf("\n", first.keyStart) + 1, first.keyStart) || "  " : "  ";
  const value = setting === undefined ? undefined : formatJsonValue(setting, unit, unit, nl);
  const at = members.findIndex((m) => m.key === key);
  if (at >= 0) {
    const m = members[at];
    if (value !== undefined) return text.slice(0, m.valueStart) + value + text.slice(m.valueEnd);
    if (at > 0) return text.slice(0, members[at - 1].valueEnd) + text.slice(m.valueEnd);
    const next = members[at + 1];
    return next ? text.slice(0, m.keyStart) + text.slice(next.keyStart) : text.slice(0, text.indexOf("{") + 1) + text.slice(text.lastIndexOf("}"));
  }
  if (value === undefined) return text;
  const entry = `${JSON.stringify(key)}: ${value}`;
  const last = members.at(-1);
  if (last) return `${text.slice(0, last.valueEnd)},${nl}${unit}${entry}${text.slice(last.valueEnd)}`;
  const close = text.lastIndexOf("}");
  return `${text.slice(0, close).trimEnd()}${nl}${unit}${entry}${nl}${text.slice(close)}`;
}

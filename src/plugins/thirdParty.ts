// Third-party plugins (ADR 0139): their `plugin.json` schema, SDK version ranges, discovery in the
// project (`plugins/<folder>/plugin.json`) and in its npm packages (`"myco": { "plugin": … }` in a
// package's package.json), the checks that run before any plugin code does, and which project code a
// host loads, as one plan (`planPluginCode`, ADR 0275). No file access and no editor imports (from
// the engine only the pure parses of a manifest's `audio` section, ADR 0352, and its `animationNodes`, ADR 0370): the
// editor, the exporter
// and the dedicated server each pass what they read and run the same plan against the same
// first-party catalogue, so all three agree on what loads.
import { parsePluginAudio } from "../engine/audio/effects/pluginEffects";
import type { PluginAudio } from "../engine/audio/effects/types";
import { parseAnimationNodes, type AnimationNodeModuleDecl } from "../engine/animation/pluginNodes";
import { FIRST_PARTY_MANIFESTS } from "./catalogue";
import { resolveEnabledPlugins } from "./enabled";
import type { PluginManifest } from "./manifest";
import { parseRange, parseVersion, satisfies } from "./semver";
import type { RuntimePlugin, RuntimePluginContext } from "./runtimeContext";

/**
 * The Myco SDK's version (ADR 0133, 0139): what a third-party plugin's `sdk` range is checked against.
 * The engine's version: keep in step with package.json's "version" (a test checks).
 */
export const SDK_VERSION = "1.0.0";

/** The static part of an asset kind (ADR 0133): enough for the Assets browser to recognise and label files without running plugin code. */
export interface PluginAssetKind {
  readonly id: string;
  /** Lower case, with the dot: [".spin.json"]. */
  readonly extensions: readonly string[];
  readonly label: string;
  /** An SVG path (`d`) in a 24×24 box. */
  readonly icon: string;
}

/** A third-party plugin's `plugin.json` (ADR 0139). */
export interface ThirdPartyManifest extends PluginManifest {
  /** The Myco SDK versions it works with: a semver range ("^1.0.0"). */
  readonly sdk: string;
  /** The runtime half's entry, relative to the plugin folder (or package). Outside `editor/` for a project plugin. */
  readonly runtime?: string;
  /** The editor half's entry, relative to the plugin folder (or package). Inside `editor/` for a project plugin. */
  readonly editor?: string;
  readonly assetKinds?: readonly PluginAssetKind[];
  /**
   * ADR 0352 §3: DSP effects as sandboxed wasm modules, read without running plugin code. With it, `runtime` and
   * `editor` are optional: a DSP-only plugin runs no JavaScript.
   */
  readonly audio?: PluginAudio;
  /**
   * ADR 0370 "Third-party graph and rig nodes" (T45t): animation graph and rig nodes as sandboxed wasm modules
   * (`[{ "module": "nodes/sway.wasm", "budget": 200000 }]`), read without running plugin code. Parsed leniently: a bad
   * entry is dropped and a bad budget takes the default, each with a line in the plugin's `warnings`.
   */
  readonly animationNodes?: readonly AnimationNodeModuleDecl[];
}

/** Where a plugin was found. */
export type PluginSource = { readonly kind: "project"; readonly folder: string } | { readonly kind: "npm"; readonly package: string };

/** A plugin found by `discoverPlugins`, with a valid manifest. */
export interface FoundPlugin {
  readonly manifest: ThirdPartyManifest;
  readonly source: PluginSource;
  /** The manifest file, project-relative ("plugins/spinner/plugin.json", "node_modules/acme-spin/plugin.json"). */
  readonly where: string;
  /** The runtime entry: a project path (project plugins) or a package specifier (npm plugins). */
  readonly runtime?: string;
  /** The editor entry, the same way. */
  readonly editor?: string;
  /** Problems that don't refuse the plugin (lenient sections such as `animationNodes`), each a line to show once. */
  readonly warnings?: readonly string[];
}

/** Why a plugin was refused. `plugin` is its name, or its manifest's path when the name is unknown. */
export interface PluginProblem {
  readonly plugin: string;
  readonly where: string;
  readonly message: string;
}

export { compareVersions, parseRange, parseVersion, satisfies } from "./semver";

// --- plugin.json ----------------------------------------------------------------------------------

/** Plugin names: lower case letters, digits, dots, dashes and underscores. `myco.` is first-party only. */
const NAME_RE = /^[a-z0-9][a-z0-9._-]*$/;

/**
 * Read a `plugin.json` value (ADR 0139). Returns the manifest, or null with every problem found.
 * Unknown keys are ignored.
 */
function parsePluginManifest(raw: unknown): { manifest: ThirdPartyManifest | null; problems: string[]; warnings: string[] } {
  const problems: string[] = [];
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return { manifest: null, problems: ["plugin.json must hold an object"], warnings: [] };
  const r = raw as Record<string, unknown>;
  const str = (key: string, required: boolean): string | undefined => {
    const value = r[key];
    if (value === undefined) {
      if (required) problems.push(`"${key}" is missing`);
      return undefined;
    }
    if (typeof value !== "string" || value.trim() === "") {
      problems.push(`"${key}" must be a non-empty string`);
      return undefined;
    }
    return value;
  };
  const name = str("name", true);
  if (name !== undefined && !NAME_RE.test(name)) problems.push(`"name" must be lower case letters, digits, ".", "-" and "_" (got "${name}")`);
  else if (name?.startsWith("myco.")) problems.push(`"name" can't start with "myco.": that prefix is for first-party plugins`);
  const version = str("version", true);
  if (version !== undefined && !parseVersion(version)) problems.push(`"version" must be a semver version such as 1.0.0 (got "${version}")`);
  const sdk = str("sdk", true);
  if (sdk !== undefined && !parseRange(sdk)) problems.push(`"sdk" must be a semver range such as ^1.0.0 (got "${sdk}")`);
  const title = str("title", false);
  const description = str("description", false);
  const entry = (key: "runtime" | "editor") => {
    const value = str(key, false);
    if (value !== undefined && (value.startsWith("/") || value.split("/").includes(".."))) {
      problems.push(`"${key}" must be a path inside the plugin (got "${value}")`);
      return undefined;
    }
    return value?.replace(/^\.\//, "");
  };
  const runtime = entry("runtime");
  const editor = entry("editor");
  if (r.runtime === undefined && r.editor === undefined && r.audio === undefined && r.animationNodes === undefined) problems.push(`a plugin needs a "runtime" or an "editor" entry, or an "audio" or "animationNodes" section`);
  // ADR 0370 (T45t): animation node modules, leniently: their problems are warnings, never a refusal.
  const nodes = parseAnimationNodes(r.animationNodes);
  // ADR 0352 §3: the `audio` section, once the name and version it is stamped with are known to be good.
  let audio: PluginAudio | undefined;
  if (r.audio !== undefined && name !== undefined && NAME_RE.test(name)) audio = parsePluginAudio(r.audio, { name, version: version ?? "", ...(title !== undefined && { title }) }, problems);
  /** `dependencies` and `optionalDependencies` (ADR 0374) share one shape: plugin names and semver ranges. */
  const dependencyMap = (key: "dependencies" | "optionalDependencies", label: string): Record<string, string> | undefined => {
    const value = r[key];
    if (value === undefined) return undefined;
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
      problems.push(`"${key}" must be an object of plugin names and version ranges`);
      return undefined;
    }
    const out: Record<string, string> = {};
    for (const [dep, range] of Object.entries(value as Record<string, unknown>)) {
      if (typeof range !== "string" || !parseRange(range)) problems.push(`${label} "${dep}" needs a semver range such as ^1.0.0 or *`);
      else out[dep] = range;
    }
    return out;
  };
  const dependencies = dependencyMap("dependencies", "dependency");
  const optionalDependencies = dependencyMap("optionalDependencies", "optional dependency");
  if (r.server !== undefined && typeof r.server !== "boolean") problems.push(`"server" must be true or false`);
  let assetKinds: PluginAssetKind[] | undefined;
  if (r.assetKinds !== undefined) {
    if (!Array.isArray(r.assetKinds)) problems.push(`"assetKinds" must be a list`);
    else {
      assetKinds = [];
      r.assetKinds.forEach((k: unknown, i) => {
        const at = `assetKinds[${i}]`;
        const kind = (typeof k === "object" && k !== null ? k : {}) as Record<string, unknown>;
        const bad = (field: string, what: string) => problems.push(`${at}: "${field}" ${what}`);
        if (typeof kind.id !== "string" || !kind.id) bad("id", "must be a non-empty string");
        if (typeof kind.label !== "string" || !kind.label) bad("label", "must be a non-empty string");
        if (typeof kind.icon !== "string" || !kind.icon) bad("icon", "must be an SVG path");
        const exts = kind.extensions;
        if (!Array.isArray(exts) || exts.length === 0 || !exts.every((e) => typeof e === "string" && /^\.[a-z0-9._-]+$/.test(e))) bad("extensions", 'must list lower-case endings with the dot, such as ".spin.json"');
        else if (typeof kind.id === "string" && typeof kind.label === "string" && typeof kind.icon === "string") assetKinds!.push({ id: kind.id, extensions: exts as string[], label: kind.label, icon: kind.icon });
      });
    }
  }
  // ADR 0447: the Add Component menu's submenus for the plugin's Components, leniently: menu labels never refuse a plugin.
  const categoryWarnings: string[] = [];
  let componentCategories: Record<string, string[]> | undefined;
  if (r.componentCategories !== undefined) {
    if (typeof r.componentCategories !== "object" || r.componentCategories === null || Array.isArray(r.componentCategories)) categoryWarnings.push(`"componentCategories" must be an object of submenu labels and Component type ids; ignored`);
    else {
      componentCategories = {};
      for (const [label, ids] of Object.entries(r.componentCategories as Record<string, unknown>)) {
        if (label.trim() !== "" && Array.isArray(ids) && ids.every((id) => typeof id === "string")) componentCategories[label] = ids as string[];
        else categoryWarnings.push(`componentCategories "${label}" must list Component type ids under a non-empty label; ignored`);
      }
    }
  }
  if (problems.length > 0) return { manifest: null, problems, warnings: [...nodes.problems, ...categoryWarnings] };
  const manifest: ThirdPartyManifest = {
    name: name!,
    version: version!,
    sdk: sdk!,
    ...(title !== undefined && { title }),
    ...(description !== undefined && { description }),
    ...(dependencies && { dependencies }),
    ...(optionalDependencies && { optionalDependencies }),
    ...(typeof r.server === "boolean" && { server: r.server }),
    ...(runtime !== undefined && { runtime }),
    ...(editor !== undefined && { editor }),
    ...(assetKinds && { assetKinds }),
    ...(audio && { audio }),
    ...(nodes.modules.length > 0 && { animationNodes: nodes.modules }),
    ...(componentCategories && Object.keys(componentCategories).length > 0 && { componentCategories }),
  };
  return { manifest, problems, warnings: [...nodes.problems, ...categoryWarnings] };
}

// --- discovery ------------------------------------------------------------------------------------

/** Read access to project files by project-relative path (null when missing); `PackageFiles` from packages.ts fits. */
export interface PluginFiles {
  read(path: string): Promise<string | null>;
}

interface DiscoverInput {
  /** The project's JSON files' text by path: `plugins/<folder>/plugin.json` and `package.json` come from here. */
  readonly json: ReadonlyMap<string, string>;
  /** The project's code paths (scripts and plugin sources, `isScriptPath`), to check entries exist. */
  readonly code: Iterable<string>;
  /** The project's other file paths, to check a project plugin's audio modules (`.wasm`) exist; absent: not checked. */
  readonly assets?: Iterable<string>;
  /** The project folder, for npm packages in `node_modules` (absent: no npm plugins). */
  readonly packages?: PluginFiles;
}

/** A project plugin's folder from a path inside it ("plugins/spinner/runtime/x.ts" → "plugins/spinner"), or null. */
export const pluginFolderOf = (path: string): string | null => /^(plugins\/[^/]+)\//.exec(path)?.[1] ?? null;

/**
 * ADR 0352 §8: where a plugin's audio module file (`audio.modules[].wasm`, relative to the plugin) is, project-relative:
 * `plugins/<folder>/<wasm>` for a project plugin, `node_modules/<package>/<wasm>` for an npm one.
 */
export function pluginModulePath(plugin: Pick<FoundPlugin, "source">, wasm: string): string {
  return plugin.source.kind === "project" ? `${plugin.source.folder}/${wasm}` : `node_modules/${plugin.source.package}/${wasm}`;
}

/** True for a file of a project plugin's editor half: `plugins/<folder>/editor/…` (ADR 0139). */
export const isEditorHalfPath = (path: string): boolean => /^plugins\/[^/]+\/editor\//.test(path);

const PLUGIN_JSON_RE = /^plugins\/[^/]+\/plugin\.json$/;

const parseJson = (text: string): { value: unknown } | { error: string } => {
  try {
    return { value: JSON.parse(text) as unknown };
  } catch (err) {
    return { error: err instanceof Error ? err.message : String(err) };
  }
};

/**
 * Find the project's third-party plugins (ADR 0139): `plugins/<folder>/plugin.json` files, then the
 * npm packages the project's package.json lists whose package.json has `"myco": { "plugin": "<path>" }`.
 * A manifest that doesn't parse or validate, or names an entry that isn't there, is a problem.
 */
async function discoverPlugins(input: DiscoverInput): Promise<{ plugins: FoundPlugin[]; problems: PluginProblem[] }> {
  const plugins: FoundPlugin[] = [];
  const problems: PluginProblem[] = [];
  const code = new Set(input.code);
  const assets = input.assets ? new Set(input.assets) : null;
  const refuse =(where: string, message: string, raw?: unknown) => {
    const name = typeof (raw as { name?: unknown })?.name === "string" ? (raw as { name: string }).name : where;
    problems.push({ plugin: name, where, message });
  };

  for (const where of [...input.json.keys()].filter((p) => PLUGIN_JSON_RE.test(p)).sort()) {
    const folder = where.slice(0, -"/plugin.json".length);
    const parsed = parseJson(input.json.get(where)!);
    if ("error" in parsed) {
      refuse(where, `plugin.json isn't valid JSON: ${parsed.error}`);
      continue;
    }
    const { manifest, problems: bad, warnings } = parsePluginManifest(parsed.value);
    if (!manifest) {
      refuse(where, bad.join("; "), parsed.value);
      continue;
    }
    const entryProblems: string[] = [];
    const entryPath = (key: "runtime" | "editor"): string | undefined => {
      const rel = manifest[key];
      if (rel === undefined) return undefined;
      const path = `${folder}/${rel}`;
      if (!/\.ts$/.test(rel) || /\.d\.ts$/.test(rel)) entryProblems.push(`its ${key} entry "${rel}" must be a .ts file`);
      else if (key === "editor" && !isEditorHalfPath(path)) entryProblems.push(`its editor entry "${rel}" must be inside the plugin's editor/ folder`);
      else if (key === "runtime" && isEditorHalfPath(path)) entryProblems.push(`its runtime entry "${rel}" can't be inside the editor/ folder, which only the editor loads`);
      else if (!code.has(path)) entryProblems.push(`its ${key} entry ${path} doesn't exist`);
      return path;
    };
    const runtime = entryPath("runtime");
    const editor = entryPath("editor");
    for (const m of manifest.audio?.modules ?? []) {
      if (assets && !assets.has(`${folder}/${m.wasm}`)) entryProblems.push(`its audio module ${m.id}'s file ${folder}/${m.wasm} doesn't exist`);
    }
    for (const m of manifest.animationNodes ?? []) {
      if (assets && !assets.has(`${folder}/${m.module}`)) warnings.push(`its animation node module ${folder}/${m.module} doesn't exist; its nodes pass their input through`);
    }
    if (entryProblems.length > 0) refuse(where, entryProblems.join("; "), manifest);
    else plugins.push({ manifest, source: { kind: "project", folder }, where, ...(runtime && { runtime }), ...(editor && { editor }), ...(warnings.length > 0 && { warnings }) });
  }

  const files = input.packages;
  if (!files) return { plugins, problems };
  const projectText = input.json.get("package.json") ?? (await files.read("package.json"));
  if (projectText === null || projectText === undefined) return { plugins, problems };
  const project = parseJson(projectText);
  if ("error" in project || typeof project.value !== "object" || project.value === null) return { plugins, problems };
  const { dependencies, devDependencies } = project.value as { dependencies?: Record<string, unknown>; devDependencies?: Record<string, unknown> };
  const names = [...new Set([...Object.keys(dependencies ?? {}), ...Object.keys(devDependencies ?? {})])].sort();
  for (const pkg of names) {
    const dir = `node_modules/${pkg}`;
    const text = await files.read(`${dir}/package.json`);
    if (text === null) continue; // not installed: npm's business, not a plugin problem
    const parsed = parseJson(text);
    if ("error" in parsed) continue;
    const marker = (parsed.value as { myco?: { plugin?: unknown } })?.myco?.plugin;
    if (marker === undefined) continue;
    if (typeof marker !== "string" || marker.startsWith("/") || marker.split("/").includes("..")) {
      refuse(`${dir}/package.json`, `"myco.plugin" must be the path of the plugin's manifest inside the package, such as "plugin.json"`);
      continue;
    }
    const where = `${dir}/${marker.replace(/^\.\//, "")}`;
    const manifestText = await files.read(where);
    if (manifestText === null) {
      refuse(where, `the package names ${marker} as its plugin manifest, but it isn't there`);
      continue;
    }
    const raw = parseJson(manifestText);
    if ("error" in raw) {
      refuse(where, `the manifest isn't valid JSON: ${raw.error}`);
      continue;
    }
    const { manifest, problems: bad, warnings } = parsePluginManifest(raw.value);
    if (!manifest) {
      refuse(where, bad.join("; "), raw.value);
      continue;
    }
    const missing: string[] = [];
    for (const key of ["runtime", "editor"] as const) {
      const rel = manifest[key];
      if (rel !== undefined && (await files.read(`${dir}/${rel}`)) === null) missing.push(`its ${key} entry ${dir}/${rel} doesn't exist`);
    }
    for (const m of manifest.audio?.modules ?? []) {
      if ((await files.read(`${dir}/${m.wasm}`)) === null) missing.push(`its audio module ${m.id}'s file ${dir}/${m.wasm} doesn't exist`);
    }
    if (missing.length > 0) refuse(where, missing.join("; "), manifest);
    else
      plugins.push({
        manifest,
        source: { kind: "npm", package: pkg },
        where,
        ...(manifest.runtime !== undefined && { runtime: `${pkg}/${manifest.runtime}` }),
        ...(manifest.editor !== undefined && { editor: `${pkg}/${manifest.editor}` }),
        ...(warnings.length > 0 && { warnings }),
      });
  }
  return { plugins, problems };
}

// --- checks and order -----------------------------------------------------------------------------

/**
 * The plugins that can load (ADR 0139), in dependency order, and why the others can't: a name taken
 * by a first-party plugin or an earlier one, an SDK range the engine doesn't meet, a missing or
 * mismatched dependency, a dependency cycle, or needing a plugin refused for any of these.
 * `builtIn` are the first-party manifests (they carry the engine's version).
 */
function checkPlugins(found: readonly FoundPlugin[], builtIn: readonly PluginManifest[]): { plugins: FoundPlugin[]; problems: PluginProblem[] } {
  const problems: PluginProblem[] = [];
  const refused = new Map<string, string>();
  const refuse = (p: FoundPlugin, message: string) => {
    refused.set(p.manifest.name, message);
    problems.push({ plugin: p.manifest.name, where: p.where, message });
  };
  const builtInByName = new Map(builtIn.map((m) => [m.name, m]));
  const byName = new Map<string, FoundPlugin>();
  for (const p of found) {
    const name = p.manifest.name;
    if (builtInByName.has(name)) problems.push({ plugin: name, where: p.where, message: `${name} is a first-party plugin's name` });
    else if (byName.has(name)) problems.push({ plugin: name, where: p.where, message: `another plugin named ${name} was found first, at ${byName.get(name)!.where}` });
    else byName.set(name, p);
  }
  // ADR 0352 §3: an audio effect type is unique across the project (the first plugin to declare it keeps it).
  const effectOwners = new Map<string, string>();
  for (const p of byName.values()) {
    const taken = (p.manifest.audio?.effects ?? []).map((e) => e.spec.type).find((t) => effectOwners.has(t));
    if (taken) refuse(p, `${p.manifest.name} declares the audio effect type ${taken}, which ${effectOwners.get(taken)} declares too`);
    else for (const e of p.manifest.audio?.effects ?? []) effectOwners.set(e.spec.type, p.manifest.name);
  }
  for (const p of byName.values()) {
    const { name, sdk } = p.manifest;
    if (refused.has(name)) continue;
    if (satisfies(SDK_VERSION, sdk) !== true) {
      refuse(p, `${name} needs Myco SDK ${sdk}; this is ${SDK_VERSION}`);
      continue;
    }
    for (const [dep, range] of Object.entries(p.manifest.dependencies ?? {})) {
      const target = builtInByName.get(dep) ?? byName.get(dep)?.manifest;
      if (!target) {
        refuse(p, `${name} needs the plugin ${dep}, which isn't installed`);
        break;
      }
      if (satisfies(target.version, range) !== true) {
        refuse(p, `${name} needs ${dep} ${range}; the installed one is ${target.version}`);
        break;
      }
    }
  }
  // Order the rest, dependencies first; cycles and dependents of refused plugins are refused too.
  const out: FoundPlugin[] = [];
  const state = new Map<string, "visiting" | "done">();
  const visit = (p: FoundPlugin, chain: string[]): boolean => {
    const name = p.manifest.name;
    if (state.get(name) === "done") return !refused.has(name);
    if (state.get(name) === "visiting") {
      const cycle = [...chain.slice(chain.indexOf(name)), name];
      for (const n of new Set(cycle)) if (!refused.has(n)) refuse(byName.get(n)!, `dependency cycle: ${cycle.join(" → ")}`);
      return false;
    }
    state.set(name, "visiting");
    let ok = !refused.has(name);
    // An optional dependency (ADR 0374) orders first and can't be a cycle, but its problems never refuse this plugin.
    for (const dep of Object.keys(p.manifest.optionalDependencies ?? {})) {
      const d = byName.get(dep);
      if (d) visit(d, [...chain, name]);
    }
    for (const dep of Object.keys(p.manifest.dependencies ?? {})) {
      const d = byName.get(dep);
      if (!d) continue; // first-party (or already refused as missing)
      if (!visit(d, [...chain, name]) && ok) {
        ok = false;
        if (!refused.has(name)) refuse(p, `${name} needs ${dep}, which has a problem`);
      }
    }
    state.set(name, "done");
    if (ok && !refused.has(name)) out.push(p);
    return ok && !refused.has(name);
  };
  for (const p of byName.values()) visit(p, []);
  return { plugins: out, problems };
}

// --- what loads -----------------------------------------------------------------------------------

export interface HalfOptions {
  /** Load editor halves too (the editor); off for game builds and the server. */
  readonly editor: boolean;
  /** The dedicated server: plugins whose manifest says `server: false` are left out. */
  readonly server?: boolean;
}

const included = (p: FoundPlugin, enabled: ReadonlySet<string>, options: HalfOptions) => enabled.has(p.manifest.name) && !(options.server && p.manifest.server === false);

/**
 * The project code a host loads (ADR 0139): every file under `scripts/`, plus the files of enabled
 * project plugins (without their `editor/` folder unless `options.editor`). Files of plugins that are
 * off, refused or skipped by the server are left out, so they never run.
 */
function selectPluginCode(code: ReadonlyMap<string, string>, plugins: readonly FoundPlugin[], enabled: ReadonlySet<string>, options: HalfOptions): Map<string, string> {
  const folders = new Set(plugins.filter((p) => p.source.kind === "project" && included(p, enabled, options)).map((p) => (p.source as { folder: string }).folder));
  const out = new Map<string, string>();
  for (const [path, text] of code) {
    const folder = pluginFolderOf(path);
    if (folder === null) out.set(path, text);
    else if (folders.has(folder) && (options.editor || !isEditorHalfPath(path))) out.set(path, text);
  }
  return out;
}

/** The npm plugin entries a host bundles (ADR 0139): the runtime entries of enabled npm plugins, and their editor entries with `options.editor`. */
function npmPluginEntries(plugins: readonly FoundPlugin[], enabled: ReadonlySet<string>, options: HalfOptions): string[] {
  const out: string[] = [];
  for (const p of plugins) {
    if (p.source.kind !== "npm" || !included(p, enabled, options)) continue;
    if (p.runtime) out.push(p.runtime);
    if (options.editor && p.editor) out.push(p.editor);
  }
  return out;
}

/** A half's entry module's `activate`: its own export, or a default export's (or the default export itself when it is a function). */
export function activateOf(module: Record<string, unknown>): ((context: never) => void) | undefined {
  const own = module.activate;
  if (typeof own === "function") return own as (context: never) => void;
  const def = module.default as { activate?: unknown } | ((context: never) => void) | undefined;
  if (typeof def === "function") return def;
  if (def && typeof def.activate === "function") return def.activate.bind(def) as (context: never) => void;
  return undefined;
}

/**
 * A third-party runtime half from its manifest, its entry (for the message) and the entry's loaded
 * module (ADR 0275); throws when the module exports no `activate`.
 */
export function toRuntimePlugin(manifest: ThirdPartyManifest, entry: string, module: Record<string, unknown>): RuntimePlugin {
  const activate = activateOf(module) as ((context: RuntimePluginContext) => void) | undefined;
  if (!activate) throw new Error(`${manifest.name}: its runtime entry (${entry}) exports no activate(context) function`);
  return { manifest, activate };
}

/** A game build's record of a third-party runtime half (ADR 0139): its manifest and the module to import. */
export interface BuiltPlugin {
  readonly manifest: ThirdPartyManifest;
  /** The compiled entry's path in the build. */
  readonly module: string;
}

/** What a host loads of a project (ADR 0139, 0275): `planPluginCode`'s result. */
export interface PluginCodePlan {
  /** Every third-party plugin found with a valid manifest, refused ones included. */
  readonly found: FoundPlugin[];
  /** Every plugin that can load (enabled or not), in dependency order. */
  readonly plugins: FoundPlugin[];
  /** The enabled plugins this host loads code for (both halves' with `editor`), in dependency order. */
  readonly loaded: FoundPlugin[];
  /** Of `loaded`, the ones with a runtime half, which the host activates. */
  readonly runtime: FoundPlugin[];
  /** Enabled plugin names, first-party ones included. */
  readonly enabled: Set<string>;
  /** The scripts plus the enabled plugins' files the host compiles. */
  readonly code: Map<string, string>;
  /** npm plugin entries to bundle. */
  readonly npmEntries: string[];
  /** Why plugins were refused (bad manifests, a discovery that failed, SDK or dependency mismatches). */
  readonly problems: PluginProblem[];
}

/**
 * The one plan of what a host loads of a project (ADR 0139, 0275): discover its plugins, check them
 * against the first-party catalogue, resolve which are enabled, and select their code. The editor
 * (`editor: true`, on every load and reload), game builds and the dedicated server (`server: true`)
 * all plan with it. `code` is the project's scripts and plugin sources, `disabled` its
 * `plugins.disabled`. Never throws: a discovery that fails is a problem.
 */
export async function planPluginCode(
  input: {
    readonly json: ReadonlyMap<string, string>;
    readonly code: ReadonlyMap<string, string>;
    readonly packages?: PluginFiles;
    readonly disabled?: Iterable<string>;
    /** The project's other file paths: a project plugin's audio modules must be among them (absent: not checked). */
    readonly assets?: Iterable<string>;
  },
  options: HalfOptions,
): Promise<PluginCodePlan> {
  let found: { plugins: FoundPlugin[]; problems: PluginProblem[] };
  try {
    found = await discoverPlugins({ json: input.json, code: input.code.keys(), packages: input.packages, ...(input.assets && { assets: input.assets }) });
  } catch (err) {
    found = { plugins: [], problems: [{ plugin: "(plugins)", where: "plugins/", message: `couldn't look for plugins: ${err instanceof Error ? err.message : String(err)}` }] };
  }
  const checked = checkPlugins(found.plugins, FIRST_PARTY_MANIFESTS);
  const enabled = resolveEnabledPlugins([...FIRST_PARTY_MANIFESTS, ...checked.plugins.map((p) => p.manifest)], input.disabled);
  const loaded = checked.plugins.filter((p) => included(p, enabled, options));
  return {
    found: found.plugins,
    plugins: checked.plugins,
    loaded,
    runtime: loaded.filter((p) => p.runtime !== undefined),
    enabled,
    code: selectPluginCode(input.code, checked.plugins, enabled, options),
    npmEntries: npmPluginEntries(checked.plugins, enabled, options),
    problems: [...found.problems, ...checked.problems],
  };
}

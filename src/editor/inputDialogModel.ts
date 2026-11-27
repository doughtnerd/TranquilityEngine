// The Input dialog's model (ADR 0433), over every action set and context at once: the left list's entries (asset
// sets, code sets read-only, contexts with `default` first among equals), where each action is mapped, which actions
// no context maps, an action's type change or rename carried into every context, the default context's mappings that
// come from scripts, and which scene nodes turn a context on. Pure: the dialog hands it the files and the engine's sets.
import type { ActionSetFile } from "../engine/input/actionAssets";
import type { ActionKind } from "../engine/input/actions";
import { DEFAULT_CONTEXT, DEFAULT_CONTEXT_PATH } from "../engine/input/contexts";
import type { InputContextSpec, MappingSpec } from "../engine/input/contextTypes";
import type { InputActionSetInfo } from "../engine/editor";
import type { NodeEntry } from "../engine/scene/SceneLoader";
import { convertMapping, mapMappingRefs, mappingControls, refersTo, renameMappingAction, resolveActionRef, type ActionRef } from "./inputContextModel";

export { DEFAULT_CONTEXT_PATH };

/** An action set in the list: an asset (editable) or defined in code (read-only). */
export interface SetEntry {
  readonly id: string;
  /** The file, for an asset set. */
  readonly path?: string;
  readonly source: "asset" | "code";
  readonly actions: readonly { readonly name: string; readonly kind: ActionKind; readonly consume?: boolean }[];
  /** A script and an asset both define the id (ADR 0433): shown on both entries. */
  readonly clash: boolean;
  /** The asset's value. */
  readonly spec?: ActionSetFile;
}

/** A context in the list: a `*.input.json` file. */
export interface ContextEntry {
  readonly path: string;
  /** Its name (its path when it has none). */
  readonly name: string;
  readonly spec: InputContextSpec;
  /** The default context: can't be renamed or deleted. */
  readonly isDefault: boolean;
}

const KINDS: readonly ActionKind[] = ["button", "axis", "vec2", "vec3"];

/**
 * The list's sets, A to Z by id: every asset file (whether or not it's loaded), then each set the engine has that no
 * file defines (code sets, the engine's own). An id both a file and a code set define is flagged on both: the
 * engine's record of the clash (`clash`), or a code set beside a file not loaded yet.
 */
export function setEntries(assets: readonly { path: string; spec: ActionSetFile }[], engine: readonly InputActionSetInfo[]): SetEntry[] {
  const assetIds = new Set(assets.map((a) => a.spec.id));
  const engineClash = new Set(engine.filter((s) => s.clash).map((s) => s.id));
  const codeIds = new Set(engine.filter((s) => s.source !== "asset").map((s) => s.id));
  const fromFiles: SetEntry[] = assets.map((a) => ({
    id: a.spec.id,
    path: a.path,
    source: "asset",
    actions: a.spec.actions.filter((x) => KINDS.includes(x.type)).map((x) => ({ name: x.name, kind: x.type, ...(x.consume !== undefined ? { consume: x.consume } : {}) })),
    clash: engineClash.has(a.spec.id) || codeIds.has(a.spec.id),
    spec: a.spec,
  }));
  const fromCode: SetEntry[] = engine
    .filter((s) => !assetIds.has(s.id))
    .map((s) => ({ id: s.id, source: "code", actions: s.actions.map((a) => ({ name: a.name, kind: a.kind, ...(a.consume !== undefined ? { consume: a.consume } : {}) })), clash: false }));
  // A code set whose id a file also defines is listed once more, read-only, so the clash shows on both entries.
  const shadowed: SetEntry[] = engine
    .filter((s) => assetIds.has(s.id) && (s.clash || s.source !== "asset"))
    .map((s) => ({ id: s.id, source: "code", actions: s.source === "code" ? s.actions.map((a) => ({ name: a.name, kind: a.kind })) : [], clash: true }));
  return [...fromFiles, ...fromCode, ...shadowed].sort((a, b) => a.id.localeCompare(b.id) || (a.source === "asset" ? -1 : 1));
}

/** The sets as the action helpers read them (`InputActionSetInfo`), each id once (an asset over a code set). */
export function setInfos(sets: readonly SetEntry[]): InputActionSetInfo[] {
  const seen = new Set<string>();
  const out: InputActionSetInfo[] = [];
  for (const s of [...sets].sort((a, b) => (a.source === b.source ? 0 : a.source === "asset" ? -1 : 1))) {
    if (seen.has(s.id)) continue;
    seen.add(s.id);
    out.push({ id: s.id, actions: s.actions, source: s.source });
  }
  return out;
}

/** The list's contexts, A to Z by name. */
export function contextEntries(files: readonly { path: string; spec: InputContextSpec }[]): ContextEntry[] {
  return files
    .map((f) => ({ path: f.path, name: f.spec.name.trim() || f.path, spec: f.spec, isDefault: f.path === DEFAULT_CONTEXT_PATH }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * The default context's mappings from scripts: each code set's inline defaults (ADR 0336), shown read-only in
 * `default`, marked "from a script". Asset sets have none.
 */
export function scriptMappings(engine: readonly InputActionSetInfo[]): { set: string; mapping: MappingSpec }[] {
  return engine.filter((s) => s.source !== "asset").flatMap((s) => s.actions.flatMap((a) => (a.defaults ?? []).map((mapping) => ({ set: s.id, mapping }))));
}

/** Where an action is mapped: a context, the mapping's index there (-1 for a script's), and its controls. */
export interface MappedIn {
  readonly path: string;
  readonly context: string;
  readonly index: number;
  readonly controls: readonly string[];
  /** A code set's inline default, shown in `default`. */
  readonly fromScript?: boolean;
}

const keyOf = (r: ActionRef) => `${r.set}:${r.name}`;

/** Every mapping by the action it names (`set:name`), across the contexts and the scripts' defaults. */
export function mappedIn(contexts: readonly ContextEntry[], sets: readonly InputActionSetInfo[], scripts: readonly { mapping: MappingSpec }[] = []): Map<string, MappedIn[]> {
  const out = new Map<string, MappedIn[]>();
  const add = (ref: ActionRef | null, entry: MappedIn) => {
    if (!ref) return;
    const k = keyOf(ref);
    let list = out.get(k);
    if (!list) out.set(k, (list = []));
    list.push(entry);
  };
  for (const c of contexts) c.spec.mappings.forEach((m, i) => add(resolveActionRef(m.action, sets), { path: c.path, context: c.name, index: i, controls: mappingControls(m) }));
  const def = contexts.find((c) => c.isDefault);
  for (const s of scripts) add(resolveActionRef(s.mapping.action, sets), { path: def?.path ?? DEFAULT_CONTEXT_PATH, context: DEFAULT_CONTEXT, index: -1, controls: mappingControls(s.mapping), fromScript: true });
  return out;
}

/** The actions of `set` no context (nor script default) maps: nothing triggers them. */
export function unmappedActions(set: SetEntry, mapped: ReadonlyMap<string, readonly MappedIn[]>): string[] {
  return set.actions.filter((a) => !(mapped.get(`${set.id}:${a.name}`)?.length)).map((a) => a.name);
}

/** The default context with an empty mapping for `ref` added at the end (the "Map it in default" button). */
export const mapInDefault = (spec: InputContextSpec, ref: string): InputContextSpec => ({ ...spec, mappings: [...spec.mappings, { action: ref, control: "" }] });

/** A context changed by an action edit, and what changed in it, in words. */
export interface ContextChange {
  readonly path: string;
  readonly spec: InputContextSpec;
  readonly notes: readonly string[];
}

/** Every context's mappings of `target` converted from `from` to `to` (`convertMapping`); only the contexts that changed. */
export function retypeInContexts(contexts: readonly ContextEntry[], target: ActionRef, from: ActionKind, to: ActionKind, sets: readonly InputActionSetInfo[]): ContextChange[] {
  const out: ContextChange[] = [];
  for (const c of contexts) {
    const notes: string[] = [];
    let changed = false;
    const mappings = c.spec.mappings.map((m, i) => {
      if (!refersTo(m.action, target, sets)) return m;
      const { mapping, note } = convertMapping(m, from, to);
      if (note) notes.push(`${c.name}, mapping ${i + 1}: ${note}`);
      if (mapping !== m) changed = true;
      return mapping;
    });
    if (changed) out.push({ path: c.path, spec: { ...c.spec, mappings }, notes });
  }
  return out;
}

/** Every context's references to `target` renamed to `to` (mappings, chords and combos); only the contexts that changed. */
export function renameInContexts(contexts: readonly ContextEntry[], target: ActionRef, to: string, sets: readonly InputActionSetInfo[]): ContextChange[] {
  const out: ContextChange[] = [];
  for (const c of contexts) {
    const mappings = c.spec.mappings.map((m) => renameMappingAction(m, target, to, sets));
    if (mappings.some((m, i) => m !== c.spec.mappings[i])) out.push({ path: c.path, spec: { ...c.spec, mappings }, notes: [] });
  }
  return out;
}

/** Every context's qualified references to set `from` (`from:name`) made to name `to` instead; only the contexts that changed. */
export function renameSetInContexts(contexts: readonly ContextEntry[], from: string, to: string): ContextChange[] {
  const prefix = `${from}:`;
  const out: ContextChange[] = [];
  for (const c of contexts) {
    const mappings = c.spec.mappings.map((m) => mapMappingRefs(m, (ref) => (ref.startsWith(prefix) ? `${to}:${ref.slice(prefix.length)}` : ref)));
    if (mappings.some((m, i) => m !== c.spec.mappings[i])) out.push({ path: c.path, spec: { ...c.spec, mappings }, notes: [] });
  }
  return out;
}

/** A node whose InputContext turns a context on. */
export interface ContextUser {
  /** The scene or prefab file. */
  readonly file: string;
  readonly node: string;
  readonly priority: number;
}

/** InputContext's priority when a node doesn't set it (`InputContext.priority`). */
const DEFAULT_PRIORITY = 10;

/**
 * The nodes in scene and prefab files whose `engine.InputContext` names `context` (its path or its name), with their
 * priority: from the files as given (the open scene's unsaved document in place of its file). Prefab instances'
 * overrides of `context` aren't followed: a node counts where its own component names the context.
 */
export function contextUsers(context: ContextEntry, files: readonly { path: string; nodes: readonly NodeEntry[] }[]): ContextUser[] {
  const names = new Set([context.path, context.spec.name].filter(Boolean));
  const out: ContextUser[] = [];
  for (const f of files) {
    for (const n of f.nodes) {
      for (const c of n.components ?? []) {
        if (c.type !== "engine.InputContext" || !names.has(String(c.data?.context ?? ""))) continue;
        const p = c.data?.priority;
        out.push({ file: f.path, node: n.name ?? n.id, priority: typeof p === "number" ? p : DEFAULT_PRIORITY });
      }
    }
  }
  return out.sort((a, b) => b.priority - a.priority || a.node.localeCompare(b.node));
}

/** `base`, or `base 2`, `base 3`…: a name none of `taken` has. */
export function freeName(base: string, taken: readonly string[]): string {
  if (!taken.includes(base)) return base;
  for (let n = 2; ; n++) if (!taken.includes(`${base} ${n}`)) return `${base} ${n}`;
}

/** `game.New`, `game.New2`…: an id no set has. */
export function freeSetId(taken: readonly string[], base = "game.New"): string {
  if (!taken.includes(base)) return base;
  for (let n = 2; ; n++) if (!taken.includes(`${base}${n}`)) return `${base}${n}`;
}

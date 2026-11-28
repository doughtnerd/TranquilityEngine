/**
 * Input contexts (ADR 0336): bindings as data, switched on by a component on a node.
 *
 * - A context is a `*.input.json` asset (`InputContextSpec`) or one registered in code with
 *   `defineInputContext`. The **default context** is `input/default.input.json` (ADR 0433) plus the code
 *   sets' inline defaults (`button("<Keyboard>/space")`), and is always active for every player, at priority 0.
 * - `InputContext` on a node switches a context on while the node is active in the hierarchy, at
 *   its priority, for one player: a vehicle prefab carries `InputContext(vehicle, 10)`, a pause
 *   menu its `menu` context. Nothing is pushed or popped by hand.
 */
import { Component } from "../core/Component";
import { component, field } from "../core/registry";
import type { World } from "../core/World";
import { Assets } from "../scene/Assets";
import { actionSets, actionSetsVersion } from "./actions";
import { triggersVersion } from "./triggers";
import type { InputContextSpec, MappingSpec } from "./contextTypes";

export type { InputContextSpec, MappingSpec, ModifierSpec, TriggerSpec, TriggerType } from "./contextTypes";

/** The name of the default context: `input/default.input.json` and the code sets' inline defaults. */
export const DEFAULT_CONTEXT = "default";

/** The default context's file (ADR 0433): every project has one; it holds each action's everyday controls. */
export const DEFAULT_CONTEXT_PATH = "input/default.input.json";

const registered = new Map<string, InputContextSpec>();
/** Bumped when contexts are registered or a context asset changes: compiled tables rebuild. */
let contextsVersion = 0;

Assets.onChanged((path) => {
  if (path.endsWith(".input.json")) contextsVersion++;
});

/** @internal Rebuild-when-changed key for compiled tables: contexts, assets, action sets and custom triggers. */
export function bindingsVersion(): string {
  return `${contextsVersion}.${actionSetsVersion()}.${triggersVersion()}`;
}

/**
 * Register a context in code, under its name. `InputContext.context` names it (or names a
 * `*.input.json` asset path). Registering a name again replaces it.
 */
export function defineInputContext(spec: InputContextSpec): InputContextSpec {
  if (typeof spec?.name !== "string" || !spec.name.trim()) throw new Error("defineInputContext: the context needs a name.");
  if (spec.name === DEFAULT_CONTEXT) throw new Error(`defineInputContext: "${DEFAULT_CONTEXT}" is the context of the actions' inline defaults; give yours another name.`);
  if (!Array.isArray(spec.mappings)) throw new Error(`defineInputContext("${spec.name}"): mappings must be a list.`);
  registered.set(spec.name, spec);
  contextsVersion++;
  return spec;
}

let defaultCache: { version: string; spec: InputContextSpec } | null = null;

/**
 * The default context: the mappings of `input/default.input.json` (ADR 0433), then every code set's inline
 * defaults (ADR 0336).
 */
export function defaultContext(): InputContextSpec {
  const version = `${contextsVersion}.${actionSetsVersion()}`;
  if (defaultCache?.version === version) return defaultCache.spec;
  const mappings: MappingSpec[] = [];
  if (Assets.has(DEFAULT_CONTEXT_PATH)) {
    const raw = Assets.json<Partial<InputContextSpec>>(DEFAULT_CONTEXT_PATH);
    if (raw && typeof raw === "object" && Array.isArray(raw.mappings)) mappings.push(...raw.mappings);
  }
  for (const set of actionSets()) {
    for (const a of set.actions) {
      for (const d of a.type.defaults) {
        const action = `${set.id}:${a.name}`;
        mappings.push(typeof d === "string" ? { action, control: d } : { ...d, action });
      }
    }
  }
  defaultCache = { version, spec: { name: DEFAULT_CONTEXT, mappings } };
  return defaultCache.spec;
}

/**
 * The context `ref` names: the default context, a registered one, or a `*.input.json` asset
 * (a context asset without a name takes its path). Null when there's none.
 */
export function resolveContext(ref: string): InputContextSpec | null {
  if (ref === DEFAULT_CONTEXT || ref === DEFAULT_CONTEXT_PATH) return defaultContext();
  const known = registered.get(ref);
  if (known) return known;
  if (ref.endsWith(".json") && Assets.has(ref)) {
    const raw = Assets.json<Partial<InputContextSpec>>(ref);
    if (raw && typeof raw === "object" && Array.isArray(raw.mappings)) return { name: typeof raw.name === "string" && raw.name ? raw.name : ref, mappings: raw.mappings };
  }
  return null;
}

/** @internal The names of the contexts registered with `defineInputContext`. */
export function registeredContexts(): string[] {
  return [...registered.keys()];
}

/** Active `InputContext` components, by World, in activation order. */
const active = new WeakMap<World, Set<InputContext>>();

/** @internal The World's active InputContext components. */
export function activeContexts(world: World): ReadonlySet<InputContext> {
  return active.get(world) ?? EMPTY;
}

const EMPTY: ReadonlySet<InputContext> = new Set();

/** A context an engine source switches on for a player, without a node (`addContextSource`). */
export interface SourcedContext {
  readonly context: string;
  readonly priority: number;
}

/** Engine-provided contexts: called per player at each evaluation (the UI's `ui` context, ADR 0340). */
export type ContextSource = (world: World, player: number) => readonly SourcedContext[];

const sources: ContextSource[] = [];

/** @internal Switch contexts on from engine state rather than an `InputContext` node: `source` names those active for a player now. */
export function addContextSource(source: ContextSource): void {
  sources.push(source);
}

/** @internal The contexts engine sources switch on for player `index` now. */
export function sourcedContexts(world: World, index: number): SourcedContext[] {
  return sources.flatMap((s) => s(world, index));
}

/**
 * Switches an input context on while its node is active in the hierarchy (ADR 0336), at
 * `priority`, for one player. Higher priorities are evaluated first, and a performing mapping
 * there hides its controls from lower ones. Its fields are read every frame, so changing them
 * (from code or the inspector) takes effect at the next evaluation.
 */
@component("engine.InputContext")
export class InputContext extends Component {
  /** A context registered with `defineInputContext`, or a `*.input.json` asset path. */
  @field(String) context = "";
  /** Higher runs first and consumes the controls it uses. The default context is at 0. */
  @field(Number) priority = 10;
  /** The player's index; -1: the player controlling this node (the nearest `ControlledBy` up the hierarchy), else player 0. */
  @field(Number) player = -1;

  /** @internal */
  override _onActivate(): void {
    let set = active.get(this._world);
    if (!set) active.set(this._world, (set = new Set()));
    set.add(this);
  }

  /** @internal */
  override _onDeactivate(): void {
    active.get(this._world)?.delete(this);
  }
}

/**
 * World services (ADR 0135): lazily loaded per-World subsystems (physics 2D, physics 3D, navigation)
 * whose lifecycle the engine runs once, for every service:
 * - each service's code loads once per page (`load`, a dynamic import), and is tried again after a
 *   failed load;
 * - a World starts a service when a scene that needs it loads (`_startWorldServicesForScene`), or when a
 *   Component that needs it attaches (`_onComponentAttached`);
 * - a load that finishes after its World was torn down starts nothing;
 * - a World's services are disposed in reverse start order when it is torn down (`_disposeWorldServices`).
 *
 * Plugins register services through their runtime context (`registerWorldService`). Other plugins reach
 * one through a typed key (`defineWorldService`, `worldService`) for optional coupling (ADR 0133).
 */
import { layerGroups } from "../physics/layers";
import type { GameObject } from "../scene/GameObject";
import { getComponentId, type ComponentClass } from "./registry";
import type { World } from "./World";
import type { WorldHandle, WorldTag } from "./worlds";

/** @internal What makes a World need a service. Any one is enough. */
export interface WorldServiceNeeds {
  /** Component type ids (`engine.RigidBody`): a scene with one, or one attaching, starts it. */
  readonly components?: readonly string[];
  /** Scene settings (`{ physics: "2d" }`): a scene whose settings have every one of these values starts it. */
  readonly sceneSetting?: Readonly<Record<string, unknown>>;
  /** World tags: a scene loading into a World with any of them starts it. */
  readonly worldTags?: readonly WorldTag[];
  /** Any other test of a scene file being loaded (its path). */
  scene?(path: string): boolean;
  /**
   * Scene settings under which a scene's Components don't start it (`{ physics: ["2d", "none"] }`: a scene
   * that chose another physics dimension). A Component attaching later still does.
   */
  readonly exceptSceneSetting?: Readonly<Record<string, readonly unknown[]>>;
}

/** @internal A ray hit a service answers for core code (particle collisions) that mustn't know which plugin answers. */
export interface WorldRayHit {
  readonly point: { readonly x: number; readonly y: number; readonly z: number };
  readonly normal: { readonly x: number; readonly y: number; readonly z: number };
  readonly distance: number;
}

/**
 * @internal The reused result of `raycastInto` (ADR 0162, C14). The caller allocates it once; a hit
 * writes `node`, `distance` and `point` into it, a miss leaves it untouched.
 */
export interface WorldRayInto {
  /** The node that owns the collider hit. */
  node: GameObject | null;
  distance: number;
  point: { x: number; y: number; z: number };
}

/** @internal What `raycastInto` may hit (ADR 0162, C14). The caller reuses one query object across calls. */
export interface WorldRayQuery {
  /** Which colliders can be hit: `rayGroupsFor(world, layers)`, computed when settings change; undefined: every layer. */
  groups: number | undefined;
  /** Colliders on these nodes are never hit (the source's subtree, the listener's node); tested inside the query. */
  excludeNodes: ReadonlySet<GameObject>;
  /** Sensors (trigger colliders) never hit. */
  includeSensors: false;
}

/** @internal A lazily loaded per-World subsystem (ADR 0135). `L` is what `load` gives, `I` one World's instance. */
export interface WorldServiceDef<L = unknown, I = unknown> {
  /** Unique, e.g. `myco.physics3d`. */
  readonly id: string;
  /**
   * Loads the service's code (a dynamic import, so it stays out of the main chunk). Called once per page
   * (per variant), again after a failure.
   */
  load(variant: string): Promise<L>;
  /**
   * Which build of the service `world` uses, when there are several (physics: the backend the project
   * chose, ADR 0137). Each variant loads once. Default: one, `""`.
   */
  variant?(world: World): string;
  /** One World's instance. */
  create(world: World, loaded: L): I;
  dispose(instance: I): void;
  readonly neededBy: WorldServiceNeeds;
  /** Whether `world` runs this service at all. Default: every World but the editor's (play mode runs its own Engine). */
  runsIn?(world: World): boolean;
  /** Scene loading: what to fetch before a scene that needs the service is instantiated (navigation's baked chunks), alongside the start. */
  prepareScene?(world: World, path: string): Promise<void>;
  /** Each rendered frame, after the fixed steps: `alpha` is how far real time is between the last two fixed steps (ADR 0093). */
  interpolate?(instance: I, alpha: number): void;
  /** A world-space 3D ray query (`dir` need not be unit length), for core code such as particle collisions. */
  raycast?(instance: I, origin: { x: number; y: number; z: number }, dir: { x: number; y: number; z: number }, maxDistance: number): WorldRayHit | null;
  /** The allocation-free ray query behind `raycastInto` (ADR 0162, C14): the first hit that isn't excluded, written into `out`. */
  raycastInto?(instance: I, out: WorldRayInto, origin: { x: number; y: number; z: number }, dir: { x: number; y: number; z: number }, maxDistance: number, query: WorldRayQuery): boolean;
}

interface Load {
  loading: Promise<unknown> | null;
  loaded: { value: unknown } | null;
}

interface Entry {
  readonly def: WorldServiceDef;
  /** By variant. */
  readonly loads: Map<string, Load>;
}

interface WorldState {
  readonly instances: Map<string, unknown>;
  /** Service ids in start order. */
  readonly order: string[];
  readonly starting: Map<string, Promise<unknown>>;
  destroyed: boolean;
}

const services = new Map<string, Entry>();
/** Component type id → the services it needs. */
const byComponent = new Map<string, string[]>();
const states = new WeakMap<World, WorldState>();
/** Worlds with a running service, so unregistering a service can dispose its instances. */
const live = new Set<World>();

function reindex(): void {
  byComponent.clear();
  for (const { def } of services.values()) {
    for (const type of def.neededBy.components ?? []) {
      const list = byComponent.get(type);
      if (list) list.push(def.id);
      else byComponent.set(type, [def.id]);
    }
  }
}

function stateOf(world: World): WorldState {
  let s = states.get(world);
  if (!s) states.set(world, (s = { instances: new Map(), order: [], starting: new Map(), destroyed: false }));
  return s;
}

const runs = (def: WorldServiceDef, world: World) => (def.runsIn ? def.runsIn(world) : world.kind !== "editor");

/**
 * @internal Add a service. Returns a function that removes it again, disposing its instance in every
 * World running it.
 */
export function _registerWorldService<L, I>(def: WorldServiceDef<L, I>): () => void {
  if (services.has(def.id)) throw new Error(`World service "${def.id}" is already registered.`);
  const entry: Entry = { def: def as WorldServiceDef, loads: new Map() };
  services.set(def.id, entry);
  reindex();
  return () => {
    if (services.get(def.id) !== entry) return;
    services.delete(def.id);
    reindex();
    for (const world of [...live]) {
      const s = states.get(world);
      if (!s?.instances.has(def.id)) continue;
      const instance = s.instances.get(def.id);
      s.instances.delete(def.id);
      s.order.splice(s.order.indexOf(def.id), 1);
      disposeOne(def as WorldServiceDef, instance);
      if (s.instances.size === 0) live.delete(world);
    }
  };
}

/** @internal Ids of the registered services, in registration order. */
export function _worldServiceIds(): string[] {
  return [...services.keys()];
}

function loadOf(entry: Entry, variant: string): Load {
  let l = entry.loads.get(variant);
  if (!l) entry.loads.set(variant, (l = { loading: null, loaded: null }));
  return l;
}

function load(entry: Entry, variant: string): Promise<unknown> {
  const l = loadOf(entry, variant);
  l.loading ??= entry.def.load(variant).then(
    (value) => {
      l.loaded = { value };
      return value;
    },
    (err: unknown) => {
      l.loading = null; // a failed fetch or WASM start is tried again next time
      throw err;
    },
  );
  return l.loading;
}

function create(world: World, s: WorldState, entry: Entry, loaded: unknown): unknown {
  const id = entry.def.id;
  if (s.instances.has(id)) return s.instances.get(id);
  const instance = entry.def.create(world, loaded);
  s.instances.set(id, instance);
  s.order.push(id);
  live.add(world);
  return instance;
}

function disposeOne(def: WorldServiceDef, instance: unknown): void {
  try {
    def.dispose(instance);
  } catch (err) {
    console.error(`[myco] World service "${def.id}" failed to dispose:`, err);
  }
}

/**
 * @internal Start service `id` in `world` (loading it first if needed). Resolves with the instance, or
 * null when the World doesn't run it, was torn down before the load finished, or the service was
 * unregistered meanwhile. Rejects when the load fails (the next start tries again). Once the service has
 * loaded, the instance is created at once, before this returns.
 */
export function _startWorldService(world: World, id: string): Promise<unknown> {
  const entry = services.get(id);
  if (!entry) return Promise.reject(new Error(`Unknown World service "${id}".`));
  const s = stateOf(world);
  if (s.destroyed || !runs(entry.def, world)) return Promise.resolve(null);
  if (s.instances.has(id)) return Promise.resolve(s.instances.get(id));
  const variant = entry.def.variant?.(world) ?? "";
  const loaded = loadOf(entry, variant).loaded;
  if (loaded) return Promise.resolve(create(world, s, entry, loaded.value));
  const pending = s.starting.get(id);
  if (pending) return pending;
  const p = load(entry, variant).then((loaded) => (s.destroyed || services.get(id) !== entry ? null : create(world, s, entry, loaded)));
  s.starting.set(id, p);
  const clear = () => void (s.starting.get(id) === p && s.starting.delete(id));
  p.then(clear, clear);
  return p;
}

/** @internal The World's instance of service `id`, or null while it isn't running there. */
export function _worldServiceOf(world: World, id: string): unknown {
  return states.get(world)?.instances.get(id) ?? null;
}

/** @internal What a scene being loaded holds, for deciding which services it needs. */
export interface SceneNeeds {
  readonly path: string;
  readonly settings?: Readonly<Record<string, unknown>>;
  /** The Component type ids in the scene (with its prefabs'); asked only if a service names Components. */
  componentTypes(): Iterable<string>;
}

/** @internal The ids of the registered services `scene` needs in `world`. */
export function _servicesNeededBy(world: World, scene: SceneNeeds): string[] {
  let types: Set<string> | null = null;
  const out: string[] = [];
  for (const { def } of services.values()) {
    if (!runs(def, world)) continue;
    const n = def.neededBy;
    const bySetting = n.sceneSetting !== undefined && Object.keys(n.sceneSetting).length > 0 && Object.entries(n.sceneSetting).every(([k, v]) => scene.settings?.[k] === v);
    const byTag = !!n.worldTags?.some((t) => world.worldTags.includes(t));
    let needed = bySetting || byTag || !!n.scene?.(scene.path);
    const excepted = !!n.exceptSceneSetting && Object.entries(n.exceptSceneSetting).some(([k, vs]) => scene.settings?.[k] !== undefined && vs.includes(scene.settings![k]));
    if (!needed && !excepted && n.components?.length) {
      types ??= new Set(scene.componentTypes());
      needed = n.components.some((c) => types!.has(c));
    }
    if (needed) out.push(def.id);
  }
  return out;
}

/**
 * @internal Scene loading (`SceneManager.load`): start every service the scene needs, before it is
 * instantiated. Rejects if a service fails to load.
 */
export async function _startWorldServicesForScene(world: World, scene: SceneNeeds): Promise<void> {
  if (services.size === 0) return;
  await Promise.all(
    _servicesNeededBy(world, scene).flatMap((id) => {
      const prepare = services.get(id)!.def.prepareScene;
      return prepare ? [_startWorldService(world, id), prepare(world, scene.path)] : [_startWorldService(world, id)];
    }),
  );
}

/** @internal Each rendered frame (`Engine`): the World's running services that interpolate do, in start order. */
export function _interpolateWorldServices(world: World, alpha: number): void {
  const s = states.get(world);
  if (!s) return;
  for (const id of s.order) {
    const def = services.get(id)?.def;
    if (def?.interpolate) def.interpolate(s.instances.get(id), alpha);
  }
}

/** @internal A 3D ray against the first running service that answers ray queries (3D physics); null when none does. */
export function _worldRaycast(world: World, origin: { x: number; y: number; z: number }, dir: { x: number; y: number; z: number }, maxDistance: number): WorldRayHit | null {
  const s = states.get(world);
  if (!s) return null;
  for (const id of s.order) {
    const def = services.get(id)?.def;
    if (def?.raycast) return def.raycast(s.instances.get(id), origin, dir, maxDistance);
  }
  return null;
}

/**
 * @internal The first collider a 3D ray hits that `query` allows, written into `out` (ADR 0162, C14; audio
 * occlusion): excluded nodes and sensors are skipped inside the query, so the first hit is never one of
 * them. `dir` need not be unit length. Allocates nothing; a World with no running 3D physics service
 * (never started by this call), or a 2D one, answers false.
 */
export function raycastInto(world: World, out: WorldRayInto, origin: { x: number; y: number; z: number }, dir: { x: number; y: number; z: number }, maxDistance: number, query: WorldRayQuery): boolean {
  const s = states.get(world);
  if (!s) return false;
  const order = s.order;
  for (let i = 0; i < order.length; i++) {
    const id = order[i];
    const def = services.get(id)?.def;
    if (def?.raycastInto) return def.raycastInto(s.instances.get(id), out, origin, dir, maxDistance, query);
  }
  return false;
}

/**
 * @internal The `WorldRayQuery.groups` mask for colliders on any of `layers` (physics layer names; none:
 * every layer), read from the World's physics settings, so it needs no running service. Compute it when
 * settings change, not per call. Throws on a layer the project doesn't define.
 */
export function rayGroupsFor(world: World, layers?: readonly string[]): number | undefined {
  if (!layers?.length) return undefined;
  const map = layerGroups(world.settings.physics);
  let membership = 0;
  for (const l of layers) {
    const g = map.get(l);
    if (g === undefined) throw new Error(`rayGroupsFor: unknown physics layer "${l}".`);
    membership |= g >>> 16;
  }
  return (0xffff << 16) | membership;
}

/**
 * @internal A Component attached (`World._addComponent`): start the services its type needs that aren't
 * running. Asynchronous while a service loads: the Component starts working once it has.
 */
export function _onComponentAttached(world: World, type: ComponentClass): void {
  if (byComponent.size === 0) return;
  const id = getComponentId(type);
  const needs = id === undefined ? undefined : byComponent.get(id);
  if (!needs) return;
  for (const sid of needs) {
    if (states.get(world)?.instances.has(sid)) continue;
    _startWorldService(world, sid).catch((err: unknown) => console.error(`[myco] World service "${sid}" couldn't load:`, err));
  }
}

/** @internal World teardown (`World._destroyAll`): dispose its services in reverse start order; later loads start nothing. */
export function _disposeWorldServices(world: World): void {
  const s = stateOf(world);
  s.destroyed = true;
  for (const id of s.order.slice().reverse()) {
    const entry = services.get(id);
    const instance = s.instances.get(id);
    if (entry) disposeOne(entry.def, instance);
  }
  s.instances.clear();
  s.order.length = 0;
  live.delete(world);
}

// --- Public: typed keys for optional coupling (ADR 0133, 0135) -----------------------------------------

/** A typed key for a World service, made by `defineWorldService`. */
export interface WorldServiceKey<T> {
  readonly id: string;
  /** Type only: never set. */
  readonly __service?: T;
}

/**
 * A typed key for the World service `id`, for code that uses another plugin's service when it's there:
 *
 * ```ts
 * const Physics3D = defineWorldService<Physics3DService>("myco.physics3d");
 * const physics = worldService(Physics3D); // null when the current World isn't running it
 * ```
 */
export function defineWorldService<T>(id: string): WorldServiceKey<T> {
  return Object.freeze({ id });
}

let worldOfHandle: ((handle: WorldHandle) => World | null) | null = null;
let currentWorld: (() => World | null) | null = null;

/** @internal The World module wires these up, so this file needn't import it (it imports this one). */
export function _setWorldServiceLookup(ofHandle: (handle: WorldHandle) => World | null, current: () => World | null): void {
  worldOfHandle = ofHandle;
  currentWorld = current;
}

/**
 * The service `key` names in a World, or null while that World isn't running it. Without a World,
 * the current one (the World whose frame is running, else the Engine's default World).
 */
export function worldService<T>(key: WorldServiceKey<T>): T | null;
export function worldService<T>(world: WorldHandle | null | undefined, key: WorldServiceKey<T>): T | null;
export function worldService<T>(a: WorldServiceKey<T> | WorldHandle | null | undefined, b?: WorldServiceKey<T>): T | null {
  const key = (b ?? a) as WorldServiceKey<T>;
  let world: World | null;
  if (b === undefined) world = currentWorld?.() ?? null;
  else if (!a) world = currentWorld?.() ?? null;
  else world = isWorld(a) ? a : (worldOfHandle?.(a as WorldHandle) ?? null);
  return world ? ((_worldServiceOf(world, key.id) as T | null) ?? null) : null;
}

const isWorld = (v: unknown): v is World => !!v && typeof v === "object" && "scheduler" in v && "root" in v;

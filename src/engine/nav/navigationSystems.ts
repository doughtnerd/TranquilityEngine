/**
 * Navigation entry points that don't need the WebAssembly module loaded (ADR 0065), like `physics3d.ts` for
 * Rapier: the fixed-step systems, `ensureNavigation` (loads the module and `NavigationWorld` the first time a
 * World needs them), the scene scan `SceneManager.load` uses, and the cache of baked chunk bytes it preloads so
 * NavChunks load synchronously when their scene is instantiated.
 *
 * (Not `navigation.ts`: on case-insensitive file systems that's the facade's `Navigation.ts`.)
 */
import { Vector3, type Vec3Input } from "../core/math";
import { defineBuiltinSystem } from "../core/systems";
import type { World } from "../core/World";
import { Assets, fetchAssetBytes, normalizeAssetPath } from "../scene/Assets";
import { loadSceneFile, type ComponentEntry } from "../scene/SceneLoader";
import type { NavigationWorld } from "./NavigationWorld";

/** Component types that need the World's navigation runtime. */
export const NAV_RUNTIME_TYPES: ReadonlySet<string> = new Set([
  "engine.NavChunk",
  "engine.NavAgent",
  "engine.NavGroup",
  "engine.NavGate",
  "engine.NavCostVolume",
  "engine.NavSurround",
  "engine.NavFlowGoal",
  "engine.NavAvoidanceObstacle",
]);

/** Every component entry of a scene file and the prefabs it instances (overrides' added components too). */
function sceneComponents(path: string, seen = new Set<string>(), out: ComponentEntry[] = []): ComponentEntry[] {
  if (seen.has(path)) return out;
  seen.add(path);
  let file;
  try {
    file = loadSceneFile(path);
  } catch {
    return out;
  }
  for (const n of file.nodes) {
    out.push(...(n.components ?? []));
    for (const o of n.overrides ?? []) if (o.addComponent) out.push(o.addComponent);
    if (n.prefab !== undefined) sceneComponents(n.prefab, seen, out);
  }
  return out;
}

/** @internal True if a scene file (or a prefab it instances) has a navigation component. */
export function usesNavigation(path: string): boolean {
  return sceneComponents(path).some((c) => NAV_RUNTIME_TYPES.has(c.type));
}

/** @internal The bake assets a scene's NavChunks (and its prefabs') reference. */
export function navBakeRefs(path: string): string[] {
  const refs = new Set<string>();
  for (const c of sceneComponents(path)) {
    const bake = c.type === "engine.NavChunk" ? c.data?.bake : undefined;
    if (typeof bake === "string" && bake !== "") refs.add(bake);
  }
  return [...refs];
}

// ------------------------------------------------------------------------------------------- baked chunk bytes

/**
 * Bake bytes by asset reference, with the URL they came from: a rewritten asset gets a new URL (the editor's rebakes),
 * so a rebake isn't served stale and only the latest bytes of each asset are kept.
 */
const bakeBytes = new Map<string, { url: string; bytes: Uint8Array }>();
const bakeLoads = new Map<string, Promise<Uint8Array | null>>();

function bakeUrl(ref: string): string | null {
  try {
    return Assets.has(ref) ? Assets.url(ref) : null;
  } catch {
    return null;
  }
}

/** @internal A bake's bytes if they're loaded, null if not yet, `undefined` if the asset doesn't exist. */
export function navBakeBytesIfLoaded(ref: string): Uint8Array | null | undefined {
  const url = bakeUrl(ref);
  if (url === null) return undefined;
  const cached = bakeBytes.get(normalizeAssetPath(ref));
  return cached?.url === url ? cached.bytes : null;
}

/** @internal Loads a bake's bytes (once per URL); null if the asset is missing or can't be read (reported). */
export function loadNavBake(ref: string): Promise<Uint8Array | null> {
  const url = bakeUrl(ref);
  if (url === null) return Promise.resolve(null);
  const key = normalizeAssetPath(ref);
  const cached = bakeBytes.get(key);
  if (cached?.url === url) return Promise.resolve(cached.bytes);
  let loading = bakeLoads.get(url);
  if (!loading) {
    loading = fetchAssetBytes(url)
      .then((bytes) => {
        if (bakeUrl(ref) === url) bakeBytes.set(key, { url, bytes });
        return bytes;
      })
      .catch((err: unknown) => {
        console.error(`[myco] nav: couldn't load the navigation bake "${ref}":`, err);
        return null;
      })
      .finally(() => bakeLoads.delete(url));
    bakeLoads.set(url, loading);
  }
  return loading;
}

/** @internal Preloads the bakes a scene's NavChunks reference (`SceneManager.load`), so they load synchronously. */
export async function preloadNavBakes(path: string): Promise<void> {
  await Promise.all(navBakeRefs(path).map(loadNavBake));
}

/** @internal Forgets cached bake bytes (tests, the editor after a rebake to the same URL). */
export function clearNavBakeCache(): void {
  bakeBytes.clear();
}

// ------------------------------------------------------------------------------------------- the World's navigation

let loading: Promise<typeof import("./NavigationWorld")> | null = null;

/** @internal Create the World's navigation world, loading the navigation module once. */
export async function ensureNavigation(world: World): Promise<NavigationWorld | null> {
  loading ??= import("./NavigationWorld")
    .then(async (m) => (await m.initNavigationModule(), m))
    .catch((err: unknown) => {
      loading = null; // a failed fetch or WASM start is tried again next time
      throw err;
    });
  const mod = await loading;
  if (!world.navigation && !world._navigationDisposed) world.navigation = new mod.NavigationWorld(world);
  return world.navigation;
}

/**
 * @internal True if the World runs the navigation systems: not an editor World (play mode runs its own Engine), and
 * `engine.NavStep` is among its systems (authoritative Worlds; a client gets agents by replication). Other Worlds
 * never load the runtime or any bake.
 */
export function simulatesNavigation(world: World): boolean {
  return world.kind !== "editor" && world.scheduler.names().includes("engine.NavStep");
}

/**
 * @internal A navigation component attached in a World without navigation: start it (asynchronously; the
 * component begins working at the first fixed step after the module loads), if the World simulates navigation.
 */
export function ensureNavigationFor(world: World): void {
  if (world.navigation || world._navigationDisposed || !simulatesNavigation(world)) return;
  ensureNavigation(world).catch((err: unknown) => console.error("[myco] nav: couldn't load the navigation module:", err));
}

/** @internal A Vec3Input as a tuple. */
export function readVec3(v: Vec3Input): [number, number, number] {
  const p = Vector3.from(v);
  return [p.x, p.y, p.z];
}

// ------------------------------------------------------------------------------------------- debug toggles

/**
 * What `Navigation.debug` asks the debug drawing to show (state only: the debug drawing reads it, through
 * `world.navigation.debug`). The same keys as the debug drawing's `NavDebugFlags`. All off by default.
 */
export interface NavDebugSettings {
  /** Polygon outlines, shared edges and chunk-face edges. */
  navmesh: boolean;
  /** Fold and jump links. */
  links: boolean;
  /** Flight volume leaves. */
  volume: boolean;
  /** Landing links. */
  landing: boolean;
  /** Seams between loaded chunks. */
  seams: boolean;
  /** Agents' current paths. */
  paths: boolean;
  /** Polygons tinted by their runtime cost multiplier (NavCostVolume, ADR 0070). */
  costs: boolean;
}

const debugByWorld = new WeakMap<World, NavDebugSettings>();

/** @internal A World's debug toggles (they exist before its navigation module loads). */
export function navDebugOf(world: World): NavDebugSettings {
  let d = debugByWorld.get(world);
  if (!d) {
    d = { navmesh: false, links: false, volume: false, landing: false, seams: false, paths: false, costs: false };
    debugByWorld.set(world, d);
  }
  return d;
}

// ------------------------------------------------------------------------------------------- systems

/**
 * The fixed-step navigation systems (ADR 0065): after the scripts' fixedUpdate, before both physics pushes, so
 * a kinematic RigidBody agent is moved through its transform like any kinematic body. They run in authoritative
 * Worlds (a server, or a single-player local World); clients get positions by replication. Editor Worlds never
 * simulate (play mode runs its own Engine). Nothing runs in a World without navigation.
 */
const NAV_WORLDS = ["default", "local", "server"];
defineBuiltinSystem({ name: "engine.NavSync", phase: "fixedUpdate", after: ["engine.FixedUpdateScripts"], worlds: NAV_WORLDS, run: (w) => w.navigation?.sync() });
defineBuiltinSystem({ name: "engine.NavStep", phase: "fixedUpdate", after: ["engine.NavSync"], worlds: NAV_WORLDS, run: (w, dt) => w.navigation?.step(dt) });
defineBuiltinSystem({
  name: "engine.NavWriteBack",
  phase: "fixedUpdate",
  after: ["engine.NavStep"],
  before: ["engine.PhysicsPush", "engine.Physics3DPush"],
  worlds: NAV_WORLDS,
  run: (w) => w.navigation?.writeBack(),
});

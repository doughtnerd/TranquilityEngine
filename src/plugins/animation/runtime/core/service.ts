// The `AnimationCore` World service (ADR 0135, 0370): a World starts it the first time it needs animation (a scene with
// an Animator or a TimelineDirector, one attaching, or `startAnimationCore` for a tween), which loads the page's core
// once (`loader.ts`, a dynamic import) and opens the World's namespace in it; World teardown closes the namespace.
// Every World kind runs it: servers for root motion, sockets and notifies, clients and the editor's viewport for poses.
//
// Without `simd128` the World's entry says `unsupported` and holds no namespace, so `animationCoreOf` answers null and
// the stages never run (Animators stay at their bind pose).
import type { World } from "../../../../engine/core/World";
import { _startWorldService, type WorldServiceDef } from "../../../../engine/core/worldServices";
import type { AnimationWorldCore } from "./AnimationWorldCore";
import type { AnimationCoreLoad } from "./loader";

/** @internal The service id. */
export const ANIMATION_CORE_SERVICE_ID = "myco.animation.core";

/** @internal One World's entry. */
export interface AnimationCoreEntry {
  readonly status: "ready" | "unsupported";
  /** The World's namespace; null when unsupported. */
  readonly core: AnimationWorldCore | null;
}

interface Loaded {
  readonly load: AnimationCoreLoad;
  readonly open: (world: World) => AnimationWorldCore | null;
}

/** Each World's namespace while the service runs there. */
const namespaces = new WeakMap<World, AnimationWorldCore>();

/** @internal The service, registered by the core feature (`features/core/register.ts`). */
export const ANIMATION_CORE_SERVICE: WorldServiceDef<Loaded, AnimationCoreEntry> = {
  id: ANIMATION_CORE_SERVICE_ID,
  neededBy: { components: ["engine.Animator", "engine.TimelineDirector"] },
  runsIn: () => true,
  load: async () => {
    const [{ loadAnimationCore }, { AnimationWorldCore }] = await Promise.all([import("./loader"), import("./AnimationWorldCore")]);
    const load = await loadAnimationCore();
    if (load.status !== "ready") return { load, open: () => null };
    const core = load.core;
    return { load, open: (world) => new AnimationWorldCore(world, core) };
  },
  create(world, loaded) {
    const ns = loaded.open(world);
    if (!ns) return { status: "unsupported", core: null };
    namespaces.set(world, ns);
    return { status: "ready", core: ns };
  },
  dispose(entry) {
    if (!entry.core) return;
    if (namespaces.get(entry.core.world) === entry.core) namespaces.delete(entry.core.world);
    entry.core.close();
  },
};

/** @internal `world`'s animation namespace, or null before its core has loaded, without `simd128`, or after teardown. */
export function animationCoreOf(world: World): AnimationWorldCore | null {
  return namespaces.get(world) ?? null;
}

/**
 * @internal Starts the service in `world` if it isn't running (loading the core the first time on the page): what a
 * tween or a timeline created from code calls. Resolves with the namespace, or null when the World doesn't animate
 * (torn down meanwhile, or no `simd128`). Rejects when the module failed to load (the next call tries again).
 */
export async function startAnimationCore(world: World): Promise<AnimationWorldCore | null> {
  const entry = (await _startWorldService(world, ANIMATION_CORE_SERVICE_ID)) as AnimationCoreEntry | null;
  return entry?.core ?? null;
}

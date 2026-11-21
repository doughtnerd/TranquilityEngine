/**
 * The Physics plugin's World services and fixed-step systems (ADR 0135, 0137, 0283), derived from one
 * description per dimension (`dimensions.ts`). A World that needs physics loads the shared sync core and
 * the backend the project chose (`physics.backend2d`, `physics.backend3d`, or the only one registered) in
 * lazy chunks, then runs the core over that backend. With no backend for the dimension the service starts
 * empty: its Components stay inert, and the World warns once.
 */
import type { ComponentClass } from "../../../engine/core/registry";
import { getComponentId } from "../../../engine/core/registry";
import type { BuiltinSystem } from "../../../engine/core/systems";
import type { World } from "../../../engine/core/World";
import type { WorldServiceDef } from "../../../engine/core/worldServices";
import { physicsBackends, selectPhysicsBackend, type PhysicsDimension } from "./backend";

type CoreModule = typeof import("./core/index");

/** What a dimension's service loads: the core and the chosen backend; null when there's no backend. */
export type LoadedPhysics = { readonly core: CoreModule; readonly backend: unknown } | null;

/** What the systems and the World drive in a dimension's physics world. */
export interface PhysicsInstance {
  free(): void;
  interpolate(alpha: number): void;
  restoreInterpolated(): void;
  push(): void;
  step(dt: number): void;
  writeBack(): void;
  dispatchEvents(): void;
}

/** What every part of the plugin reads from a dimension's description. */
export interface PhysicsDimensionInfo {
  readonly dimension: PhysicsDimension;
  /** The World service's id. */
  readonly serviceId: string;
  /**
   * The Components that work in this dimension and need its backend: they start its physics (in a loaded scene not
   * set to another dimension, or attaching later), and the editor notes them when the dimension has no backend.
   */
  readonly components: readonly ComponentClass[];
  /** The fixed-step systems' names: `<stem>RestoreInterpolated`, `<stem>Push`, `<stem>Step`, `<stem>WriteBack`, `<stem>Events`. */
  readonly systemStem: string;
}

/** @internal One physics dimension, described once (ADR 0283). */
export interface PhysicsDimensionDescription<I extends PhysicsInstance> extends PhysicsDimensionInfo {
  create(world: World, core: CoreModule, backend: unknown): I;
  raycast?: WorldServiceDef<LoadedPhysics, I | null>["raycast"];
  raycastInto?: WorldServiceDef<LoadedPhysics, I | null>["raycastInto"];
}

const ALL_SETTINGS: readonly string[] = ["2d", "3d", "none"] satisfies readonly (PhysicsDimension | "none")[];

/** The ids of a dimension's Components. */
export function componentIds(d: PhysicsDimensionInfo): string[] {
  return d.components.map((cls) => {
    const id = getComponentId(cls);
    if (id === undefined) throw new Error(`${d.dimension} physics: ${cls.name || "a class"} isn't a registered Component.`);
    return id;
  });
}

/** @internal A dimension's World service. */
export function physicsWorldService<I extends PhysicsInstance>(d: PhysicsDimensionDescription<I>): WorldServiceDef<LoadedPhysics, I | null> {
  const label = d.dimension.toUpperCase();
  return {
    id: d.serviceId,
    // A scene set to the dimension (ADR 0014) starts it, and so does one saying nothing that has its bodies or colliders (ADR 0045).
    neededBy: { sceneSetting: { physics: d.dimension }, components: componentIds(d), exceptSceneSetting: { physics: ALL_SETTINGS.filter((s) => s !== d.dimension) } },
    variant: (world) => selectPhysicsBackend(world, d.dimension)?.id ?? "",
    load: async (variant) => {
      const reg = variant ? physicsBackends(d.dimension).find((r) => r.id === variant) : undefined;
      if (!reg) return null;
      const [core, backend] = await Promise.all([import("./core/index"), reg.load()]);
      return { core, backend };
    },
    create: (world, loaded) => {
      if (!loaded) {
        console.warn(`[myco] No ${label} physics backend is enabled, so ${label} physics Components do nothing in this World. Enable a backend plugin (Rapier: myco.physics-rapier).`);
        return null;
      }
      return d.create(world, loaded.core, loaded.backend);
    },
    dispose: (p) => p?.free(),
    interpolate: (p, alpha) => p?.interpolate(alpha),
    ...(d.raycast ? { raycast: d.raycast } : {}),
    ...(d.raycastInto ? { raycastInto: d.raycastInto } : {}),
  };
}

/**
 * @internal The fixed-step systems of every dimension, in the order given (ADR 0011: 2D, then 3D): in every World,
 * doing nothing in a World without that dimension's physics world (ADR 0032). Each dimension pushes after
 * fixed-step scripts and after the dimension before it has dispatched its events.
 */
export function physicsSystems(dimensions: readonly PhysicsDimensionInfo[]): BuiltinSystem[] {
  const out: BuiltinSystem[] = [];
  let previousEvents: string | null = null;
  for (const d of dimensions) {
    const of = (w: World) => w.service<PhysicsInstance>(d.serviceId);
    const name = (step: string) => `${d.systemStem}${step}`;
    out.push(
      // Interpolated bodies (ADR 0093) go back to their simulated pose before fixed-step scripts read them.
      { name: name("RestoreInterpolated"), phase: "fixedUpdate", before: ["engine.FixedUpdateScripts"], run: (w) => of(w)?.restoreInterpolated() },
      { name: name("Push"), phase: "fixedUpdate", after: previousEvents ? ["engine.FixedUpdateScripts", previousEvents] : ["engine.FixedUpdateScripts"], run: (w) => of(w)?.push() },
      { name: name("Step"), phase: "fixedUpdate", after: [name("Push")], run: (w, dt) => of(w)?.step(dt) },
      { name: name("WriteBack"), phase: "fixedUpdate", after: [name("Step")], run: (w) => of(w)?.writeBack() },
      { name: name("Events"), phase: "fixedUpdate", after: [name("WriteBack")], run: (w) => of(w)?.dispatchEvents() },
    );
    previousEvents = name("Events");
  }
  return out;
}

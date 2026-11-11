/**
 * The Physics plugin's World services (ADR 0135, 0137), one per dimension, built the same way: a World
 * that needs physics loads the shared sync core and the backend the project chose (`physics.backend2d`,
 * `physics.backend3d`, or the only one registered) in lazy chunks, then runs the core over that backend.
 * With no backend for the dimension the service starts empty: its Components stay inert, and the World
 * warns once.
 */
import type { World } from "../../../engine/core/World";
import type { WorldServiceDef, WorldServiceNeeds } from "../../../engine/core/worldServices";
import { physicsBackends, selectPhysicsBackend, type PhysicsDimension } from "./backend";

type CoreModule = typeof import("./core/index");

/** What a dimension's service loads: the core and the chosen backend; null when there's no backend. */
export type LoadedPhysics = { readonly core: CoreModule; readonly backend: unknown } | null;

interface PhysicsInstance {
  free(): void;
  interpolate(alpha: number): void;
}

/** @internal A dimension's World service. */
export function physicsWorldService<I extends PhysicsInstance>(options: {
  id: string;
  dimension: PhysicsDimension;
  neededBy: WorldServiceNeeds;
  create(world: World, core: CoreModule, backend: unknown): I;
  raycast?: WorldServiceDef<LoadedPhysics, I | null>["raycast"];
  raycastInto?: WorldServiceDef<LoadedPhysics, I | null>["raycastInto"];
}): WorldServiceDef<LoadedPhysics, I | null> {
  const label = options.dimension.toUpperCase();
  return {
    id: options.id,
    neededBy: options.neededBy,
    variant: (world) => selectPhysicsBackend(world, options.dimension)?.id ?? "",
    load: async (variant) => {
      const reg = variant ? physicsBackends(options.dimension).find((r) => r.id === variant) : undefined;
      if (!reg) return null;
      const [core, backend] = await Promise.all([import("./core/index"), reg.load()]);
      return { core, backend };
    },
    create: (world, loaded) => {
      if (!loaded) {
        console.warn(`[myco] No ${label} physics backend is enabled, so ${label} physics Components do nothing in this World. Enable a backend plugin (Rapier: myco.physics-rapier).`);
        return null;
      }
      return options.create(world, loaded.core, loaded.backend);
    },
    dispose: (p) => p?.free(),
    interpolate: (p, alpha) => p?.interpolate(alpha),
    ...(options.raycast ? { raycast: options.raycast } : {}),
    ...(options.raycastInto ? { raycastInto: options.raycastInto } : {}),
  };
}

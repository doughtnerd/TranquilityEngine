// The shared physics sync core (ADR 0137): loaded lazily with a backend by the Physics plugin's World
// services (`systems2d.ts`, `systems3d.ts`), so it costs nothing until a World needs physics.
export { PhysicsWorld2D, wrapAngle } from "./PhysicsWorld2D";
export { PhysicsWorld3D } from "./PhysicsWorld3D";

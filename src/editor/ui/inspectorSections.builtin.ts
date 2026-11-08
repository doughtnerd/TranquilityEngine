// The engine Components' Inspector sections (ADR 0131). Only dynamic imports here: each section's
// module loads the first time a component that has one is inspected (ADR 0083).
import { registerInspectorSection } from "./inspectorSections";

// (The ParticleSystem's section is the Particles plugin's, ADR 0134.)
// A Tilemap's layers are painted in the Tile Palette (ADR 0103).
registerInspectorSection("engine.Tilemap", () => import("./TilemapInspector").then((m) => m.TilemapSection), { single: true });
// An Environment using a procedural sky opens it in the Sky panel (ADR 0112).
registerInspectorSection("engine.Environment", () => import("./EnvironmentInspector").then((m) => m.EnvironmentSection));
// A NavChunk shows its bake plan and bakes from here (ADR 0065).
registerInspectorSection("engine.NavChunk", () => import("./NavComponentInspectors").then((m) => m.NavChunkPlanSection), { rootOnly: true });
registerInspectorSection("engine.NavChunk", () => import("./NavChunkInspector").then((m) => m.NavChunkBakeSection), { rootOnly: true });
registerInspectorSection("engine.ReflectionProbe", () => import("./ReflectionProbeInspector").then((m) => m.ReflectionProbeSection), { rootOnly: true });
// Ports of Foxfire's navigation editors (ADR 0065): notes, the formation preview, the volumes' summaries.
registerInspectorSection("engine.NavAgent", () => import("./NavComponentInspectors").then((m) => m.NavAgentSection), { single: true });
registerInspectorSection("engine.NavAvoidanceObstacle", () => import("./NavComponentInspectors").then((m) => m.NavAvoidanceObstacleSection), { single: true });
registerInspectorSection("engine.NavGroup", () => import("./NavFormationInspector").then((m) => m.NavGroupSection), { rootOnly: true });
registerInspectorSection("engine.NavResolutionVolume", () => import("./NavComponentInspectors").then((m) => m.NavResolutionVolumeSection), { single: true });
registerInspectorSection("engine.NavModifierVolume", () => import("./NavComponentInspectors").then((m) => m.NavModifierVolumeSection), { single: true });
registerInspectorSection("engine.NavCostVolume", () => import("./NavComponentInspectors").then((m) => m.NavCostVolumeSection), { single: true });

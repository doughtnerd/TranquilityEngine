// The engine Components' Inspector sections (ADR 0131). Only dynamic imports here: each section's
// module loads the first time a component that has one is inspected (ADR 0083).
import { registerInspectorSection } from "./inspectorSections";

// (The ParticleSystem's section is the Particles plugin's, the navigation components' are the Navigation plugin's, ADR 0134.)
// A Tilemap's layers are painted in the Tile Palette (ADR 0103).
registerInspectorSection("engine.Tilemap", () => import("./TilemapInspector").then((m) => m.TilemapSection), { single: true });
// An Environment using a procedural sky opens it in the Sky panel (ADR 0112).
registerInspectorSection("engine.Environment", () => import("./EnvironmentInspector").then((m) => m.EnvironmentSection));
registerInspectorSection("engine.ReflectionProbe", () => import("./ReflectionProbeInspector").then((m) => m.ReflectionProbeSection), { rootOnly: true });

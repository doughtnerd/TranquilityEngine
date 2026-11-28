// The engine Components' Inspector sections (ADR 0131). Only dynamic imports here: each section's
// module loads the first time a component that has one is inspected (ADR 0083).
import { inputContextFieldChoices } from "../inputContextChoices";
import { fieldChoices } from "../sdk/contributions";
import { registerInspectorSection } from "./inspectorSections";

// (The ParticleSystem's section is the Particles plugin's, the navigation components' are the Navigation plugin's, ADR 0134; the Tilemap's is the Tilemaps plugin's, ADR 0138.)
// An Environment using a procedural sky opens it in the Sky panel (ADR 0112).
registerInspectorSection("engine.Environment", () => import("./EnvironmentInspector").then((m) => m.EnvironmentSection));
registerInspectorSection("engine.ReflectionProbe", () => import("./ReflectionProbeInspector").then((m) => m.ReflectionProbeSection), { rootOnly: true });
// An LODGroup shows the LOD bar (ADR 0446 §7).
registerInspectorSection("engine.LODGroup", () => import("./lodBar/LodGroupSection").then((m) => m.LodGroupSection), { single: true });
// InputContext.context offers the project's `*.input.json` files and the contexts scripts register (ADR 0336, 0152).
fieldChoices.register(inputContextFieldChoices);

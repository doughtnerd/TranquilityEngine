// First-party plugins' editor halves (ADR 0133). Editor code only: never imported by runtime code
// (the player, the server, the engine). `main.tsx` activates this list before the layout loads.
import type { EditorPlugin } from "../editor/sdk/plugins";
import { audioEditorPlugin } from "./audio/editor";
import { materialsEditorPlugin } from "./materials/editor";
import { navigationEditorPlugin } from "./navigation/editor";
import { physicsEditorPlugin } from "./physics/editor";
import { particlesEditorPlugin } from "./particles/editor";
import { skyEditorPlugin } from "./sky/editor";
import { tilemapsEditorPlugin } from "./tilemaps/editor";
import { meshesEditorPlugin } from "./meshes/editor";
import { environmentEditorPlugin } from "./environment/editor";
import { postProcessingEditorPlugin } from "./post-processing/editor";
import { uiEditorPlugin } from "./ui/editor";

// Particles first: its panel and the Shader Graph both join the Scene view's group, and registering it
// first keeps the default tabs Scene, Shader Graph, Particle Graph. Audio comes before Navigation so the Project
// settings categories read Graphics, Navigation, Audio (both name Graphics; the later one lands next to it).
export const EDITOR_PLUGINS: readonly EditorPlugin[] = [
  particlesEditorPlugin,
  materialsEditorPlugin,
  skyEditorPlugin,
  audioEditorPlugin,
  navigationEditorPlugin,
  tilemapsEditorPlugin,
  physicsEditorPlugin,
  meshesEditorPlugin,
  environmentEditorPlugin,
  postProcessingEditorPlugin,
  uiEditorPlugin,
];

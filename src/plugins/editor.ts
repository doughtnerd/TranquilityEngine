// First-party plugins' editor halves (ADR 0133). Editor code only: never imported by runtime code
// (the player, the server, the engine). `main.tsx` activates this list before the layout loads.
import type { EditorPlugin } from "../editor/sdk/plugins";
import { animationEditorPlugin } from "./animation/editor";
import { audioEditorPlugin } from "./audio/editor";
import type { FirstPartyPlugin } from "./catalogue";
import { decalsEditorPlugin } from "./decals/editor";
import { linesEditorPlugin } from "./lines/editor";
import { materialsEditorPlugin } from "./materials/editor";
import { navigationEditorPlugin } from "./navigation/editor";
import { physicsEditorPlugin } from "./physics/editor";
import { particlesEditorPlugin } from "./particles/editor";
import { skyEditorPlugin } from "./sky/editor";
import { subtitlesEditorPlugin } from "./subtitles/editor";
import { tilemapsEditorPlugin } from "./tilemaps/editor";
import { meshesEditorPlugin } from "./meshes/editor";
import { environmentEditorPlugin } from "./environment/editor";
import { lights2dEditorPlugin } from "./lights2d/editor";
import { postProcessingEditorPlugin } from "./post-processing/editor";
import { ragdollEditorPlugin } from "./ragdoll/editor";
import { uiEditorPlugin } from "./ui/editor";

// Catalogue entries' editor halves (ADR 0275), in registration order. Particles first: its panel and the
// Shader Graph both join the Scene view's group, and registering it first keeps the default tabs Scene,
// Shader Graph, Particle Graph. Audio comes before Navigation so the Project settings categories read
// Graphics, Navigation, Audio (both name Graphics; the later one lands next to it).
const EDITOR_HALVES: { readonly [K in FirstPartyPlugin]?: EditorPlugin } = {
  particles: particlesEditorPlugin,
  materials: materialsEditorPlugin,
  sky: skyEditorPlugin,
  audio: audioEditorPlugin,
  navigation: navigationEditorPlugin,
  tilemaps: tilemapsEditorPlugin,
  physics: physicsEditorPlugin,
  meshes: meshesEditorPlugin,
  environment: environmentEditorPlugin,
  lights2d: lights2dEditorPlugin,
  "post-processing": postProcessingEditorPlugin,
  ui: uiEditorPlugin,
  lines: linesEditorPlugin,
  decals: decalsEditorPlugin,
  subtitles: subtitlesEditorPlugin,
  animation: animationEditorPlugin,
  ragdoll: ragdollEditorPlugin,
};

/** The first-party editor halves, in registration order (panels, settings categories). */
export const EDITOR_PLUGINS: readonly EditorPlugin[] = Object.values(EDITOR_HALVES).filter((p): p is EditorPlugin => p !== undefined);

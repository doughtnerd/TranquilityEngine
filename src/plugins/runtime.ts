// First-party plugins' runtime halves (ADR 0133, 0135). The player, the dedicated server and the editor
// (its World and Play) make this list active through a plugin set (`pluginSet.ts`, ADR 0144) before
// `Engine.create`; nothing here may import from `src/editor/` or a plugin's `editor/` folder.
import { animationRuntimePlugin } from "./animation/runtime";
import { audioRuntimePlugin } from "./audio/runtime";
import { FIRST_PARTY_KEYS, type FirstPartyPlugin } from "./catalogue";
import { decalsRuntimePlugin } from "./decals/runtime";
import { environmentRuntimePlugin } from "./environment/runtime";
import { lights2dRuntimePlugin } from "./lights2d/runtime";
import { linesRuntimePlugin } from "./lines/runtime";
import { materialsRuntimePlugin } from "./materials/runtime";
import { meshesRuntimePlugin } from "./meshes/runtime";
import { navigationRuntimePlugin } from "./navigation/runtime";
import { particlesRuntimePlugin } from "./particles/runtime";
import { physicsRuntimePlugin } from "./physics/runtime";
import { physicsRapierRuntimePlugin } from "./physics-rapier/runtime";
import { createPluginSet, throwOnPluginProblem, type PluginSet, type SetPlugin } from "./pluginSet";
import { postProcessingRuntimePlugin } from "./post-processing/runtime";
import { ragdollRuntimePlugin } from "./ragdoll/runtime";
import { runtimeActivator, type RuntimePlugin } from "./runtimeContext";
import { skyRuntimePlugin } from "./sky/runtime";
import { spritesRuntimePlugin } from "./sprites/runtime";
import { subtitlesRuntimePlugin } from "./subtitles/runtime";
import { tilemapsRuntimePlugin } from "./tilemaps/runtime";
import { uiRuntimePlugin } from "./ui/runtime";
import { waterRuntimePlugin } from "./water/runtime";

// Every catalogue entry's runtime half (ADR 0275): a plugin added to the catalogue without one doesn't compile.
const RUNTIME_HALVES: { readonly [K in FirstPartyPlugin]: RuntimePlugin } = {
  materials: materialsRuntimePlugin,
  sky: skyRuntimePlugin,
  sprites: spritesRuntimePlugin,
  meshes: meshesRuntimePlugin,
  particles: particlesRuntimePlugin,
  physics: physicsRuntimePlugin,
  "physics-rapier": physicsRapierRuntimePlugin,
  navigation: navigationRuntimePlugin,
  tilemaps: tilemapsRuntimePlugin,
  water: waterRuntimePlugin,
  lines: linesRuntimePlugin,
  decals: decalsRuntimePlugin,
  ui: uiRuntimePlugin,
  environment: environmentRuntimePlugin,
  lights2d: lights2dRuntimePlugin,
  "post-processing": postProcessingRuntimePlugin,
  audio: audioRuntimePlugin,
  subtitles: subtitlesRuntimePlugin,
  animation: animationRuntimePlugin,
  ragdoll: ragdollRuntimePlugin,
};

/** The first-party runtime halves in catalogue order, the order render features and systems register in (ADR 0135, 0140). */
export const RUNTIME_PLUGINS: readonly RuntimePlugin[] = FIRST_PARTY_KEYS.map((k) => RUNTIME_HALVES[k]);

export { isRuntimePluginActive, pluginOfComponent, runtimePluginManifest, type RuntimePlugin, type RuntimePluginContext } from "./runtimeContext";

/** The first-party plugins with their runtime halves, as a plugin set takes them (ADR 0144). */
export const firstPartyRuntimePlugins = (): SetPlugin<RuntimePlugin>[] => RUNTIME_PLUGINS.map((p) => ({ manifest: p.manifest, runtime: p }));

/** A plugin set for a host without an editor (the player, the dedicated server, a game on the engine library). */
export const createRuntimePluginSet = (): PluginSet<RuntimePlugin> => createPluginSet<RuntimePlugin>({ runtime: runtimeActivator });

/**
 * The player's, the dedicated server's and a library game's one apply (ADR 0144): the first-party
 * runtime halves plus `thirdParty`'s (ADR 0139), minus the project's `disabled` ones (and, on the
 * server, `server: false` ones). A plugin that doesn't activate stops the game with its message, as a
 * broken script does (ADR 0139).
 */
export function activateGamePlugins(thirdParty: readonly RuntimePlugin[], options: { readonly disabled?: Iterable<string>; readonly server?: boolean } = {}): void {
  const plugins = [...firstPartyRuntimePlugins(), ...thirdParty.map((p) => ({ manifest: p.manifest, runtime: p }))];
  throwOnPluginProblem(createRuntimePluginSet().apply({ plugins, disabled: options.disabled, host: { server: options.server } }));
}

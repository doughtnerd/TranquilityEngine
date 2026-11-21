// The first-party plugin catalogue (ADR 0275): one entry per first-party plugin (ADR 0133), keyed by its
// folder, holding its manifest. Every host plans project code against it (`planPluginCode`, ADR 0139),
// `runtime.ts` maps each entry to its runtime half and `editor.ts` to its editor half, so adding a
// plugin is one entry here. Manifests only, no plugin code: the exporter and the server plan with it.
import { audioManifest } from "./audio/manifest";
import { environmentManifest } from "./environment/manifest";
import { materialsManifest } from "./materials/manifest";
import type { PluginManifest } from "./manifest";
import { meshesManifest } from "./meshes/manifest";
import { navigationManifest } from "./navigation/manifest";
import { particlesManifest } from "./particles/manifest";
import { physicsManifest } from "./physics/manifest";
import { physicsRapierManifest } from "./physics-rapier/manifest";
import { postProcessingManifest } from "./post-processing/manifest";
import { skyManifest } from "./sky/manifest";
import { spritesManifest } from "./sprites/manifest";
import { tilemapsManifest } from "./tilemaps/manifest";
import { uiManifest } from "./ui/manifest";
import { waterManifest } from "./water/manifest";

/**
 * Every first-party plugin by folder. The order is the runtime halves' registration order: render
 * features and systems register in it, and inside a phase their `after` constraints decide (ADR 0135,
 * 0140), so it only breaks ties.
 */
export const FIRST_PARTY = {
  materials: materialsManifest,
  sky: skyManifest,
  sprites: spritesManifest,
  meshes: meshesManifest,
  particles: particlesManifest,
  physics: physicsManifest,
  "physics-rapier": physicsRapierManifest,
  navigation: navigationManifest,
  tilemaps: tilemapsManifest,
  water: waterManifest,
  ui: uiManifest,
  environment: environmentManifest,
  "post-processing": postProcessingManifest,
  audio: audioManifest,
} as const satisfies Readonly<Record<string, PluginManifest>>;

/** A first-party plugin's catalogue key: its folder under `src/plugins/`. */
export type FirstPartyPlugin = keyof typeof FIRST_PARTY;

/** The catalogue's keys, in its order. */
export const FIRST_PARTY_KEYS = Object.keys(FIRST_PARTY) as FirstPartyPlugin[];

/** Every first-party plugin's manifest, in catalogue order. */
export const FIRST_PARTY_MANIFESTS: readonly PluginManifest[] = Object.values(FIRST_PARTY);

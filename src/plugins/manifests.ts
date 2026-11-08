// Every first-party plugin's manifest (ADR 0133), without their code: what game builds check
// third-party plugins' dependencies and `plugins.disabled` against (ADR 0139). A test keeps it in step
// with the plugin folders.
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

export const FIRST_PARTY_MANIFESTS: readonly PluginManifest[] = [
  materialsManifest,
  skyManifest,
  spritesManifest,
  meshesManifest,
  particlesManifest,
  physicsManifest,
  physicsRapierManifest,
  navigationManifest,
  tilemapsManifest,
  waterManifest,
  uiManifest,
  environmentManifest,
  postProcessingManifest,
];

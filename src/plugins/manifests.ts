// Every first-party plugin's manifest (ADR 0133), without their code: what game builds check
// third-party plugins' dependencies and `plugins.disabled` against (ADR 0139). A test keeps it in step
// with the plugin folders.
import { materialsManifest } from "./materials/manifest";
import type { PluginManifest } from "./manifest";
import { navigationManifest } from "./navigation/manifest";
import { particlesManifest } from "./particles/manifest";
import { physicsManifest } from "./physics/manifest";
import { physicsRapierManifest } from "./physics-rapier/manifest";
import { skyManifest } from "./sky/manifest";
import { tilemapsManifest } from "./tilemaps/manifest";

export const FIRST_PARTY_MANIFESTS: readonly PluginManifest[] = [materialsManifest, skyManifest, particlesManifest, physicsManifest, physicsRapierManifest, navigationManifest, tilemapsManifest];

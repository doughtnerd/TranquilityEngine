/**
 * Internal (ADR 0351 §7, §9; A5): the `myco.audioPackages` World service. Every scene a sound-playing runtime World loads
 * waits, before it starts, for the preload packages (the first scene in that World) and for the packages the scene's
 * `AudioPackageLoader`s name (`prepareScene`). The World's teardown drops every package reference it owned. The editor's
 * own World, servers and headless Worlds never run it, so they never load packages.
 */
import type { World } from "../../../../engine/core/World";
import { _startWorldService, _worldServiceIds, type WorldServiceDef } from "../../../../engine/core/worldServices";
import { AUDIO } from "../core/service";
import { resolvedComponents } from "../../../../engine/scene/resolvedScene";
import { worldPlays } from "../AudioSource";
import { preparePackages, releaseWorldPackages } from "./packages";
import { prepareStartLanguage } from "../localisation/languageState";

export const AUDIO_PACKAGES = "myco.audioPackages";

/** The packages the `AudioPackageLoader`s in the scene at `path` (with its prefabs) name. */
function scenePackages(path: string): string[] {
  const out: string[] = [];
  let components: ReturnType<typeof resolvedComponents>;
  try {
    components = resolvedComponents(path);
  } catch {
    return out;
  }
  for (const c of components) {
    if (c.type !== "engine.AudioPackageLoader") continue;
    const list = (c.data as { packages?: unknown } | undefined)?.packages;
    if (Array.isArray(list)) for (const n of list) if (typeof n === "string" && n !== "") out.push(n);
  }
  return out;
}

/** The World's instance: only its World, so the teardown can drop its references. */
interface PackagesService {
  readonly world: World;
}

export const AUDIO_PACKAGES_SERVICE: WorldServiceDef<null, PackagesService> = {
  id: AUDIO_PACKAGES,
  load: async () => null,
  create: (world) => ({ world }),
  dispose: (instance) => releaseWorldPackages(instance.world),
  // Every scene: the first one brings the preload packages.
  neededBy: { scene: () => true },
  runsIn: (world) => world.kind === "runtime" && worldPlays(world),
  // ADR 0354 §4: the start language (the remembered one) is decided before the preload packages load.
  prepareScene: async (world, path) => {
    await prepareStartLanguage();
    // The core starts with the World's audio service (its AudioSources start it, or the audio system's first frame):
    // a scene waiting for packages before either would wait for good, so the packages start it.
    await preparePackages(world, scenePackages(path), () => {
      if (_worldServiceIds().includes(AUDIO)) _startWorldService(world, AUDIO).catch((err: unknown) => console.error(`[myco] World service "${AUDIO}" couldn't load:`, err));
    });
  },
};

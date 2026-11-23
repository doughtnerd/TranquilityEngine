// An image's sub-assets (ADR 0371, 0373 "2D tools"): its slices (`sheet.png#run_0`, a `sprite`) and its flipbooks
// (`sheet.png#Flip/run`, an `animclip`), as the image kind declares them to asset fields (`subAssets`, like a model's
// `#Skeleton` and `#Anim/<name>`). Asset pickers list them under the file; a stored reference resolves through the engine
// (`engine/animation/sprites/flipbook.ts`). The names come from the image's sidecar as the project holds it now.
import { imageSubAssetKinds, imageSubAssets } from "../engine/animation/sprites/flipbook";
import { readImportSettings } from "./assetImport";
import { currentProject } from "./state";

/** What an image sidecar's slices and flipbooks offer a field of `kinds`: slice names for `sprite`, `Flip/<name>` for `animclip`. */
export function imageSubAssetNames(settings: Parameters<typeof imageSubAssets>[0] & { sprites: readonly { name: string }[] }, kinds: readonly string[]): string[] {
  return [...(kinds.includes("sprite") ? settings.sprites.map((s) => s.name) : []), ...(kinds.includes("animclip") ? imageSubAssets(settings) : [])];
}

/** The image kind's `subAssets` (ADR 0371): reads the open project's sidecar for `path`. */
export const IMAGE_SUB_ASSETS = {
  list(path: string, kinds: readonly string[]): readonly string[] {
    const project = currentProject.value;
    return project ? imageSubAssetNames(readImportSettings(project, path).settings, kinds) : [];
  },
  referencedAs: imageSubAssetKinds,
};

/**
 * Cubemap environments on Babylon (ADR 0113): Babylon's prefiltered `.env` and `.dds` cubes, and
 * six-image `*.cubemap.json` assets, which are prefiltered with `HDRFiltering` once they load.
 *
 * A texture counts as ready (`cubemapReady`) only once prefiltered: prefiltering swaps the GPU
 * texture, and a material that bound the old one on WebGPU would keep drawing with it destroyed.
 */
import { CubeTexture } from "@babylonjs/core/Materials/Textures/cubeTexture.js";
import type { BaseTexture } from "@babylonjs/core/Materials/Textures/baseTexture.js";
import { HDRFiltering } from "@babylonjs/core/Materials/Textures/Filtering/hdrFiltering.js";
import type { Scene } from "@babylonjs/core/scene.js";
import { Assets } from "../../../scene/Assets";
import { CUBE_FACES, parseCubemap } from "../../../sky/cubemapFormat";

/** Samples per texel when prefiltering six images (as HDR maps are, Babylon's default is 4096). */
const FACE_PREFILTER_QUALITY = 1024;

const pendingFilter = new WeakSet<BaseTexture>();

/** Whether a cube made by `loadCubemap` is loaded and prefiltered. */
export function cubemapReady(texture: BaseTexture): boolean {
  return texture.isReady() && !pendingFilter.has(texture);
}

/**
 * Load a cube environment: `kind` "cube" for `.env`/`.dds` files (already prefiltered), "faces" for a
 * `*.cubemap.json`. Throws for a cubemap asset that's missing or malformed.
 */
export function loadCubemap(path: string, kind: "cube" | "faces", scene: Scene, onError: (message?: string) => void): BaseTexture {
  if (kind === "cube") {
    const ext = /\.dds$/i.test(path) ? ".dds" : ".env";
    const url = Assets.url(path);
    return ext === ".env"
      ? new CubeTexture(url, scene, { forcedExtension: ".env", prefiltered: true, onError })
      : CubeTexture.CreateFromPrefilteredData(url, scene, ".dds");
  }
  const faces = parseCubemap(Assets.json(path), path);
  const urls = CUBE_FACES.map((f) => Assets.url(faces[f]));
  let texture: CubeTexture | null = null;
  const onLoad = () => {
    const engine = scene.getEngine();
    const features = (engine as unknown as { _features: { allowTexturePrefiltering: boolean } })._features;
    if (!texture || !features.allowTexturePrefiltering) {
      if (texture) pendingFilter.delete(texture);
      return;
    }
    const t = texture;
    new HDRFiltering(engine, { quality: FACE_PREFILTER_QUALITY })
      .prefilter(t)
      .catch((err: unknown) => onError(`prefiltering failed: ${String(err)}`))
      .finally(() => pendingFilter.delete(t));
  };
  texture = new CubeTexture("", scene, { files: urls, onLoad, onError });
  pendingFilter.add(texture);
  return texture;
}

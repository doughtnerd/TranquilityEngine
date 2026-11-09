/**
 * The studio room (studioEnvironment.ts) as a prefiltered cube texture, for a World without an
 * Environment map and for previews (ADR 0043, 0075).
 *
 * Babylon's `prefilterOnLoad` filters with 4096 samples per texel. The room is smooth (grey walls and
 * a few broad soft boxes), so far fewer give the same result, as for a sky bake (BabylonSky.ts): the
 * filter samples the source's mip chain by each sample's footprint. At 4096 the filter cost about
 * 6.5 s of CPU in every editor or game start with software GL (two seconds of wall time on four
 * cores), the largest single cost of opening a project there.
 */
import { HDRFiltering } from "@babylonjs/core/Materials/Textures/Filtering/hdrFiltering.js";
import { HDRCubeTexture } from "@babylonjs/core/Materials/Textures/hdrCubeTexture.js";
import type { InternalTexture } from "@babylonjs/core/Materials/Textures/internalTexture.js";
import type { Scene } from "@babylonjs/core/scene.js";
import "./prefilterGuard";
import { studioHdrUrl } from "./studioEnvironment";

/** Samples per texel when prefiltering the studio room. */
const STUDIO_PREFILTER_QUALITY = 256;

/** The studio cube's face size. */
const STUDIO_SIZE = 128;

/**
 * GPU textures already prefiltered (or being prefiltered): a second studio cube on the same engine
 * shares the first one's from Babylon's texture cache, which must not be filtered twice. Prefiltering
 * swaps the GPU texture inside the same InternalTexture, so the cached object is what's recorded.
 */
const filtered = new WeakSet<InternalTexture>();

class StudioCubeTexture extends HDRCubeTexture {
  /** True from creation until the cube is prefiltered (or prefiltering failed or isn't available). */
  private filtering = true;

  constructor(scene: Scene) {
    let self: StudioCubeTexture | null = null;
    // `onLoad` runs asynchronously (after a file load, or on the next tick for a cached texture), after `self` is set.
    super(studioHdrUrl(), scene, STUDIO_SIZE, false, true, false, false, () => self?.prefilterOnce());
    self = this;
  }

  /** Not ready until prefiltered: prefiltering swaps the GPU texture, and a material that bound the first one on WebGPU would keep drawing with it destroyed. */
  override isReady(): boolean {
    return !this.filtering && super.isReady();
  }

  private prefilterOnce(): void {
    const engine = this._getEngine();
    const internal = this.getInternalTexture();
    const features = (engine as unknown as { _features?: { allowTexturePrefiltering?: boolean } } | null)?._features;
    if (!engine || !internal || !features?.allowTexturePrefiltering || filtered.has(internal)) {
      this.filtering = false;
      return;
    }
    filtered.add(internal);
    const scene = this.getScene();
    const token = {};
    scene?.addPendingData(token); // as Babylon's own prefilterOnLoad: the scene isn't ready until it's done
    new HDRFiltering(engine, { quality: STUDIO_PREFILTER_QUALITY })
      .prefilter(this)
      .catch((err: unknown) => console.warn("[myco] couldn't prefilter the studio environment; reflections use its mipmaps:", err))
      .finally(() => {
        this.filtering = false;
        scene?.removePendingData(token);
      });
  }
}

/** The studio room's prefiltered cube, made in `scene`; `isReady()` once it's prefiltered. */
export function createStudioTexture(scene: Scene): HDRCubeTexture {
  return new StudioCubeTexture(scene);
}

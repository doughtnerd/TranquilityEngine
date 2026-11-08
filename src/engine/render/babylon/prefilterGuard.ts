import { HDRFiltering } from "@babylonjs/core/Materials/Textures/Filtering/hdrFiltering.js";
import type { BaseTexture } from "@babylonjs/core/Materials/Textures/baseTexture.js";

/**
 * Babylon starts an environment cube's prefiltering from its load callback as a floating promise
 * (`void (async () => …)()`), and the filter reads `texture._texture` after awaiting its shader's
 * compilation. A cube disposed in between (a project closed, or a scene torn down, right after the
 * studio room or an environment map began loading) leaves it null, and the promise rejects with
 * "Cannot read properties of null (reading '_irradianceTexture')": an unhandled rejection nothing can
 * catch, for a texture nobody wants any more. Swallow exactly that case; any other failure still throws.
 * Imported for its effect by everything that makes an HDR cube.
 */
const original = HDRFiltering.prototype.prefilter;
if (!(original as { guarded?: boolean }).guarded) {
  const guarded = async function (this: HDRFiltering, texture: BaseTexture): Promise<void> {
    try {
      await original.call(this, texture);
    } catch (err) {
      if (texture.getInternalTexture()) throw err; // still alive: a real failure
    }
  };
  (guarded as { guarded?: boolean }).guarded = true;
  HDRFiltering.prototype.prefilter = guarded;
}

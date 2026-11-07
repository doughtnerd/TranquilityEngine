/**
 * Colour lookup tables for the finish pass on the Babylon backend (ADR 0111). A `.cube` asset is read
 * as text, parsed (`render/lut.ts`) and uploaded as a strip of `size` slices side by side (RGBA8,
 * bilinear); the finish pass blends two slices for the blue axis. Loaded once per path, on first use.
 */
import { Constants } from "@babylonjs/core/Engines/constants.js";
import { RawTexture } from "@babylonjs/core/Materials/Textures/rawTexture.js";
import { Texture } from "@babylonjs/core/Materials/Textures/texture.js";
import type { Scene } from "@babylonjs/core/scene.js";
import { Assets } from "../../scene/Assets";
import { identityLut, lutStripRGBA8, parseCubeLut, type CubeLut } from "../lut";

interface Entry {
  texture: RawTexture | null;
  size: number;
}

/** @internal LUT textures for one Babylon scene. */
export class BabylonLuts {
  private readonly entries = new Map<string, Entry>();
  private neutral: RawTexture | null = null;

  constructor(private readonly scene: Scene) {}

  /** A 2³ identity table, bound when a camera has no LUT (the pass skips it at intensity 0). */
  identity(): RawTexture {
    return (this.neutral ??= this.upload(identityLut(2)));
  }

  /** The texture and table size for a `.cube` path, or null while it loads or when it failed (logged once). */
  get(path: string): { texture: RawTexture; size: number } | null {
    const key = path.replace(/^asset:/, "");
    let e = this.entries.get(key);
    if (!e) {
      const entry: Entry = { texture: null, size: 0 };
      this.entries.set(key, entry);
      e = entry;
      Promise.resolve()
        .then(() => Assets.text(key))
        .then((text) => {
          const lut = parseCubeLut(text, key);
          for (const p of lut.problems) console.warn(`[myco] ${p}`);
          if (this.entries.get(key) !== entry) return;
          entry.texture = this.upload(lut);
          entry.size = lut.size;
        })
        .catch((err) => console.error(`[myco] colour LUT "${key}" couldn't load: ${(err as Error).message}`));
    }
    return e.texture ? { texture: e.texture, size: e.size } : null;
  }

  private upload(lut: CubeLut): RawTexture {
    const { width, height, pixels } = lutStripRGBA8(lut);
    const t = RawTexture.CreateRGBATexture(pixels, width, height, this.scene, false, false, Texture.BILINEAR_SAMPLINGMODE, Constants.TEXTURETYPE_UNSIGNED_BYTE);
    t.wrapU = Texture.CLAMP_ADDRESSMODE;
    t.wrapV = Texture.CLAMP_ADDRESSMODE;
    return t;
  }

  dispose(): void {
    for (const e of this.entries.values()) e.texture?.dispose();
    this.entries.clear();
    this.neutral?.dispose();
    this.neutral = null;
  }
}
